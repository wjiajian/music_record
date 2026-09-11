import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import Fastify from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { DateTime } from 'luxon';
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

test('趋势默认不生成采集前的月份，显式请求的未知空桶与已覆盖零值分开', async () => {
  const db = freshDb();
  seed(db);
  // 清除快照夹具中的缺口，用连续计数覆盖确认 7 月 15 日的零值。
  db.prepare('DELETE FROM snapshot_item').run();
  db.prepare('DELETE FROM snapshot').run();
  const app = await appWithDb(db);
  try {
    const monthly = (await app.inject('/api/trend?granularity=month&last=12&to=2020-07-20')).json();
    assert.equal(monthly.meta.range.start, '2020-07-14');
    assert.deepEqual(monthly.series.map((p) => p.bucket), ['2020-07']);
    assert.equal(monthly.series[0].plays, 5);

    const daily = (await app.inject('/api/trend?from=2020-07-13&to=2020-07-15')).json().series;
    assert.equal(daily[0].missing, true);
    assert.equal(daily[1].plays, 2);
    assert.equal(daily[1].missing, false);
    assert.equal(daily[2].plays, 0);
    assert.equal(daily[2].missing, false);
    assert.equal(daily[2].lower_bound, false);

    const stopped = (await app.inject('/api/trend?from=2020-07-21&to=2020-07-21')).json().series[0];
    assert.equal(stopped.missing, true);
  } finally {
    await app.close();
    db.close();
  }
});

test('采集缺口在日周月汇总中保留已有量并标下界，跨日归属也标下界', async () => {
  const db = freshDb();
  seed(db);
  db.prepare('INSERT INTO counter_poll_gap(started_at,ended_at,reason) VALUES(?,?,?)')
    .run('2020-07-20T01:00:00Z', '2020-07-20T01:01:00Z', '短暂失败');
  const app = await appWithDb(db);
  try {
    for (const granularity of ['day', 'week', 'month']) {
      const point = (await app.inject(`/api/trend?granularity=${granularity}&from=2020-07-20&to=2020-07-20`)).json().series[0];
      assert.equal(point.plays, 3);
      assert.equal(point.has_gap, true);
      assert.equal(point.lower_bound, true);
      assert.equal(point.missing, false);
    }
    db.prepare('DELETE FROM counter_poll_gap').run();
    db.prepare("UPDATE daily_play SET span_days=16 WHERE play_date='2020-07-20'").run();
    const point = (await app.inject('/api/trend?from=2020-07-20&to=2020-07-20')).json().series[0];
    assert.equal(point.has_gap, false);
    assert.equal(point.estimated, true);
    assert.equal(point.lower_bound, true);
    assert.equal(point.missing, false);
  } finally {
    await app.close();
    db.close();
  }
});

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

test('hourly-activity 固定返回 24 桶，只按本地小时统计真实事件并披露未定位补量', async () => {
  const db = freshDb();
  seed(db);
  db.prepare(
    'INSERT INTO daily_play(play_date,song_id,plays,span_days,is_estimated,source) VALUES(?,1,?,1,0,?)'
  ).run('2020-07-19', 4, 'all');

  const insertEvent = db.prepare(
    `INSERT INTO recent_play_event(song_id,play_time,play_date,source_type,first_seen_at,last_seen_at)
     VALUES(?,?,?,?,?,?)`
  );
  for (const [iso, playDate] of [
    ['2020-07-17T17:10:00Z', '2020-07-18'],
    ['2020-07-18T16:30:00Z', '2020-07-19'],
    ['2020-07-19T04:00:00Z', '2020-07-19'],
    ['2020-07-19T04:05:00Z', '2020-07-19'],
  ]) {
    insertEvent.run(1, Date.parse(iso), playDate, 'SONG', iso, iso);
  }

  const app = await appWithDb(db);
  const response = await app.inject('/api/hourly-activity?from=2020-07-18&to=2020-07-19');
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.buckets.length, 24);
  assert.deepEqual(body.meta.range, { start: '2020-07-18', end: '2020-07-19' });
  assert.equal(body.meta.timezone, 'Asia/Shanghai');
  assert.equal(body.meta.located_plays, 4);
  assert.equal(body.meta.ledger_plays, 4);
  // 7 月 18 日多捕获的一次事件不能抵消 7 月 19 日无法定位到小时的一次账本补量。
  assert.equal(body.meta.unlocated_plays, 1);
  assert.equal(body.meta.lower_bound, true);
  assert.deepEqual(body.buckets[0], { hour: 0, plays: 1, distinct_songs: 1, share: 0.25 });
  assert.deepEqual(body.buckets[1], { hour: 1, plays: 1, distinct_songs: 1, share: 0.25 });
  assert.deepEqual(body.buckets[12], { hour: 12, plays: 2, distinct_songs: 1, share: 0.5 });
  assert.equal(body.buckets[23].plays, 0);

  const future = await app.inject('/api/hourly-activity?to=2999-12-31');
  assert.equal(future.statusCode, 200);
  assert.equal(
    future.json().meta.range.end,
    DateTime.now().setZone('Asia/Shanghai').minus({ days: 1 }).toISODate()
  );
  assert.equal(future.json().meta.excludes_today, true);

  const invalid = await app.inject('/api/hourly-activity?from=not-a-date');
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, 'invalid_hourly_activity_range');

  await app.close();
  db.close();
});

test('cover 端点拒绝代理非网易云图片域名', async () => {
  const db = freshDb();
  const app = await appWithDb(db);
  const response = await app.inject('/api/cover?url=https%3A%2F%2Fexample.test%2Fcover.jpg');
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'unsupported_cover_host');
  await app.close();
  db.close();
});
