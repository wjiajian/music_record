PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ① 不可变原始快照（审计源；daily_play 可据此整表重建）---------------
CREATE TABLE IF NOT EXISTS snapshot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT    NOT NULL UNIQUE,      -- 'YYYY-MM-DD'（Asia/Shanghai）；幂等键
  fetched_at    TEXT    NOT NULL,             -- ISO8601 UTC，成功抓取的真实瞬间
  item_count    INTEGER NOT NULL,
  raw_sha256    TEXT,                          -- 原始 allData JSON 摘要，审计/去重
  status        TEXT    NOT NULL DEFAULT 'ok'
);

CREATE TABLE IF NOT EXISTS snapshot_item (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  song_id     INTEGER NOT NULL,
  play_count  INTEGER NOT NULL,               -- 累计播放次数，单调不减
  score       INTEGER,                         -- 网易权重，仅留存审计
  rank        INTEGER,                         -- 在 allData 中的位次(1-based)
  PRIMARY KEY (snapshot_id, song_id)
);
CREATE INDEX IF NOT EXISTS idx_snapitem_song ON snapshot_item(song_id);

-- weekData（最近 7 天滚动窗口）每日快照；与 snapshot_item(allData) 并存
CREATE TABLE IF NOT EXISTS snapshot_week_item (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  song_id     INTEGER NOT NULL,
  play_count  INTEGER NOT NULL,               -- 最近 7 天播放数（滚动，非累计）
  rank        INTEGER,
  PRIMARY KEY (snapshot_id, song_id)
);
CREATE INDEX IF NOT EXISTS idx_weekitem_song ON snapshot_week_item(song_id);

-- ② 维度表（每次抓取 upsert）-----------------------------------------
CREATE TABLE IF NOT EXISTS album (
  id      INTEGER PRIMARY KEY,                 -- netease album id
  name    TEXT,
  pic_url TEXT
);
CREATE TABLE IF NOT EXISTS artist (
  id   INTEGER PRIMARY KEY,                    -- netease artist id
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS song (
  id          INTEGER PRIMARY KEY,             -- netease song id
  name        TEXT NOT NULL,
  duration_ms INTEGER,                          -- song.dt，听歌时长估算用
  album_id    INTEGER REFERENCES album(id),
  first_seen  TEXT,                             -- 首次出现的 snapshot_date
  last_seen   TEXT,
  raw_json    TEXT                              -- 最近一次原始 song 对象，便于重算
);
CREATE TABLE IF NOT EXISTS song_artist (        -- 多对多（合唱）
  song_id   INTEGER NOT NULL REFERENCES song(id),
  artist_id INTEGER NOT NULL REFERENCES artist(id),
  position  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (song_id, artist_id)
);
CREATE INDEX IF NOT EXISTS idx_songartist_artist ON song_artist(artist_id);

-- ③ 派生事实表：每日每歌播放增量（所有排行/趋势的查询基表）----------
CREATE TABLE IF NOT EXISTS daily_play (
  play_date    TEXT    NOT NULL,               -- 'YYYY-MM-DD' 归属日（见 diff.js 归属规则）
  song_id      INTEGER NOT NULL REFERENCES song(id),
  plays        INTEGER NOT NULL CHECK (plays >= 0),
  span_days    INTEGER NOT NULL DEFAULT 1,     -- 增量来源区间跨几天（1=精确单日）
  is_estimated INTEGER NOT NULL DEFAULT 0,     -- 1=跨多日/重入，日级归属不确定
  source       TEXT    NOT NULL DEFAULT 'all', -- 'recent'=最近播放事件 | 'all'=allData累计差分 | 'week'=旧版weekData递推
  PRIMARY KEY (play_date, song_id)
);
CREATE INDEX IF NOT EXISTS idx_dailyplay_song ON daily_play(song_id, play_date);
CREATE INDEX IF NOT EXISTS idx_dailyplay_date ON daily_play(play_date);

-- ④ 实时接口原始采集 -------------------------------------------------
CREATE TABLE IF NOT EXISTS today_listen_snapshot (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  listen_date TEXT    NOT NULL,                -- 'YYYY-MM-DD'（Asia/Shanghai）
  fetched_at  TEXT    NOT NULL,                -- ISO8601 UTC
  item_count  INTEGER NOT NULL,
  raw_sha256  TEXT,
  raw_code    INTEGER,
  status      TEXT    NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS idx_todaylisten_date ON today_listen_snapshot(listen_date, fetched_at);

CREATE TABLE IF NOT EXISTS today_listen_item (
  snapshot_id INTEGER NOT NULL REFERENCES today_listen_snapshot(id) ON DELETE CASCADE,
  song_id     INTEGER NOT NULL REFERENCES song(id),
  play_count  INTEGER,
  rank        INTEGER,
  listen_time INTEGER,
  PRIMARY KEY (snapshot_id, song_id)
);
CREATE INDEX IF NOT EXISTS idx_todaylisten_item_song ON today_listen_item(song_id);

CREATE TABLE IF NOT EXISTS recent_play_snapshot (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at  TEXT    NOT NULL,                -- ISO8601 UTC
  item_count  INTEGER NOT NULL,
  raw_sha256  TEXT,
  raw_code    INTEGER,
  status      TEXT    NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS idx_recentplay_snapshot_at ON recent_play_snapshot(fetched_at);

CREATE TABLE IF NOT EXISTS recent_play_item (
  snapshot_id INTEGER NOT NULL REFERENCES recent_play_snapshot(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,                -- 返回列表位置，允许同一首歌重复出现
  song_id     INTEGER NOT NULL REFERENCES song(id),
  play_time   INTEGER,
  play_count  INTEGER,
  rank        INTEGER,
  source_type TEXT,
  PRIMARY KEY (snapshot_id, position)
);
CREATE INDEX IF NOT EXISTS idx_recentplay_item_song ON recent_play_item(song_id);
CREATE INDEX IF NOT EXISTS idx_recentplay_item_time ON recent_play_item(play_time);

CREATE TABLE IF NOT EXISTS recent_play_event (
  song_id       INTEGER NOT NULL REFERENCES song(id),
  play_time     INTEGER NOT NULL,
  source_type   TEXT    NOT NULL DEFAULT '',
  first_seen_at TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL,
  PRIMARY KEY (song_id, play_time, source_type)
);
CREATE INDEX IF NOT EXISTS idx_recentplay_event_time ON recent_play_event(play_time);

-- 运维 / 探针 --------------------------------------------------------
CREATE TABLE IF NOT EXISTS collection_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS probe (
  fetched_at TEXT NOT NULL, song_id INTEGER NOT NULL, play_count INTEGER NOT NULL,
  rank INTEGER,                                 -- 在 allData 中的位次，测 ~100 截断漂移
  PRIMARY KEY (fetched_at, song_id)
);
CREATE INDEX IF NOT EXISTS idx_probe_song ON probe(song_id, fetched_at);
CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );
