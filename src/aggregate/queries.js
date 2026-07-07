// 所有聚合查询。统一在 daily_play 上按 [start,end] 区间 GROUP BY。
// SQL 只接收 periods.js 算好的日期串；ISO 周/时区运算不在 SQL 里做。

const ORDER_COL = { plays: 'plays', duration: 'est_ms' }; // 排序列白名单（防注入）

function orderCol(metric) {
  return ORDER_COL[metric] || 'plays';
}

function songDetails(db, rows, offset) {
  const arStmt = db.prepare(
    `SELECT a.id, a.name FROM song_artist sa JOIN artist a ON a.id = sa.artist_id
     WHERE sa.song_id = ? ORDER BY sa.position`
  );
  const alStmt = db.prepare(
    `SELECT al.id, al.name, al.pic_url AS picUrl
     FROM song s LEFT JOIN album al ON al.id = s.album_id WHERE s.id = ?`
  );
  return rows.map((r, i) => ({
    rank: offset + i + 1,
    id: r.id,
    name: r.name,
    plays: r.plays,
    est_minutes: Math.round((r.est_ms || 0) / 60000),
    artists: arStmt.all(r.id),
    album: alStmt.get(r.id) || null,
  }));
}

// ---- 排行 ----------------------------------------------------------

export function rankingSongs(db, start, end, metric, limit, offset) {
  const rows = db
    .prepare(
      `SELECT dp.song_id AS id, s.name AS name,
              SUM(dp.plays) AS plays,
              SUM(dp.plays * COALESCE(s.duration_ms,0)) AS est_ms
       FROM daily_play dp JOIN song s ON s.id = dp.song_id
       WHERE dp.play_date BETWEEN ? AND ?
       GROUP BY dp.song_id
       ORDER BY ${orderCol(metric)} DESC, plays DESC
       LIMIT ? OFFSET ?`
    )
    .all(start, end, limit, offset);

  return songDetails(db, rows, offset);
}

export function latestSnapshotId(db) {
  return db.prepare('SELECT id, snapshot_date FROM snapshot ORDER BY snapshot_date DESC LIMIT 1').get() || null;
}

export function previousSnapshotId(db, snapshotId) {
  return (
    db
      .prepare(
        `SELECT id, snapshot_date FROM snapshot
         WHERE snapshot_date < (SELECT snapshot_date FROM snapshot WHERE id = ?)
         ORDER BY snapshot_date DESC LIMIT 1`
      )
      .get(snapshotId) || null
  );
}

export function rankingSongsFromAllSnapshot(db, snapshotId, metric, limit, offset) {
  const rows = db
    .prepare(
      `SELECT si.song_id AS id, s.name AS name,
              si.play_count AS plays,
              si.play_count * COALESCE(s.duration_ms,0) AS est_ms
       FROM snapshot_item si JOIN song s ON s.id = si.song_id
       WHERE si.snapshot_id = ?
       ORDER BY ${orderCol(metric)} DESC, plays DESC
       LIMIT ? OFFSET ?`
    )
    .all(snapshotId, limit, offset);
  return songDetails(db, rows, offset);
}

export function rankingSongsFromWeekSnapshot(db, snapshotId, metric, limit, offset) {
  const rows = db
    .prepare(
      `SELECT wi.song_id AS id, s.name AS name,
              wi.play_count AS plays,
              wi.play_count * COALESCE(s.duration_ms,0) AS est_ms
       FROM snapshot_week_item wi JOIN song s ON s.id = wi.song_id
       WHERE wi.snapshot_id = ?
       ORDER BY ${orderCol(metric)} DESC, plays DESC
       LIMIT ? OFFSET ?`
    )
    .all(snapshotId, limit, offset);
  return songDetails(db, rows, offset);
}

