// 维度 upsert + 快照落库（幂等）。
import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { config } from '../config.js';

// 把一批记录项里的 album/artist/song/song_artist upsert 进维度表。
// first_seen 只在首次插入时落定（ON CONFLICT 不覆盖），last_seen 每次刷新。
export function upsertDimensions(db, snapDate, items) {
  const upAlbum = db.prepare(
    `INSERT INTO album(id,name,pic_url) VALUES(?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=COALESCE(excluded.name, album.name),
       pic_url=COALESCE(excluded.pic_url, album.pic_url)`
  );
  const upArtist = db.prepare(
    `INSERT INTO artist(id,name) VALUES(?,?)
     ON CONFLICT(id) DO UPDATE SET name=COALESCE(excluded.name, artist.name)`
  );
  const upSong = db.prepare(
    `INSERT INTO song(id,name,duration_ms,album_id,first_seen,last_seen,raw_json)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=COALESCE(excluded.name, song.name),
       duration_ms=COALESCE(excluded.duration_ms, song.duration_ms),
       album_id=COALESCE(excluded.album_id, song.album_id),
       last_seen=excluded.last_seen, raw_json=excluded.raw_json`
  );
  const upSongArtist = db.prepare(
    `INSERT INTO song_artist(song_id,artist_id,position) VALUES(?,?,?)
     ON CONFLICT(song_id,artist_id) DO UPDATE SET position=excluded.position`
  );

  for (const it of items) {
    const s = it.song;
    if (s.album && s.album.id != null) {
      upAlbum.run(s.album.id, s.album.name ?? null, s.album.picUrl ?? null);
    }
    upSong.run(
      s.id,
      s.name ?? null,
      s.durationMs ?? null,
      s.album?.id ?? null,
      snapDate,
      snapDate,
      JSON.stringify(s.raw ?? {})
    );
    s.artists.forEach((a, i) => {
      if (a.id == null) return;
      upArtist.run(a.id, a.name ?? null);
      upSongArtist.run(s.id, a.id, i);
    });
  }
}

// 保存某日快照（含 snapshot_item）。同日重跑则覆盖 → 幂等。
export function saveSnapshot(db, snapDate, fetchedAtISO, items, rawJsonString) {
  const sha = crypto.createHash('sha256').update(rawJsonString).digest('hex');
  const existing = db.prepare('SELECT id FROM snapshot WHERE snapshot_date=?').get(snapDate);
  let snapshotId;
  if (existing) {
    snapshotId = existing.id;
    db.prepare(
      'UPDATE snapshot SET fetched_at=?, item_count=?, raw_sha256=?, status=? WHERE id=?'
    ).run(fetchedAtISO, items.length, sha, 'ok', snapshotId);
    db.prepare('DELETE FROM snapshot_item WHERE snapshot_id=?').run(snapshotId);
  } else {
    const r = db
      .prepare('INSERT INTO snapshot(snapshot_date,fetched_at,item_count,raw_sha256,status) VALUES(?,?,?,?,?)')
      .run(snapDate, fetchedAtISO, items.length, sha, 'ok');
    snapshotId = Number(r.lastInsertRowid);
  }
  const insItem = db.prepare(
    'INSERT INTO snapshot_item(snapshot_id,song_id,play_count,score,rank) VALUES(?,?,?,?,?)'
  );
  for (const it of items) {
    insItem.run(snapshotId, it.song.id, it.playCount, it.score ?? null, it.rank ?? null);
  }
  return snapshotId;
}

// 保存某日的 weekData（最近 7 天滚动播放数）。复用同一 snapshot 行，幂等覆盖。
export function saveWeekSnapshot(db, snapDate, weekItems) {
  const snap = db.prepare('SELECT id FROM snapshot WHERE snapshot_date=?').get(snapDate);
  if (!snap) throw new Error(`快照不存在: ${snapDate}（saveWeekSnapshot 须在 saveSnapshot 之后）`);
  db.prepare('DELETE FROM snapshot_week_item WHERE snapshot_id=?').run(snap.id);
  const ins = db.prepare(
    'INSERT INTO snapshot_week_item(snapshot_id,song_id,play_count,rank) VALUES(?,?,?,?)'
  );
  for (const it of weekItems) ins.run(snap.id, it.song.id, it.playCount, it.rank ?? null);
  return snap.id;
}

