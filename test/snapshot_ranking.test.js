import test from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import {
  rankingSongsFromAllSnapshot,
  rankingSongsFromWeekSnapshot,
  rankingSongsFromWeekSnapshotDelta,
} from '../src/aggregate/queries.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  return db;
}

function seedSong(db, id, name) {
  db.prepare('INSERT INTO album(id,name,pic_url) VALUES(?,?,?)').run(900 + id, 'album' + id, null);
  db.prepare('INSERT INTO artist(id,name) VALUES(?,?)').run(500 + id, 'artist' + id);
  db.prepare('INSERT INTO song(id,name,duration_ms,album_id) VALUES(?,?,?,?)').run(id, name, 200000, 900 + id);
  db.prepare('INSERT INTO song_artist(song_id,artist_id,position) VALUES(?,?,0)').run(id, 500 + id);
}

function seedSnapshot(db, date) {
  return Number(
    db
      .prepare('INSERT INTO snapshot(snapshot_date,fetched_at,item_count,status) VALUES(?,?,?,?)')
      .run(date, `${date}T00:00:00Z`, 2, 'ok').lastInsertRowid
  );
}

test('snapshot ranking uses allData cumulative counts for all period', () => {
  const db = freshDb();
  seedSong(db, 1, 'one');
  seedSong(db, 2, 'two');
  const snap = seedSnapshot(db, '2026-06-30');
  db.prepare('INSERT INTO snapshot_item(snapshot_id,song_id,play_count,rank) VALUES(?,?,?,?)').run(snap, 1, 2, 2);
  db.prepare('INSERT INTO snapshot_item(snapshot_id,song_id,play_count,rank) VALUES(?,?,?,?)').run(snap, 2, 5, 1);

  const rows = rankingSongsFromAllSnapshot(db, snap, 'plays', 10, 0);

  assert.deepEqual(rows.map((row) => `${row.name}:${row.plays}`), ['two:5', 'one:2']);
});

test('snapshot ranking uses weekData counts and consecutive positive deltas', () => {
  const db = freshDb();
  seedSong(db, 1, 'one');
  seedSong(db, 2, 'two');
  const prev = seedSnapshot(db, '2026-06-29');
  const cur = seedSnapshot(db, '2026-06-30');
  db.prepare('INSERT INTO snapshot_week_item(snapshot_id,song_id,play_count,rank) VALUES(?,?,?,?)').run(prev, 1, 1, 2);
  db.prepare('INSERT INTO snapshot_week_item(snapshot_id,song_id,play_count,rank) VALUES(?,?,?,?)').run(prev, 2, 3, 1);
  db.prepare('INSERT INTO snapshot_week_item(snapshot_id,song_id,play_count,rank) VALUES(?,?,?,?)').run(cur, 1, 4, 1);
  db.prepare('INSERT INTO snapshot_week_item(snapshot_id,song_id,play_count,rank) VALUES(?,?,?,?)').run(cur, 2, 3, 2);

  const weekRows = rankingSongsFromWeekSnapshot(db, cur, 'plays', 10, 0);
  const dayRows = rankingSongsFromWeekSnapshotDelta(db, cur, prev, 'plays', 10, 0);

  assert.deepEqual(weekRows.map((row) => `${row.name}:${row.plays}`), ['one:4', 'two:3']);
  assert.deepEqual(dayRows.map((row) => `${row.name}:${row.plays}`), ['one:3']);
});