export function rankingSongsFromWeekSnapshotDelta(db, snapshotId, prevSnapshotId, metric, limit, offset) {
  if (!prevSnapshotId) return [];
  const rows = db
    .prepare(
      `WITH delta AS (
         SELECT c.song_id AS song_id,
                c.play_count - COALESCE(p.play_count, 0) AS plays
         FROM snapshot_week_item c
         LEFT JOIN snapshot_week_item p ON p.snapshot_id = ? AND p.song_id = c.song_id
         WHERE c.snapshot_id = ? AND c.play_count > COALESCE(p.play_count, 0)
       )
       SELECT d.song_id AS id, s.name AS name,
              d.plays AS plays,
              d.plays * COALESCE(s.duration_ms,0) AS est_ms
       FROM delta d JOIN song s ON s.id = d.song_id
       ORDER BY ${orderCol(metric)} DESC, plays DESC
       LIMIT ? OFFSET ?`
    )
    .all(prevSnapshotId, snapshotId, limit, offset);
  return songDetails(db, rows, offset);
}

export function countSnapshotSongs(db, table, snapshotId) {
  const source = table === 'snapshot_week_item' ? 'snapshot_week_item' : 'snapshot_item';
  return db.prepare(`SELECT COUNT(*) AS n FROM ${source} WHERE snapshot_id = ?`).get(snapshotId).n;
}

