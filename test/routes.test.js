import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import Fastify from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import routes from '../src/api/routes.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  return db;
}

function seed(db) {
  db.prepare('INSERT INTO album(id,name,pic_url) VALUES(1,?,?)').run('album', 'https://example.test/cover.jpg');
  db.prepare('INSERT INTO artist(id,name) VALUES(1,?)').run('artist');
  db.prepare('INSERT INTO song(id,name,duration_ms,album_id) VALUES(1,?,?,1)').run('song', 180000);
  db.prepare('INSERT INTO song_artist(song_id,artist_id,position) VALUES(1,1,0)').run();
  db.prepare(
    'INSERT INTO daily_play(play_date,song_id,plays,span_days,is_estimated,source) VALUES(?,1,?,1,0,?)'
  ).run('2020-07-14', 2, 'recent');
  db.prepare(
    'INSERT INTO daily_play(play_date,song_id,plays,span_days,is_estimated,source) VALUES(?,1,?,1,0,?)'
  ).run('2020-07-20', 3, 'recent');

  const s1 = Number(
    db.prepare('INSERT INTO snapshot(snapshot_date,fetched_at,item_count,status) VALUES(?,?,1,?)')
      .run('2020-07-07', '2020-07-06T20:00:00Z', 'ok').lastInsertRowid
  );
  const s2 = Number(
    db.prepare('INSERT INTO snapshot(snapshot_date,fetched_at,item_count,status) VALUES(?,?,1,?)')
      .run('2020-07-20', '2020-07-19T20:00:00Z', 'ok').lastInsertRowid
  );
  db.prepare('INSERT INTO snapshot_item(snapshot_id,song_id,play_count,rank) VALUES(?,?,?,1)').run(s1, 1, 100);
  db.prepare('INSERT INTO snapshot_item(snapshot_id,song_id,play_count,rank) VALUES(?,?,?,1)').run(s2, 1, 999);
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('counter_complete_from', '2020-07-14');
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('counter_last_success_at', '2020-07-20T12:00:00Z');
}

async function appWithDb(db) {
  const app = Fastify();
  app.decorate('db', db);
  await app.register(routes);
  await app.ready();
  return app;
}

test('overview/ranking 使用滚动周期和 daily_play 统一口径', async () => {
  const db = freshDb();
  seed(db);
  const app = await appWithDb(db);

  const overview = await app.inject('/api/overview?period=week&date=2020-07-20');
  assert.equal(overview.statusCode, 200);
  const overviewBody = overview.json();
  assert.deepEqual(overviewBody.range, { start: '2020-07-14', end: '2020-07-20' });
  assert.equal(overviewBody.totals.plays, 5);
  assert.equal(overviewBody.meta.data_quality.lower_bound, false);

  const ranking = await app.inject('/api/ranking?period=all&date=2020-07-20&dimension=song');
  assert.equal(ranking.statusCode, 200);
  const rankingBody = ranking.json();
  assert.equal(rankingBody.meta.source, 'daily_play');
  assert.equal(rankingBody.items[0].plays, 5); // 不再走 snapshot_item 的累计 999

  await app.close();
  db.close();
});

test('daily-top-songs 包含锚点当天并返回去重歌曲与全天总次数', async () => {
  const db = freshDb();
  seed(db);
  const app = await appWithDb(db);

  const response = await app.inject('/api/daily-top-songs?days=7&to=2020-07-20');
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.meta.range, { start: '2020-07-14', end: '2020-07-20' });
  assert.equal(body.items[0].date, '2020-07-20');
  assert.equal(body.items[0].plays, 3);
  assert.equal(body.items[0].songs.length, 1);

  await app.close();
  db.close();
});
