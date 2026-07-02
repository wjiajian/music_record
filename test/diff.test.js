// 差分五边缘单测：用内存库 + 夹具，验证 漏抓/截断/重入/新歌/幂等/负增量。
import test from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { upsertDimensions, saveSnapshot, saveWeekSnapshot } from '../src/collector/persist.js';
import { computeDailyIncrements } from '../src/collector/diff.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  return db;
}

// 构造一个记录项；dur 默认 200000ms
function item(id, playCount, dur = 200000) {
  return {
    playCount,
    score: playCount,
    rank: 1,
    song: {
      id,
      name: 'song' + id,
      durationMs: dur,
      album: { id: 900 + id, name: 'al' + id, picUrl: null },
      artists: [{ id: 500 + id, name: 'ar' + id }],
      raw: {},
    },
  };
}

// 摄入一张快照并算增量；attribution='same' 让归属日=快照日，便于断言
function ingest(db, date, items) {
  upsertDimensions(db, date, items);
  saveSnapshot(db, date, date + 'T00:00:00Z', items, JSON.stringify(items));
  return computeDailyIncrements(db, date, { attribution: 'same' });
}

function playsOf(db, date, songId) {
  const r = db.prepare('SELECT plays, span_days, is_estimated FROM daily_play WHERE play_date=? AND song_id=?').get(date, songId);
  return r || null;
}

test('首张快照为基线，不产生增量', () => {
  const db = freshDb();
  const s = ingest(db, '2026-01-01', [item(1, 10), item(2, 5)]);
  assert.equal(s.baseline, true);
  assert.equal(s.written, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_play').get().n, 0);
});

test('正常日差分：新增=今值−昨值；零增量跳过；新歌记0', () => {
  const db = freshDb();
  ingest(db, '2026-01-01', [item(1, 10), item(2, 5)]);
  const s = ingest(db, '2026-01-02', [item(1, 13), item(2, 5), item(3, 7)]);
  assert.equal(s.written, 1); // 只有 song1 有正增量
  assert.equal(s.newSongs, 1); // song3 首见
  assert.equal(s.skipped, 1); // song2 零增量
  assert.equal(playsOf(db, '2026-01-02', 1).plays, 3);
  assert.equal(playsOf(db, '2026-01-02', 2), null);
  assert.equal(playsOf(db, '2026-01-02', 3), null); // 新歌当日记0（不入表）
});

test('① 漏抓 → 增量归到归属日，跨多天 estimated', () => {
  const db = freshDb();
  ingest(db, '2026-01-01', [item(1, 10)]);
  // 跳过 01-02，直接 01-03
  const s = ingest(db, '2026-01-03', [item(1, 20)]);
  const row = playsOf(db, '2026-01-03', 1);
  assert.equal(row.plays, 10);
  assert.equal(row.span_days, 2);
  assert.equal(row.is_estimated, 1);
  assert.equal(s.estimated, 1);
});

test('② 截断掉榜 → ③ 重入时跨隐身期一次性补回(estimated)', () => {
  const db = freshDb();
  ingest(db, '2026-01-01', [item(1, 10), item(2, 3)]);
  // song2 掉出榜单
  ingest(db, '2026-01-02', [item(1, 12)]);
  assert.equal(playsOf(db, '2026-01-02', 1).plays, 2);
  assert.equal(playsOf(db, '2026-01-02', 2), null);
  // song2 重入，playCount 从 3 → 9
  ingest(db, '2026-01-03', [item(1, 12), item(2, 9)]);
  const r2 = playsOf(db, '2026-01-03', 2);
  assert.equal(r2.plays, 6); // 9 − 3，隐身期一次性补回
  assert.equal(r2.is_estimated, 1);
  assert.equal(r2.span_days, 2);
});

test('④ 同日重跑幂等：结果不变、不翻倍', () => {
  const db = freshDb();
  ingest(db, '2026-01-01', [item(1, 10)]);
  ingest(db, '2026-01-02', [item(1, 15)]);
  assert.equal(playsOf(db, '2026-01-02', 1).plays, 5);
  // 重跑同一天（playCount 不变）
  ingest(db, '2026-01-02', [item(1, 15)]);
  assert.equal(playsOf(db, '2026-01-02', 1).plays, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_play WHERE play_date=?').get('2026-01-02').n, 1);
});

test('负增量被 clamp 跳过', () => {
  const db = freshDb();
  ingest(db, '2026-01-01', [item(1, 10)]);
  const s = ingest(db, '2026-01-02', [item(1, 8)]); // 异常回退
  assert.equal(s.skipped, 1);
  assert.equal(s.written, 0);
  assert.equal(playsOf(db, '2026-01-02', 1), null);
});

// ============ weekData 只留原始快照，不再递推 daily_play ============

function witem(id, wc) {
  return {
    playCount: wc,
    score: wc,
    rank: 1,
    song: {
      id,
      name: 'w' + id,
      durationMs: 180000,
      album: { id: 900 + id, name: 'al' + id, picUrl: null },
      artists: [{ id: 500 + id, name: 'ar' + id }],
      raw: {},
    },
  };
}

// 同一快照摄入 allData + weekData，attribution='same' 便于断言
function ingestBoth(db, date, allItems, weekItems) {
  upsertDimensions(db, date, allItems);
  if (weekItems.length) upsertDimensions(db, date, weekItems);
  saveSnapshot(db, date, date + 'T00:00:00Z', allItems, JSON.stringify(allItems));
  if (weekItems.length) saveWeekSnapshot(db, date, weekItems);
  return computeDailyIncrements(db, date, { attribution: 'same' });
}

function rowOf(db, date, songId) {
  return db.prepare('SELECT plays, span_days, is_estimated, source FROM daily_play WHERE play_date=? AND song_id=?').get(date, songId) || null;
}

test('weekData-only 歌不再写入 daily_play', () => {
  const db = freshDb();
  ingestBoth(db, '2026-06-01', [], [witem(9, 1)]);
  const s = ingestBoth(db, '2026-06-02', [], [witem(1, 3)]);
  assert.equal(s.weekIgnored, 1);
  assert.equal(s.weekWritten, 0);
  assert.equal(rowOf(db, '2026-06-02', 1), null);
});

test('同曲在 allData 与 weekData 都出现 → 只记 allData 一行', () => {
  const db = freshDb();
  ingestBoth(db, '2026-06-01', [item(1, 10)], [witem(1, 1)]);
  const s = ingestBoth(db, '2026-06-02', [item(1, 13)], [witem(1, 2)]);
  const rows = db.prepare('SELECT source, plays FROM daily_play WHERE play_date=? AND song_id=1').all('2026-06-02');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'all');
  assert.equal(rows[0].plays, 3);
  assert.ok(s.coListed >= 1);
});
