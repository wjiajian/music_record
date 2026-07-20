import test from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import {
  applyRecentPlayEvents,
  markCounterPollFailure,
  markCounterPollSuccess,
  replaceDailyPlayWithRecentEvents,
  saveRecentPlaySnapshot,
  saveSnapshot,
  saveTodayListenSnapshot,
  upsertDimensions,
} from '../src/collector/persist.js';
import { computeDailyIncrements } from '../src/collector/diff.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  return db;
}

function item(id, playCount, extra = {}) {
  return {
    playCount,
    rank: extra.rank ?? 1,
    listenTime: extra.listenTime ?? null,
    playTime: extra.playTime ?? null,
    sourceType: extra.sourceType ?? null,
    song: {
      id,
      name: 'song' + id,
      durationMs: 200000,
      album: { id: 900 + id, name: 'al' + id, picUrl: null },
      artists: [{ id: 500 + id, name: 'ar' + id }],
      raw: {},
    },
  };
}

function rowsForDate(db, date) {
  return db
    .prepare('SELECT song_id, plays, source FROM daily_play WHERE play_date=? ORDER BY song_id')
    .all(date);
}

function ts(localIso) {
  return new Date(localIso).getTime();
}

test('最近播放按唯一 playTime 计数：同一首歌重复播放会累加', () => {
  const db = freshDb();
  const date = '2026-06-30';
  const first = [
    item(1, null, { playTime: ts('2026-06-30T10:00:00+08:00'), sourceType: 'SONG' }),
    item(2, null, { playTime: ts('2026-06-30T10:03:00+08:00'), sourceType: 'SONG' }),
  ];
  upsertDimensions(db, date, first);
  saveRecentPlaySnapshot(db, '2026-06-30T02:00:00Z', first, JSON.stringify(first));
  replaceDailyPlayWithRecentEvents(db, date);

  // song1 再次被播放（新 playTime）——计数应累加到 2
  const second = [
    item(1, null, { playTime: ts('2026-06-30T10:00:00+08:00'), sourceType: 'SONG' }),
    item(1, null, { playTime: ts('2026-06-30T10:08:00+08:00'), sourceType: 'SONG' }),
  ];
  upsertDimensions(db, date, second);
  saveRecentPlaySnapshot(db, '2026-06-30T02:10:00Z', second, JSON.stringify(second));
  const result = replaceDailyPlayWithRecentEvents(db, date);

  assert.deepEqual(result, { replaced: true, written: 2, skipped: null });
  assert.deepEqual(rowsForDate(db, date), [
    { song_id: 1, plays: 2, source: 'recent' },
    { song_id: 2, plays: 1, source: 'recent' },
  ]);
});

test('指定日期没有最近播放事件时不清空已有日数据', () => {
  const db = freshDb();
  const date = '2026-06-30';
  const first = [item(1, 3)];
  upsertDimensions(db, date, first);
  db.prepare("INSERT INTO daily_play(play_date,song_id,plays,source) VALUES(?,?,?,?)").run(date, 1, 3, 'all');

  const result = replaceDailyPlayWithRecentEvents(db, date);

  assert.deepEqual(result, { replaced: false, written: 0, skipped: 'no_recent_events' });
  assert.deepEqual(rowsForDate(db, date), [{ song_id: 1, plays: 3, source: 'all' }]);
});

test('rebuild 可用最近播放事件重放 daily_play（重复事件正常累加）', () => {
  const db = freshDb();
  const date = '2026-06-30';
  const events = [
    item(1, null, { playTime: ts('2026-06-30T10:00:00+08:00'), sourceType: 'SONG' }),
    item(1, null, { playTime: ts('2026-06-30T10:05:00+08:00'), sourceType: 'SONG' }),
  ];
  upsertDimensions(db, date, events);
  saveRecentPlaySnapshot(db, '2026-06-30T02:10:00Z', events, JSON.stringify(events));

  const result = applyRecentPlayEvents(db);

  assert.deepEqual(result, { dates: 1, replaced: 1, written: 1 });
  assert.deepEqual(rowsForDate(db, date), [{ song_id: 1, plays: 2, source: 'recent' }]);
});

