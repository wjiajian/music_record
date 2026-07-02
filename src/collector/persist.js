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

function localDateFromPlayTime(playTime) {
  const n = Number(playTime);
  if (!Number.isFinite(n) || n <= 0) return null;
  const millis = n < 10000000000 ? n * 1000 : n;
  const dt = DateTime.fromMillis(millis, { zone: 'utc' }).setZone(config.tz);
  return dt.isValid ? dt.toISODate() : null;
}

function recentEventCountsForDate(db, playDate) {
  const counts = new Map();
  const events = db.prepare('SELECT song_id, play_time FROM recent_play_event').all();
  for (const event of events) {
    if (localDateFromPlayTime(event.play_time) !== playDate) continue;
    counts.set(event.song_id, (counts.get(event.song_id) || 0) + 1);
  }
  return [...counts.entries()].map(([songId, plays]) => ({ songId, plays }));
}

export function replaceDailyPlayWithRecentEvents(db, playDate) {
  const rows = recentEventCountsForDate(db, playDate);
  if (!rows.length) {
    return { replaced: false, written: 0, skipped: 'no_recent_events' };
  }

  db.prepare('DELETE FROM daily_play WHERE play_date=?').run(playDate);
  const ins = db.prepare(
    `INSERT INTO daily_play(play_date,song_id,plays,span_days,is_estimated,source)
     VALUES(?,?,?,?,?,?)`
  );
  for (const row of rows) {
    ins.run(playDate, row.songId, row.plays, 1, 0, 'recent');
  }
  return { replaced: true, written: rows.length, skipped: null };
}

export function applyRecentPlayEvents(db, dates = null) {
  const targetDates = dates || [
    ...new Set(
      db
        .prepare('SELECT play_time FROM recent_play_event ORDER BY play_time')
        .all()
        .map((event) => localDateFromPlayTime(event.play_time))
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
  const upEvent = db.prepare(
    `INSERT INTO recent_play_event(song_id,play_time,source_type,first_seen_at,last_seen_at)
     VALUES(?,?,?,?,?)
     ON CONFLICT(song_id,play_time,source_type) DO UPDATE SET last_seen_at=excluded.last_seen_at`
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
    if (it.playTime != null) {
      upEvent.run(it.song.id, it.playTime, sourceType ?? '', fetchedAtISO, fetchedAtISO);
    }
  });
  return snapshotId;
}
