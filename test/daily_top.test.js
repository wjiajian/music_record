import test from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { dailyTopSongs } from '../src/aggregate/queries.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  return db;
}

function seedSong(db, { id, name, durationMs, albumId, albumName, picUrl, artistId, artistName }) {
  db.prepare('INSERT INTO album(id,name,pic_url) VALUES(?,?,?)').run(albumId, albumName, picUrl);
  db.prepare('INSERT INTO artist(id,name) VALUES(?,?)').run(artistId, artistName);
  db.prepare('INSERT INTO song(id,name,duration_ms,album_id) VALUES(?,?,?,?)').run(id, name, durationMs, albumId);
  db.prepare('INSERT INTO song_artist(song_id,artist_id,position) VALUES(?,?,0)').run(id, artistId);
}

function seedDailyPlay(db, date, songId, plays) {
  db.prepare('INSERT INTO daily_play(play_date,song_id,plays) VALUES(?,?,?)').run(date, songId, plays);
}

test('dailyTopSongs 按日期倒序返回每天多首歌，并按播放数排序', () => {
  const db = freshDb();
  seedSong(db, {
    id: 1,
    name: 'old winner',
    durationMs: 180000,
    albumId: 101,
    albumName: 'old album',
    picUrl: 'https://example.test/old.jpg',
    artistId: 201,
    artistName: 'old artist',
  });
  seedSong(db, {
    id: 2,
    name: 'quiet song',
    durationMs: 200000,
    albumId: 102,
    albumName: 'quiet album',
    picUrl: 'https://example.test/quiet.jpg',
    artistId: 202,
    artistName: 'quiet artist',
  });
  seedSong(db, {
    id: 3,
    name: 'new winner',
    durationMs: 240000,
    albumId: 103,
    albumName: 'new album',
    picUrl: 'https://example.test/new.jpg',
    artistId: 203,
    artistName: 'new artist',
  });

  seedDailyPlay(db, '2026-06-28', 1, 5);
  seedDailyPlay(db, '2026-06-28', 2, 2);
  seedDailyPlay(db, '2026-06-29', 1, 3);
  seedDailyPlay(db, '2026-06-29', 3, 4);

  const rows = dailyTopSongs(db, '2026-06-28', '2026-06-29');

  assert.deepEqual(rows.map((row) => `${row.date}:${row.song.id}`), ['2026-06-29:3', '2026-06-29:1', '2026-06-28:1', '2026-06-28:2']);
  assert.equal(rows[0].song.id, 3);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].song.album.picUrl, 'https://example.test/new.jpg');
  assert.deepEqual(rows[0].song.artists, [{ id: 203, name: 'new artist' }]);
  assert.equal(rows[1].rank, 2);
  assert.equal(rows[2].plays, 5);
});

test('dailyTopSongs 支持限制每天返回数量', () => {
  const db = freshDb();
  seedSong(db, {
    id: 1,
    name: 'top',
    durationMs: 180000,
    albumId: 101,
    albumName: 'top album',
    picUrl: 'https://example.test/top.jpg',
    artistId: 201,
    artistName: 'top artist',
  });
  seedSong(db, {
    id: 2,
    name: 'second',
    durationMs: 180000,
    albumId: 102,
    albumName: 'second album',
    picUrl: 'https://example.test/second.jpg',
    artistId: 202,
    artistName: 'second artist',
  });

  seedDailyPlay(db, '2026-06-29', 1, 5);
  seedDailyPlay(db, '2026-06-29', 2, 4);

  const rows = dailyTopSongs(db, '2026-06-29', '2026-06-29', 1);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].song.id, 1);
});

test('dailyTopSongs 播放数相同时按最后播放时间倒序', () => {
  const db = freshDb();
  seedSong(db, {
    id: 1,
    name: 'earlier',
    durationMs: 180000,
    albumId: 101,
    albumName: 'earlier album',
    picUrl: 'https://example.test/earlier.jpg',
    artistId: 201,
    artistName: 'earlier artist',
  });
  seedSong(db, {
    id: 2,
    name: 'later',
    durationMs: 180000,
    albumId: 102,
    albumName: 'later album',
    picUrl: 'https://example.test/later.jpg',
    artistId: 202,
    artistName: 'later artist',
  });
  seedDailyPlay(db, '2026-06-30', 1, 2);
  seedDailyPlay(db, '2026-06-30', 2, 2);
  const ins = db.prepare(
    `INSERT INTO recent_play_event(song_id,play_time,play_date,source_type,first_seen_at,last_seen_at)
     VALUES(?,?,?,?,?,?)`
  );
  ins.run(1, 1000, '2026-06-30', 'SONG', '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z');
  ins.run(2, 2000, '2026-06-30', 'SONG', '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z');

  const rows = dailyTopSongs(db, '2026-06-30', '2026-06-30');
  assert.deepEqual(rows.map((row) => row.song.id), [2, 1]);
});