export function saveTodayListenSnapshot(db, listenDate, fetchedAtISO, items, rawJsonString, { rawCode = null } = {}) {
  const sha = crypto.createHash('sha256').update(rawJsonString || '').digest('hex');
  const r = db
    .prepare(
      `INSERT INTO today_listen_snapshot(listen_date,fetched_at,item_count,raw_sha256,raw_code,status)
       VALUES(?,?,?,?,?,?)`
    )
    .run(listenDate, fetchedAtISO, items.length, sha, rawCode, 'ok');
  const snapshotId = Number(r.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO today_listen_item(snapshot_id,song_id,play_count,rank,listen_time)
     VALUES(?,?,?,?,?)`
  );
  for (const it of items) {
    ins.run(snapshotId, it.song.id, it.playCount ?? null, it.rank ?? null, it.listenTime ?? null);
  }
  return snapshotId;
}

export function localDateFromPlayTime(playTime) {
  const n = Number(playTime);
  if (!Number.isFinite(n) || n <= 0) return null;
  const millis = n < 10000000000 ? n * 1000 : n;
  const dt = DateTime.fromMillis(millis, { zone: config.tz });
  return dt.isValid ? dt.toISODate() : null;
}

export function recentPlayDates(items) {
  return [
    ...new Set(
      (items || [])
        .map((item) => localDateFromPlayTime(item.playTime))
        .filter(Boolean)
    ),
  ];
}

// 高频 recent 计数：同一首歌每个不同 play_time 计一次。与 allData 差分冲突时按
// 每首歌每天取较大值；recent 只会补高，不会把 allData 已知次数调低。
export function replaceDailyPlayWithRecentEvents(db, playDate) {
  const counts = db
    .prepare(
      `SELECT song_id, COUNT(*) AS plays
       FROM recent_play_event
       WHERE play_date = ?
       GROUP BY song_id`
    )
    .all(playDate);
  if (!counts.length) {
    return { replaced: false, written: 0, skipped: 'no_recent_events' };
  }

  db.prepare("DELETE FROM daily_play WHERE play_date=? AND source='recent'").run(playDate);
  const ins = db.prepare(
    `INSERT INTO daily_play(play_date,song_id,plays,span_days,is_estimated,source)
     VALUES(?,?,?,1,0,'recent')
     ON CONFLICT(play_date,song_id) DO UPDATE SET
       plays=excluded.plays,
       span_days=1,
       is_estimated=0,
       source='recent'
     WHERE excluded.plays > daily_play.plays`
  );
  let written = 0;
  for (const item of counts) {
    const r = ins.run(playDate, item.song_id, item.plays);
    written += Number(r.changes) || 0;
  }
  return { replaced: true, written, skipped: null };
}

export function applyRecentPlayEvents(db, dates = null) {
  const targetDates = dates || [
    ...new Set(
      db
        .prepare('SELECT play_date, play_time FROM recent_play_event ORDER BY play_time')
        .all()
        .map((event) => event.play_date || localDateFromPlayTime(event.play_time))
        .filter(Boolean)
    ),
  ];
  let written = 0;
  let replaced = 0;
  for (const date of targetDates) {
    const r = replaceDailyPlayWithRecentEvents(db, date);
    written += r.written;
    if (r.replaced) replaced++;
  }
  return { dates: targetDates.length, replaced, written };
}

// 只落唯一播放事件，不保存每分钟完整 300 条快照，避免高频轮询导致数据库膨胀。
export function saveRecentPlayEvents(db, fetchedAtISO, items) {
  const ins = db.prepare(
    `INSERT INTO recent_play_event(song_id,play_time,play_date,source_type,first_seen_at,last_seen_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(song_id,play_time,source_type) DO NOTHING`
  );
  const touch = db.prepare(
    `UPDATE recent_play_event SET last_seen_at=?, play_date=COALESCE(play_date,?)
     WHERE song_id=? AND play_time=? AND source_type=?`
  );
  let inserted = 0;
  for (const item of items || []) {
    if (item.playTime == null) continue;
    const sourceType = item.sourceType == null ? '' : String(item.sourceType);
    const playDate = localDateFromPlayTime(item.playTime);
    if (!playDate) continue;
    const result = ins.run(
      item.song.id,
      item.playTime,
      playDate,
      sourceType,
      fetchedAtISO,
      fetchedAtISO
    );
    if (Number(result.changes)) inserted += 1;
    else touch.run(fetchedAtISO, playDate, item.song.id, item.playTime, sourceType);
  }
  return { inserted, dates: recentPlayDates(items) };
}

export function saveRecentPlaySnapshot(db, fetchedAtISO, items, rawJsonString, { rawCode = null } = {}) {
  const sha = crypto.createHash('sha256').update(rawJsonString || '').digest('hex');
  const r = db
    .prepare(
      `INSERT INTO recent_play_snapshot(fetched_at,item_count,raw_sha256,raw_code,status)
       VALUES(?,?,?,?,?)`
    )
    .run(fetchedAtISO, items.length, sha, rawCode, 'ok');
  const snapshotId = Number(r.lastInsertRowid);
  const insItem = db.prepare(
    `INSERT INTO recent_play_item(snapshot_id,position,song_id,play_time,play_count,rank,source_type)
     VALUES(?,?,?,?,?,?,?)`
  );
  items.forEach((it, index) => {
    const sourceType = it.sourceType == null ? null : String(it.sourceType);
    insItem.run(
      snapshotId,
      index + 1,
      it.song.id,
      it.playTime ?? null,
      it.playCount ?? null,
      it.rank ?? null,
      sourceType
    );
  });
  saveRecentPlayEvents(db, fetchedAtISO, items);
  return snapshotId;
}

function metaValue(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;
}

function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta(key,value) VALUES(?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, String(value));
}

// 成功轮询：更新水位、闭合失败 gap，并在首次启动时把次日标为首个完整自然日。
export function markCounterPollSuccess(db, fetchedAtISO, intervalMs = config.realtime.intervalMs) {
  const previous = metaValue(db, 'counter_last_success_at');
  const openGap = db
    .prepare('SELECT id FROM counter_poll_gap WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1')
    .get();
  if (openGap) {
    db.prepare('UPDATE counter_poll_gap SET ended_at=? WHERE id=?').run(fetchedAtISO, openGap.id);
  } else if (previous) {
    const elapsed = Date.parse(fetchedAtISO) - Date.parse(previous);
    if (Number.isFinite(elapsed) && elapsed > intervalMs * 3) {
      db.prepare(
        'INSERT INTO counter_poll_gap(started_at,ended_at,reason) VALUES(?,?,?)'
      ).run(previous, fetchedAtISO, 'poll_delay');
    }
  }

  if (!metaValue(db, 'counter_started_at')) {
    const local = DateTime.fromISO(fetchedAtISO, { setZone: true }).setZone(config.tz);
    setMeta(db, 'counter_started_at', fetchedAtISO);
    setMeta(db, 'counter_complete_from', local.plus({ days: 1 }).startOf('day').toISODate());
  }
  setMeta(db, 'counter_last_success_at', fetchedAtISO);
  db.prepare("DELETE FROM meta WHERE key='counter_last_error'").run();
}

export function markCounterPollFailure(db, failedAtISO, error) {
  const open = db
    .prepare('SELECT id FROM counter_poll_gap WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1')
    .get();
  if (!open) {
    db.prepare(
      'INSERT INTO counter_poll_gap(started_at,ended_at,reason) VALUES(?,NULL,?)'
    ).run(failedAtISO, error?.message || String(error));
  }
  setMeta(db, 'counter_last_error', error?.message || String(error));
}
