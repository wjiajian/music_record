// 每日 cron 入口：抓快照、算增量、写 collection_log。
import { getDb, initSchema } from '../db/index.js';
import { fetchSnapshot } from './fetchSnapshot.js';
import { collectRealtimePlayback } from './realtime.js';
import { requireUid, config } from '../config.js';

async function main() {
  const uid = requireUid();
  const db = initSchema(getDb());
  const runAt = new Date().toISOString();
  const logStmt = db.prepare(
    'INSERT INTO collection_log(run_at,kind,status,detail) VALUES(?,?,?,?)'
  );
  try {
    const r = await fetchSnapshot(db, { uid, attribution: config.attribution });
    const realtime = await collectRealtimePlayback(db, {});
    logStmt.run(runAt, 'collect', realtime.status === 'fail' ? 'partial' : 'ok', JSON.stringify({ diff: r.diff, realtime }));
    const today = realtime.today?.status === 'ok'
      ? `；今日足迹 ${realtime.today.itemCount} 首`
      : `；今日足迹失败 ${realtime.today?.message || 'unknown'}`;
    const recent = realtime.recent?.status === 'ok'
      ? `；最近播放 ${realtime.recent.itemCount} 条 → daily_play ${realtime.recent.daily.written} 行`
      : `；最近播放失败 ${realtime.recent?.message || 'unknown'}`;
    console.log(
      `[collect] ${r.snapDate} ok：allData ${r.itemCount} 首 / weekData ${r.weekCount} 首；` +
        `增量 all ${r.diff.written} 行 + week ${r.diff.weekWritten} 行` +
        `（估算 ${r.diff.estimated + r.diff.weekEstimated}，两榜重叠 ${r.diff.coListed}，归属日 ${r.diff.attributeDate}` +
        `${r.diff.baseline ? '，首张基线' : ''}）` +
        today +
        recent
    );
  } catch (e) {
    logStmt.run(runAt, 'collect', 'fail', String(e?.message || e));
    console.error('[collect] 失败：', e?.message || e);
    process.exitCode = 1;
  }
}

main();
