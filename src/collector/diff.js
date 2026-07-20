// allData 累计差分：相邻可见快照同歌 playCount 差值写入 daily_play。
// 当前在听的当日数据由 record/recent/song 高频事件计数补齐。
// weekData 只保留原始快照，不再递推日播放，避免把滚动窗口硬拆成单日。
import { previousDay, dayDiff } from '../aggregate/periods.js';

export function computeDailyIncrements(db, snapDate, { attribution = 'prev' } = {}) {
  const attributeDate = attribution === 'same' ? snapDate : previousDay(snapDate);

  const snap = db.prepare('SELECT id FROM snapshot WHERE snapshot_date=?').get(snapDate);
  if (!snap) throw new Error(`快照不存在: ${snapDate}`);

  // 幂等：只清掉当前由 allData 占优的旧增量。recent 占优的行保留，随后与新差分取大值。
  db.prepare("DELETE FROM daily_play WHERE play_date=? AND source='all'").run(attributeDate);

  const stats = {
    attributeDate,
    baseline: false,
    written: 0,
    newSongs: 0,
    estimated: 0,
    skipped: 0,
    weekWritten: 0,
    weekEstimated: 0,
    weekSkipped: 0,
    weekBaseline: 0,
    coListed: 0,
    weekIgnored: 0,
  };

  const prevSnap = db
    .prepare('SELECT snapshot_date FROM snapshot WHERE snapshot_date < ? ORDER BY snapshot_date DESC LIMIT 1')
    .get(snapDate);
  if (!prevSnap) {
    stats.baseline = true; // 全库第一张快照 → 仅基线，无可差分
    return stats;
  }

  const insStmt = db.prepare(
    `INSERT INTO daily_play(play_date,song_id,plays,span_days,is_estimated,source)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(play_date,song_id) DO UPDATE SET
       plays=excluded.plays,
       span_days=excluded.span_days,
       is_estimated=excluded.is_estimated,
       source=excluded.source
     WHERE excluded.plays >= daily_play.plays`
  );

  // ---------- allData 累计差分（source='all'）----------
  const curAll = db.prepare('SELECT song_id, play_count FROM snapshot_item WHERE snapshot_id=?').all(snap.id);
  const lastSeenAll = db.prepare(
    `SELECT si.play_count AS pc, s.snapshot_date AS date
     FROM snapshot_item si JOIN snapshot s ON s.id = si.snapshot_id
     WHERE si.song_id = ? AND s.snapshot_date < ?
     ORDER BY s.snapshot_date DESC LIMIT 1`
  );
  for (const cur of curAll) {
    const last = lastSeenAll.get(cur.song_id, snapDate);
    if (!last) {
      stats.newSongs++; // 全历史首见 → 记 0（避免「早就在听今天才进榜」的假尖峰）
      continue;
    }
    const delta = cur.play_count - last.pc;
    if (delta <= 0) {
      stats.skipped++; // 负增量/无新增 → clamp 跳过
      continue;
    }
    const span = dayDiff(snapDate, last.date);
    const isEst = span > 1 ? 1 : 0; // 漏抓/截断重入 → 标记不确定
    insStmt.run(attributeDate, cur.song_id, delta, span, isEst, 'all');
    stats.written++;
    if (isEst) stats.estimated++;
  }

  // 监控：同时出现在 allData 与 weekData 的歌数；weekData 不再写 daily_play。
  stats.weekIgnored = db
    .prepare(
      `SELECT COUNT(*) n FROM snapshot_week_item
       WHERE snapshot_id = ?
         AND song_id NOT IN (SELECT song_id FROM snapshot_item WHERE snapshot_id = ?)`
    )
    .get(snap.id, snap.id).n;
  stats.coListed = db
    .prepare(
      `SELECT COUNT(*) n FROM snapshot_week_item
       WHERE snapshot_id = ? AND song_id IN (SELECT song_id FROM snapshot_item WHERE snapshot_id = ?)`
    )
    .get(snap.id, snap.id).n;

  return stats;
}