export function countWeekSnapshotDeltaSongs(db, snapshotId, prevSnapshotId) {
  if (!prevSnapshotId) return 0;
  return db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM snapshot_week_item c
       LEFT JOIN snapshot_week_item p ON p.snapshot_id = ? AND p.song_id = c.song_id
       WHERE c.snapshot_id = ? AND c.play_count > COALESCE(p.play_count, 0)`
    )
    .get(prevSnapshotId, snapshotId).n;
}

export function rankingArtists(db, start, end, metric, limit, offset) {
  const rows = db
    .prepare(
      `SELECT ar.id AS id, ar.name AS name,
              SUM(dp.plays) AS plays,
              SUM(dp.plays * COALESCE(s.duration_ms,0)) AS est_ms
       FROM daily_play dp
       JOIN song s ON s.id = dp.song_id
       JOIN song_artist sa ON sa.song_id = s.id
       JOIN artist ar ON ar.id = sa.artist_id
       WHERE dp.play_date BETWEEN ? AND ?
       GROUP BY ar.id
       ORDER BY ${orderCol(metric)} DESC, plays DESC
       LIMIT ? OFFSET ?`
    )
    .all(start, end, limit, offset);
  return rows.map((r, i) => ({
    rank: offset + i + 1,
    id: r.id,
    name: r.name,
    plays: r.plays,
    est_minutes: Math.round((r.est_ms || 0) / 60000),
  }));
}

export function rankingAlbums(db, start, end, metric, limit, offset) {
  const rows = db
    .prepare(
      `SELECT al.id AS id, al.name AS name, al.pic_url AS picUrl,
              SUM(dp.plays) AS plays,
              SUM(dp.plays * COALESCE(s.duration_ms,0)) AS est_ms
       FROM daily_play dp
       JOIN song s ON s.id = dp.song_id
       JOIN album al ON al.id = s.album_id
       WHERE dp.play_date BETWEEN ? AND ?
       GROUP BY al.id
       ORDER BY ${orderCol(metric)} DESC, plays DESC
       LIMIT ? OFFSET ?`
    )
    .all(start, end, limit, offset);
  return rows.map((r, i) => ({
    rank: offset + i + 1,
    id: r.id,
    name: r.name,
    picUrl: r.picUrl,
    plays: r.plays,
    est_minutes: Math.round((r.est_ms || 0) / 60000),
  }));
}

export function countDimension(db, dimension, start, end) {
  if (dimension === 'artist') {
    return db
      .prepare(
        `SELECT COUNT(DISTINCT sa.artist_id) AS n
         FROM daily_play dp JOIN song_artist sa ON sa.song_id = dp.song_id
         WHERE dp.play_date BETWEEN ? AND ?`
      )
      .get(start, end).n;
  }
  if (dimension === 'album') {
    return db
      .prepare(
        `SELECT COUNT(DISTINCT s.album_id) AS n
         FROM daily_play dp JOIN song s ON s.id = dp.song_id
         WHERE dp.play_date BETWEEN ? AND ? AND s.album_id IS NOT NULL`
      )
      .get(start, end).n;
  }
  return db
    .prepare('SELECT COUNT(DISTINCT song_id) AS n FROM daily_play WHERE play_date BETWEEN ? AND ?')
    .get(start, end).n;
}

// ---- 趋势 / 日历（每日总量，支持实体过滤）-------------------------

export function dailyTotals(db, start, end, opts = {}) {
  const { excludeEstimated = false, songId, artistId, albumId } = opts;
  let join = 'JOIN song s ON s.id = dp.song_id';
  const where = ['dp.play_date BETWEEN ? AND ?'];
  const params = [start, end];
  if (excludeEstimated) where.push('dp.is_estimated = 0');
  if (songId != null) {
    where.push('dp.song_id = ?');
    params.push(songId);
  }
  if (albumId != null) {
    where.push('s.album_id = ?');
    params.push(albumId);
  }
  if (artistId != null) {
    join += ' JOIN song_artist sa ON sa.song_id = dp.song_id';
    where.push('sa.artist_id = ?');
    params.push(artistId);
  }
  return db
    .prepare(
      `SELECT dp.play_date AS date,
              SUM(dp.plays) AS plays,
              SUM(dp.plays * COALESCE(s.duration_ms,0)) AS est_ms,
              MAX(dp.is_estimated) AS estimated
       FROM daily_play dp ${join}
       WHERE ${where.join(' AND ')}
       GROUP BY dp.play_date ORDER BY dp.play_date`
    )
    .all(...params);
}

export function dailyTopSongs(db, start, end, limitPerDay = 24) {
  const rows = db
    .prepare(
      `WITH ranked AS (
         SELECT dp.play_date AS date,
                dp.song_id AS song_id,
                s.name AS song_name,
                al.id AS album_id,
                al.name AS album_name,
                al.pic_url AS pic_url,
                SUM(dp.plays) AS plays,
                SUM(dp.plays * COALESCE(s.duration_ms,0)) AS est_ms,
                ROW_NUMBER() OVER (
                  PARTITION BY dp.play_date
                  ORDER BY SUM(dp.plays) DESC,
                           SUM(dp.plays * COALESCE(s.duration_ms,0)) DESC,
                           dp.song_id
                ) AS rn
         FROM daily_play dp
         JOIN song s ON s.id = dp.song_id
         LEFT JOIN album al ON al.id = s.album_id
         WHERE dp.play_date BETWEEN ? AND ?
         GROUP BY dp.play_date, dp.song_id
       )
       SELECT date, song_id, song_name, album_id, album_name, pic_url, plays, est_ms, rn
       FROM ranked
       WHERE rn <= ?
       ORDER BY date DESC, rn`
    )
    .all(start, end, limitPerDay);

  const arStmt = db.prepare(
    `SELECT a.id, a.name FROM song_artist sa JOIN artist a ON a.id = sa.artist_id
     WHERE sa.song_id = ? ORDER BY sa.position`
  );
  return rows.map((r) => ({
    date: r.date,
    rank: r.rn,
    plays: r.plays,
    est_minutes: Math.round((r.est_ms || 0) / 60000),
    song: {
      id: r.song_id,
      name: r.song_name,
      artists: arStmt.all(r.song_id),
      album: r.album_id == null ? null : { id: r.album_id, name: r.album_name, picUrl: r.pic_url },
    },
  }));
}

// ---- 概览 / 健康 ---------------------------------------------------

export function totals(db, start, end) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(dp.plays),0) AS plays,
              COALESCE(SUM(dp.plays * COALESCE(s.duration_ms,0)),0) AS est_ms,
              COUNT(DISTINCT dp.song_id) AS songs
       FROM daily_play dp JOIN song s ON s.id = dp.song_id
       WHERE dp.play_date BETWEEN ? AND ?`
    )
    .get(start, end);
}

export function estimatedPlaysInRange(db, start, end) {
  return db
    .prepare(
      'SELECT COALESCE(SUM(plays),0) AS n FROM daily_play WHERE play_date BETWEEN ? AND ? AND is_estimated=1'
    )
    .get(start, end).n;
}

export function allSnapshotDates(db) {
  return db
    .prepare('SELECT snapshot_date FROM snapshot ORDER BY snapshot_date')
    .all()
    .map((r) => r.snapshot_date);
}

export function snapshotDatesInRange(db, start, end) {
  return db
    .prepare('SELECT snapshot_date FROM snapshot WHERE snapshot_date BETWEEN ? AND ? ORDER BY snapshot_date')
    .all(start, end)
    .map((r) => r.snapshot_date);
}

