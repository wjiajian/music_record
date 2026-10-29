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
       ORDER BY ${orderCol(metric)} DESC, plays DESC, id
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
       ORDER BY ${orderCol(metric)} DESC, plays DESC, id
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
       ORDER BY ${orderCol(metric)} DESC, plays DESC, id
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
              COUNT(DISTINCT dp.song_id) AS songs,
              MAX(dp.is_estimated = 1 OR dp.span_days > 1) AS estimated
       FROM daily_play dp ${join}
       WHERE ${where.join(' AND ')}
       GROUP BY dp.play_date ORDER BY dp.play_date`
    )
    .all(...params);
}

export function dailyTopSongs(db, start, end, limitPerDay = 24) {
  const rows = db
    .prepare(
      `WITH event_last AS (
         SELECT play_date, song_id, MAX(play_time) AS last_play_time
         FROM recent_play_event
         WHERE play_date BETWEEN ? AND ?
         GROUP BY play_date, song_id
       ), ranked AS (
         SELECT dp.play_date AS date,
                dp.song_id AS song_id,
                s.name AS song_name,
                al.id AS album_id,
                al.name AS album_name,
                al.pic_url AS pic_url,
                SUM(dp.plays) AS plays,
                SUM(dp.plays * COALESCE(s.duration_ms,0)) AS est_ms,
                MAX(el.last_play_time) AS last_play_time,
                ROW_NUMBER() OVER (
                  PARTITION BY dp.play_date
                  ORDER BY SUM(dp.plays) DESC,
                           MAX(el.last_play_time) DESC,
                           dp.song_id
                ) AS rn
         FROM daily_play dp
         JOIN song s ON s.id = dp.song_id
         LEFT JOIN album al ON al.id = s.album_id
         LEFT JOIN event_last el ON el.play_date = dp.play_date AND el.song_id = dp.song_id
         WHERE dp.play_date BETWEEN ? AND ?
         GROUP BY dp.play_date, dp.song_id
       )
       SELECT date, song_id, song_name, album_id, album_name, pic_url,
              plays, est_ms, last_play_time, rn
       FROM ranked
       WHERE rn <= ?
       ORDER BY date DESC, rn`
    )
    .all(start, end, start, end, limitPerDay);

  const arStmt = db.prepare(
    `SELECT a.id, a.name FROM song_artist sa JOIN artist a ON a.id = sa.artist_id
     WHERE sa.song_id = ? ORDER BY sa.position`
  );
  return rows.map((r) => ({
    date: r.date,
    rank: r.rn,
    plays: r.plays,
    est_minutes: Math.round((r.est_ms || 0) / 60000),
    last_play_time: r.last_play_time,
    song: {
      id: r.song_id,
      name: r.song_name,
      artists: arStmt.all(r.song_id),
      album: r.album_id == null ? null : { id: r.album_id, name: r.album_name, picUrl: r.pic_url },
    },
  }));
}

// ---- 小时活跃度（只读取真实捕获的最近播放事件）---------------------

export function recentPlayEventsInRange(db, start, end, opts = {}) {
  const { songId, artistId, albumId } = opts;
  let join = '';
  const where = ['e.play_date BETWEEN ? AND ?'];
  const params = [start, end];
  if (songId != null) {
    where.push('e.song_id = ?');
    params.push(songId);
  }
  if (albumId != null) {
    join += ' JOIN song s ON s.id = e.song_id';
    where.push('s.album_id = ?');
    params.push(albumId);
  }
  if (artistId != null) {
    join += ' JOIN song_artist sa ON sa.song_id = e.song_id';
    where.push('sa.artist_id = ?');
    params.push(artistId);
  }
  return db
    .prepare(
      `SELECT e.song_id, e.play_time, e.play_date
       FROM recent_play_event e${join}
       WHERE ${where.join(' AND ')}
       ORDER BY e.play_time`
    )
    .all(...params);
}

// ---- 详情抽屉（歌曲 / 歌手 / 专辑）--------------------------------
// key/join 只来自这张白名单表，维度由路由校验后才进来。

const DETAIL_SCOPE = {
  song: { join: '', key: 'dp.song_id' },
  artist: { join: 'JOIN song_artist sa ON sa.song_id = dp.song_id', key: 'sa.artist_id' },
  album: { join: 'JOIN album al ON al.id = s.album_id', key: 'al.id' },
};

export function entityInfo(db, dimension, id) {
  if (dimension === 'song') {
    const row = db.prepare('SELECT id, name, duration_ms FROM song WHERE id = ?').get(id);
    if (!row) return null;
    const [song] = songDetails(db, [row], 0);
    return { id: song.id, name: song.name, duration_ms: row.duration_ms, artists: song.artists, album: song.album };
  }
  if (dimension === 'artist') {
    return db.prepare('SELECT id, name FROM artist WHERE id = ?').get(id) || null;
  }
  const album = db.prepare('SELECT id, name, pic_url AS picUrl FROM album WHERE id = ?').get(id);
  if (!album) return null;
  // 专辑本身不存歌手，取其歌曲的第一署名歌手。
  const artists = db
    .prepare(
      `SELECT DISTINCT a.id, a.name
       FROM song s JOIN song_artist sa ON sa.song_id = s.id AND sa.position = 0
       JOIN artist a ON a.id = sa.artist_id
       WHERE s.album_id = ? ORDER BY a.id LIMIT 3`
    )
    .all(id);
  return { ...album, artists };
}

export function entityTotals(db, dimension, id, start, end) {
  const { join, key } = DETAIL_SCOPE[dimension];
  return db
    .prepare(
      `SELECT COALESCE(SUM(dp.plays),0) AS plays,
              COALESCE(SUM(dp.plays * COALESCE(s.duration_ms,0)),0) AS est_ms,
              MIN(dp.play_date) AS first_date,
              MAX(dp.play_date) AS last_date,
              COUNT(DISTINCT dp.play_date) AS days
       FROM daily_play dp JOIN song s ON s.id = dp.song_id ${join}
       WHERE ${key} = ? AND dp.play_date BETWEEN ? AND ?`
    )
    .get(id, start, end);
}

// 名次与排行列表同序（次数降序，同次数按 id 升序），抽屉里的「排第 N」才能和列表对上。
export function entityRank(db, dimension, id, start, end) {
  const { join, key } = DETAIL_SCOPE[dimension];
  return (
    db
      .prepare(
        `WITH t AS (
           SELECT ${key} AS id, SUM(dp.plays) AS plays
           FROM daily_play dp JOIN song s ON s.id = dp.song_id ${join}
           WHERE dp.play_date BETWEEN ? AND ? AND ${key} IS NOT NULL
           GROUP BY ${key}
         )
         SELECT (SELECT COUNT(*) FROM t o
                 WHERE o.plays > me.plays OR (o.plays = me.plays AND o.id < me.id)) + 1 AS rank,
                (SELECT COUNT(*) FROM t) AS total
         FROM t me WHERE me.id = ?`
      )
      .get(start, end, id) || null
  );
}

export function entityTopSongs(db, dimension, id, start, end, limit = 5) {
  const { join, key } = DETAIL_SCOPE[dimension];
  const rows = db
    .prepare(
      `SELECT dp.song_id AS id, s.name AS name,
              SUM(dp.plays) AS plays,
              SUM(dp.plays * COALESCE(s.duration_ms,0)) AS est_ms
       FROM daily_play dp JOIN song s ON s.id = dp.song_id ${join}
       WHERE ${key} = ? AND dp.play_date BETWEEN ? AND ?
       GROUP BY dp.song_id
       ORDER BY plays DESC, id
       LIMIT ?`
    )
    .all(id, start, end, limit);
  return songDetails(db, rows, 0);
}

// 同一次播放可能因来源类型不同存成多行，按时间去重。
export function songRecentPlayTimes(db, songId, limit = 5) {
  return db
    .prepare('SELECT DISTINCT play_time FROM recent_play_event WHERE song_id = ? ORDER BY play_time DESC LIMIT ?')
    .all(songId, limit)
    .map((row) => row.play_time);
}

export function playlistsWithSong(db, songId) {
  return db
    .prepare(
      `SELECT id, name, track_count AS trackCount
       FROM playlist
       WHERE id IN (SELECT playlist_id FROM playlist_track WHERE song_id = ?)
       ORDER BY list_position, id`
    )
    .all(songId);
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

export function counterStatus(db) {
  const rows = db
    .prepare(
      `SELECT key, value FROM meta
       WHERE key IN ('counter_started_at','counter_complete_from','counter_last_success_at','counter_last_error')`
    )
    .all();
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    started_at: values.counter_started_at || null,
    complete_from: values.counter_complete_from || null,
    last_success_at: values.counter_last_success_at || null,
    last_error: values.counter_last_error || null,
  };
}

export function counterPollGaps(db) {
  return db
    .prepare('SELECT started_at, ended_at, reason FROM counter_poll_gap ORDER BY started_at')
    .all();
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
