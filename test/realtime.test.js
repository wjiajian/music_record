import test from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import {
  applyRecentPlayEvents,
  replaceDailyPlayWithRecentEvents,
  saveRecentPlaySnapshot,
  saveTodayListenSnapshot,
  upsertDimensions,
} from '../src/collector/persist.js';

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

test('最近播放事件覆盖当天 daily_play，同一事件不重复累加', () => {
  const db = freshDb();
  const date = '2026-06-30';
  const first = [
    item(1, null, { playTime: ts('2026-06-30T10:00:00+08:00'), sourceType: 'SONG' }),
    item(2, null, { playTime: ts('2026-06-30T10:03:00+08:00'), sourceType: 'SONG' }),
  ];
  upsertDimensions(db, date, first);
  saveRecentPlaySnapshot(db, '2026-06-30T02:00:00Z', first, JSON.stringify(first));
  replaceDailyPlayWithRecentEvents(db, date);

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

test('rebuild 可用最近播放事件重放 daily_play', () => {
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