export function distinctPlayDates(db) {
  return db.prepare('SELECT COUNT(DISTINCT play_date) AS n FROM daily_play').get().n;
}

export function distinctPlayDatesInRange(db, start, end) {
  return db
    .prepare('SELECT COUNT(DISTINCT play_date) AS n FROM daily_play WHERE play_date BETWEEN ? AND ?')
    .get(start, end).n;
}

export function dailyPlayDateRange(db) {
  return db
    .prepare('SELECT MIN(play_date) AS first, MAX(play_date) AS last, COUNT(DISTINCT play_date) AS days FROM daily_play')
    .get();
}

export function latestSnapshot(db) {
  return db
    .prepare('SELECT snapshot_date, fetched_at, item_count, status FROM snapshot ORDER BY snapshot_date DESC LIMIT 1')
    .get();
}

export function latestTodayListenSnapshot(db, date = null) {
  try {
    const sql = date
      ? `SELECT listen_date, fetched_at, item_count, raw_code, status
         FROM today_listen_snapshot
         WHERE listen_date = ?
         ORDER BY fetched_at DESC LIMIT 1`
      : `SELECT listen_date, fetched_at, item_count, raw_code, status
         FROM today_listen_snapshot
         ORDER BY fetched_at DESC LIMIT 1`;
    return date ? db.prepare(sql).get(date) : db.prepare(sql).get();
  } catch {
    return null;
  }
}

export function latestRecentPlaySnapshot(db) {
  try {
    return db
      .prepare(
        `SELECT fetched_at, item_count, raw_code, status
         FROM recent_play_snapshot
         ORDER BY fetched_at DESC LIMIT 1`
      )
      .get();
  } catch {
    return null;
  }
}

// ---- 我的歌单（只读，采集器已落库）--------------------------------
// 返回形状对齐旧 netease 代理端点，前端渲染函数无需改动。

export function userPlaylists(db, { limit = 30, offset = 0 } = {}) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM playlist').get().n;
  const rows = db
    .prepare(
      `SELECT id, name, cover_img_url, track_count, play_count,
              subscribed, privacy, update_time, creator_id, creator_name
       FROM playlist ORDER BY list_position ASC, id ASC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  return {
    source: 'user_playlist',
    total,
    more: offset + rows.length < total,
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      coverImgUrl: r.cover_img_url,
      trackCount: r.track_count,
      playCount: r.play_count,
      subscribed: !!r.subscribed,
      privacy: r.privacy,
      updateTime: r.update_time,
      creator: r.creator_id == null ? null : { id: r.creator_id, name: r.creator_name },
    })),
  };
}

export function playlistTracks(db, playlistId, { limit = 20, offset = 0 } = {}) {
  const playlist =
    db
      .prepare(
        `SELECT id, name, cover_img_url AS coverImgUrl, track_count AS trackCount, play_count AS playCount
         FROM playlist WHERE id = ?`
      )
      .get(playlistId) || { id: Number(playlistId), name: '', trackCount: 0 };
  const total = db
    .prepare('SELECT COUNT(*) AS n FROM playlist_track WHERE playlist_id = ?')
    .get(playlistId).n;
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.name AS name
       FROM playlist_track pt JOIN song s ON s.id = pt.song_id
       WHERE pt.playlist_id = ? ORDER BY pt.position
       LIMIT ? OFFSET ?`
    )
    .all(playlistId, limit, offset);
  // 歌手/专辑封面照抄 songDetails 范式（本文件顶部）
  const arStmt = db.prepare(
    `SELECT a.id, a.name FROM song_artist sa JOIN artist a ON a.id = sa.artist_id
     WHERE sa.song_id = ? ORDER BY sa.position`
  );
  const alStmt = db.prepare(
    `SELECT al.id, al.name, al.pic_url AS picUrl
     FROM song s LEFT JOIN album al ON al.id = s.album_id WHERE s.id = ?`
  );
  const items = rows.map((r) => ({
    id: r.id,
    name: r.name,
    artists: arStmt.all(r.id),
    album: alStmt.get(r.id) || null,
  }));
  return { source: 'playlist_track_all', playlist, offset, limit, total, items };
}