test('最近播放按快照位置保存，事件表按 song_id + play_time 去重', () => {
  const db = freshDb();
  const items = [
    item(1, null, { playTime: 1000, sourceType: 'song' }),
    item(1, null, { playTime: 1000, sourceType: 'song' }),
  ];
  upsertDimensions(db, '2026-06-30', items);
  saveRecentPlaySnapshot(db, '2026-06-30T01:00:00Z', items, JSON.stringify(items));
  saveRecentPlaySnapshot(db, '2026-06-30T02:00:00Z', items, JSON.stringify(items));

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recent_play_item').get().n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recent_play_event').get().n, 1);
});

test('高频计数器记录完整起点，并在失败后闭合采集缺口', () => {
  const db = freshDb();
  markCounterPollSuccess(db, '2026-06-30T02:00:00.000Z', 60000);
  assert.equal(
    db.prepare("SELECT value FROM meta WHERE key='counter_complete_from'").get().value,
    '2026-07-01'
  );

  markCounterPollFailure(db, '2026-06-30T02:01:00.000Z', new Error('network'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM counter_poll_gap WHERE ended_at IS NULL').get().n, 1);

  markCounterPollSuccess(db, '2026-06-30T02:02:00.000Z', 60000);
  const gap = db.prepare('SELECT started_at, ended_at FROM counter_poll_gap').get();
  assert.deepEqual(gap, {
    started_at: '2026-06-30T02:01:00.000Z',
    ended_at: '2026-06-30T02:02:00.000Z',
  });
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='counter_last_error'").get(), undefined);
});

test('今日足迹保存列表与最后播放时间，但不参与 daily_play 计数', () => {
  const db = freshDb();
  const date = '2026-06-30';
  const items = [item(1, null, { listenTime: 1782809703 })];
  upsertDimensions(db, date, items);
  const snapshotId = saveTodayListenSnapshot(db, date, '2026-06-30T02:00:00Z', items, JSON.stringify(items));

  const row = db.prepare('SELECT play_count, listen_time FROM today_listen_item WHERE snapshot_id=?').get(snapshotId);
  assert.deepEqual(row, { play_count: null, listen_time: 1782809703 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_play').get().n, 0);
});

test('瘦字段响应不会覆盖已有歌曲时长和专辑', () => {
  const db = freshDb();
  const rich = [item(1, null)];
  upsertDimensions(db, '2026-06-30', rich);

  const thin = [{
    playCount: null,
    rank: 1,
    listenTime: 1782809703,
    song: {
      id: 1,
      name: 'song1',
      durationMs: null,
      album: null,
      artists: [{ id: 501, name: 'ar1' }],
      raw: {},
    },
  }];
  upsertDimensions(db, '2026-06-30', thin);

  const row = db.prepare('SELECT duration_ms, album_id FROM song WHERE id=1').get();
  assert.deepEqual(row, { duration_ms: 200000, album_id: 901 });
});

// ============ 两源冲突：allData 差分与 recent 计数按每首歌每天取较大值 ============
// 摄入两张 allData 快照并算差分（attribution='same' → 归属到快照当天）
function ingestAll(db, date, items) {
  upsertDimensions(db, date, items);
  saveSnapshot(db, date, date + 'T00:00:00Z', items, JSON.stringify(items));
  return computeDailyIncrements(db, date, { attribution: 'same' });
}

// 在 date 落一批「最近播放」事件（每首歌一个 playTime）
function ingestRecent(db, date, songIds, hhmm = '10:00') {
  const items = songIds.map((id, i) =>
    item(id, null, { playTime: ts(`${date}T${hhmm}:0${i}+08:00`), sourceType: 'SONG' })
  );
  upsertDimensions(db, date, items);
  saveRecentPlaySnapshot(db, `${date}T02:00:00Z`, items, JSON.stringify(items));
  return replaceDailyPlayWithRecentEvents(db, date);
}

test('循环播放：allData 差分反映真实次数（听 10 遍 → plays=10）', () => {
  const db = freshDb();
  ingestAll(db, '2026-06-29', [item(1, 5)]);        // 基线
  ingestAll(db, '2026-06-30', [item(1, 15)]);        // 次日 +10（循环 10 遍）
  const row = db.prepare("SELECT plays, source FROM daily_play WHERE play_date='2026-06-30' AND song_id=1").get();
  assert.deepEqual(row, { plays: 10, source: 'all' });
});

test('all 权威：recent 先占位，allData 差分到来后覆盖为真实次数', () => {
  const db = freshDb();
  ingestAll(db, '2026-06-29', [item(1, 5)]);          // 基线
  ingestRecent(db, '2026-06-30', [1]);                // recent 先占位 plays=1
  assert.deepEqual(
    db.prepare("SELECT plays, source FROM daily_play WHERE play_date='2026-06-30' AND song_id=1").get(),
    { plays: 1, source: 'recent' }
  );
  ingestAll(db, '2026-06-30', [item(1, 12)]);         // allData 差分 +7，覆盖 recent 占位
  assert.deepEqual(
    db.prepare("SELECT plays, source FROM daily_play WHERE play_date='2026-06-30' AND song_id=1").get(),
    { plays: 7, source: 'all' }
  );
});

test('recent 不覆盖 all：allData 已有真实次数时 recent 占位被忽略', () => {
  const db = freshDb();
  ingestAll(db, '2026-06-29', [item(1, 5)]);
  ingestAll(db, '2026-06-30', [item(1, 12)]);         // all 真实 +7
  ingestRecent(db, '2026-06-30', [1, 2]);             // song1 已有 all；song2 是 all 没有的新歌
  const rows = db
    .prepare("SELECT song_id, plays, source FROM daily_play WHERE play_date='2026-06-30' ORDER BY song_id")
    .all();
  assert.deepEqual(rows, [
    { song_id: 1, plays: 7, source: 'all' },          // all 保留，未被 recent 降级
    { song_id: 2, plays: 1, source: 'recent' },       // 只补 all 没有的歌
  ]);
});

test('recent 捕获次数高于 allData 差分时，计数器只补高不调低', () => {
  const db = freshDb();
  ingestAll(db, '2026-06-29', [item(1, 5)]);
  ingestAll(db, '2026-06-30', [item(1, 7)]); // allData +2
  const repeated = [
    item(1, null, { playTime: ts('2026-06-30T10:00:00+08:00'), sourceType: 'SONG' }),
    item(1, null, { playTime: ts('2026-06-30T10:04:00+08:00'), sourceType: 'SONG' }),
    item(1, null, { playTime: ts('2026-06-30T10:08:00+08:00'), sourceType: 'SONG' }),
  ];
  upsertDimensions(db, '2026-06-30', repeated);
  saveRecentPlaySnapshot(db, '2026-06-30T02:10:00Z', repeated, JSON.stringify(repeated));
  replaceDailyPlayWithRecentEvents(db, '2026-06-30');
  assert.deepEqual(
    db.prepare("SELECT plays, source FROM daily_play WHERE play_date='2026-06-30' AND song_id=1").get(),
    { plays: 3, source: 'recent' }
  );

  // allData 同日重算仍只有 2，不能把已捕获的 3 次降回去。
  computeDailyIncrements(db, '2026-06-30', { attribution: 'same' });
  assert.deepEqual(
    db.prepare("SELECT plays, source FROM daily_play WHERE play_date='2026-06-30' AND song_id=1").get(),
    { plays: 3, source: 'recent' }
  );
});

test('两源分域幂等：重跑 recent 不删 all、重跑 all 不删 recent', () => {
  const db = freshDb();
  ingestAll(db, '2026-06-29', [item(1, 5)]);
  ingestAll(db, '2026-06-30', [item(1, 12)]);         // all: song1=7
  ingestRecent(db, '2026-06-30', [2]);                // recent: song2=1
  // 重跑 recent —— all 行必须仍在
  ingestRecent(db, '2026-06-30', [2]);
  // 重跑 all —— recent 行必须仍在
  ingestAll(db, '2026-06-30', [item(1, 12)]);
  const rows = db
    .prepare("SELECT song_id, plays, source FROM daily_play WHERE play_date='2026-06-30' ORDER BY song_id")
    .all();
  assert.deepEqual(rows, [
    { song_id: 1, plays: 7, source: 'all' },
    { song_id: 2, plays: 1, source: 'recent' },
  ]);
});
