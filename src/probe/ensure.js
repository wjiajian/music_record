// 幂等补建探针实验相关表/列。已建库不会自动获得新表（initSchema 只在 snapshot 缺失时跑全量）。
// runProbe / stimulus / analyze / migrate 启动时各调一次。
export function ensureProbeTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS probe (
      fetched_at TEXT NOT NULL, song_id INTEGER NOT NULL, play_count INTEGER NOT NULL,
      rank INTEGER, PRIMARY KEY (fetched_at, song_id)
    );
    CREATE INDEX IF NOT EXISTS idx_probe_song ON probe(song_id, fetched_at);

    -- 每次 HTTP 调用一行（承载时钟/缓存证据，与 probe 行共享 fetched_at 键）
    CREATE TABLE IF NOT EXISTS probe_fetch (
      fetched_at     TEXT PRIMARY KEY,   -- = resp 接收的本地 ISO(ms)
      req_sent_at    TEXT,
      resp_recv_at   TEXT,
      rtt_ms         INTEGER,
      http_status    INTEGER,
      api_code       INTEGER,
      server_date    TEXT,               -- HTTP Date 头（服务器/边缘时钟）
      skew_ms        INTEGER,            -- server_date − resp_recv（>0 表服务器时钟更快）
      age            INTEGER,            -- HTTP Age 头（命中 CDN 缓存时 >0）
      x_cache        TEXT,               -- HIT/MISS
      item_count     INTEGER,
      min_play_count INTEGER,
      max_rank       INTEGER,
      ok             INTEGER NOT NULL DEFAULT 1,
      err            TEXT
    );

    -- 刺激地面真值（机器记录 t0，analyze 据此自动对时）
    CREATE TABLE IF NOT EXISTS stimulus (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id     INTEGER NOT NULL,
      t0          TEXT NOT NULL,          -- 开始（UTC ISO）
      t0_done     TEXT,                   -- K 次放完（UTC ISO），头条延迟的锚
      expected_k  INTEGER NOT NULL DEFAULT 1,
      baseline_pc INTEGER,                -- 登记时该歌累计 playCount
      kind        TEXT NOT NULL DEFAULT 'latency',  -- latency | midnight
      label       TEXT,
      note        TEXT,
      created_at  TEXT NOT NULL
    );
  `);

  // 给「升级前已建」的 probe 表补 rank 列（已存在则吞错）
  try {
    db.exec('ALTER TABLE probe ADD COLUMN rank INTEGER');
  } catch {
    /* 列已存在，忽略 */
  }
}
