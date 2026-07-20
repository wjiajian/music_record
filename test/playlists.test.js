import test from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { collectPlaylists } from '../src/collector/playlists.js';
import { userPlaylists, playlistTracks } from '../src/aggregate/queries.js';
import { fetchUserPlaylists, normalizeSong } from '../src/netease/client.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  return db;
}

test('normalizeSong 把网易云 http 封面升级为 https，避免 HTTPS 页面混合内容拦截', () => {
  const song = normalizeSong({
    id: 1,
    name: 'song',
    picUrl: '//p1.music.126.net/song.jpg',
    al: { id: 2, name: 'album', picUrl: 'http://p1.music.126.net/album.jpg' },
    ar: [],
  });
  assert.equal(song.picUrl, 'https://p1.music.126.net/song.jpg');
  assert.equal(song.album.picUrl, 'https://p1.music.126.net/album.jpg');
});

// 假歌单元信息（对齐 normalizePlaylist 输出形状）
function pl(id, trackCount, extra = {}) {
  return {
    id,
    name: extra.name ?? 'pl' + id,
    coverImgUrl: extra.coverImgUrl ?? 'cover' + id,
    trackCount,
    playCount: extra.playCount ?? 0,
    subscribed: extra.subscribed ?? false,
    privacy: extra.privacy ?? 0,
    updateTime: extra.updateTime ?? null,
    creator: extra.creator ?? { id: 1, name: 'me' },
  };
}

// 假歌曲详情（对齐 normalizeSong 输出形状）
function song(id) {
  return {
    id,
    name: 'song' + id,
    durationMs: 200000,
    album: { id: 900 + id, name: 'al' + id, picUrl: 'pic' + id },
    artists: [{ id: 500 + id, name: 'ar' + id }],
    raw: {},
  };
}

// specs: [{ meta, trackIds:[songId...], missing?:Set, throwTracks?:bool }]
function makeFetchers(specs) {
  return {
    async fetchUserPlaylists(_uid, { limit, offset }) {
      const all = specs.map((s) => s.meta);
      const slice = all.slice(offset, offset + limit);
      return { source: 'user_playlist', items: slice, more: offset + limit < all.length };
    },
    async fetchPlaylistTracks(id, { limit, offset }) {
      const spec = specs.find((s) => s.meta.id === id);
      if (!spec) throw new Error('no such playlist ' + id);
      if (spec.throwTracks) throw new Error('曲目抓取失败 ' + id);
      const allIds = spec.trackIds;
      const pageIds = allIds.slice(offset, offset + limit);
      const missing = spec.missing || new Set();
      const items = pageIds.filter((sid) => !missing.has(sid)).map((sid) => song(sid));
      return { source: 'playlist_track_all', playlist: spec.meta, offset, limit, total: allIds.length, trackIds: pageIds, items };
    },
  };
}

function trackRows(db, playlistId) {
  return db
    .prepare('SELECT song_id, position FROM playlist_track WHERE playlist_id=? ORDER BY position')
    .all(playlistId);
}
function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

test('全量替换幂等：同 fetcher 跑两次，行数与内容一致', async () => {
  const db = freshDb();
  const specs = [
    { meta: pl(10, 3), trackIds: [1, 2, 3] },
    { meta: pl(11, 2, { subscribed: true }), trackIds: [4, 5] },
  ];
  const fetchers = makeFetchers(specs);

  const r1 = await collectPlaylists(db, { fetchers, gapMs: 0 });
  assert.equal(r1.status, 'ok');
  assert.equal(r1.playlistCount, 2);
  assert.equal(r1.trackRows, 5);
  assert.equal(count(db, 'playlist'), 2);
  assert.equal(count(db, 'playlist_track'), 5);

  const r2 = await collectPlaylists(db, { fetchers, gapMs: 0 });
  assert.equal(r2.trackRows, 5);
  assert.equal(count(db, 'playlist'), 2); // 无累积
  assert.equal(count(db, 'playlist_track'), 5);
  assert.deepEqual(trackRows(db, 10), [
    { song_id: 1, position: 0 },
    { song_id: 2, position: 1 },
    { song_id: 3, position: 2 },
  ]);
});

test('分页拉全曲目：1200 首分 500/500/200 三页，position 连续 0..1199', async () => {
  const db = freshDb();
  const ids = Array.from({ length: 1200 }, (_, i) => i + 1);
  const fetchers = makeFetchers([{ meta: pl(10, 1200), trackIds: ids }]);

  const r = await collectPlaylists(db, { fetchers, gapMs: 0 });
  assert.equal(r.trackRows, 1200);
  assert.equal(count(db, 'playlist_track'), 1200);
  const rows = trackRows(db, 10);
  assert.equal(rows[0].position, 0);
  assert.equal(rows.at(-1).position, 1199);
  assert.equal(rows[0].song_id, 1);
  assert.equal(rows.at(-1).song_id, 1200);
});

test('删除对账：手机端删歌单/移歌后本地收敛，维度行保留', async () => {
  const db = freshDb();
  await collectPlaylists(db, {
    fetchers: makeFetchers([
      { meta: pl(10, 3), trackIds: [1, 2, 3] },
      { meta: pl(11, 2), trackIds: [4, 5] },
    ]),
    gapMs: 0,
  });
  assert.equal(count(db, 'song'), 5);

  // 次跑：B(11) 消失、A(10) 移走 song2
  await collectPlaylists(db, {
    fetchers: makeFetchers([{ meta: pl(10, 2), trackIds: [1, 3] }]),
    gapMs: 0,
  });

  assert.equal(count(db, 'playlist'), 1);
  assert.deepEqual(
    db.prepare('SELECT id FROM playlist').all().map((r) => r.id),
    [10]
  );
  assert.deepEqual(trackRows(db, 10), [
    { song_id: 1, position: 0 },
    { song_id: 3, position: 1 },
  ]);
  assert.equal(count(db, 'playlist_track'), 2); // 11 的映射也没了
  // 维度表不参与删除（song2/4/5 仍在，可能仍被排行引用）
  assert.equal(count(db, 'song'), 5);
  assert.ok(db.prepare('SELECT 1 FROM song WHERE id=2').get());
});

test('detail 缺歌以 trackIds 脊柱跳过：不给不存在的 song 建 FK', async () => {
  const db = freshDb();
  const fetchers = makeFetchers([{ meta: pl(10, 3), trackIds: [1, 2, 3], missing: new Set([2]) }]);
  const r = await collectPlaylists(db, { fetchers, gapMs: 0 });
  assert.equal(r.status, 'ok');
  // song2 detail 缺失 → 不入 song 表、不建 playlist_track
  assert.deepEqual(trackRows(db, 10), [
    { song_id: 1, position: 0 },
    { song_id: 3, position: 2 }, // position 保真：2 号位空缺
  ]);
  assert.equal(db.prepare('SELECT 1 FROM song WHERE id=2').get(), undefined);
});

test('partial 不落库：某单曲目抓取失败则放弃整次替换，旧数据完好', async () => {
  const db = freshDb();
  // 先成功落一份
  await collectPlaylists(db, { fetchers: makeFetchers([{ meta: pl(10, 3), trackIds: [1, 2, 3] }]), gapMs: 0 });
  assert.equal(count(db, 'playlist_track'), 3);

  // 次跑：曲目抓取抛错
  const r = await collectPlaylists(db, {
    fetchers: makeFetchers([{ meta: pl(10, 3), trackIds: [1, 2, 3], throwTracks: true }]),
    gapMs: 0,
  });
  assert.equal(r.status, 'partial');
  assert.equal(r.failedPlaylists.length, 1);
  assert.equal(r.failedPlaylists[0].id, 10);
  // 未发生破坏性写：旧的完整数据仍在
  assert.equal(count(db, 'playlist'), 1);
  assert.equal(count(db, 'playlist_track'), 3);
});

test('列表抓取失败：status=fail 且绝不碰 DB', async () => {
  const db = freshDb();
  const fetchers = {
    async fetchUserPlaylists() {
      throw new Error('列表限流');
    },
    async fetchPlaylistTracks() {
      throw new Error('不应被调用');
    },
  };
  const r = await collectPlaylists(db, { fetchers, gapMs: 0 });
  assert.equal(r.status, 'fail');
  assert.equal(r.stage, 'list');
  assert.equal(count(db, 'playlist'), 0);
});

test('空歌单不打网络仍落一行 playlist', async () => {
  const db = freshDb();
  let trackCalls = 0;
  const fetchers = makeFetchers([{ meta: pl(10, 0), trackIds: [] }]);
  const wrapped = {
    fetchUserPlaylists: fetchers.fetchUserPlaylists,
    fetchPlaylistTracks: async (...a) => {
      trackCalls++;
      return fetchers.fetchPlaylistTracks(...a);
    },
  };
  const r = await collectPlaylists(db, { fetchers: wrapped, gapMs: 0 });
  assert.equal(r.status, 'ok');
  assert.equal(trackCalls, 0); // trackCount=0 跳过网络
  assert.equal(count(db, 'playlist'), 1);
  assert.equal(count(db, 'playlist_track'), 0);
});

test('queries.userPlaylists / playlistTracks 返回形状与分页', async () => {
  const db = freshDb();
  await collectPlaylists(db, {
    fetchers: makeFetchers([
      { meta: pl(10, 3, { playCount: 99 }), trackIds: [1, 2, 3] },
      { meta: pl(11, 1, { subscribed: true }), trackIds: [4] },
    ]),
    gapMs: 0,
  });

  const list = userPlaylists(db, { limit: 30, offset: 0 });
  assert.equal(list.total, 2);
  assert.equal(list.more, false);
  assert.deepEqual(
    list.items.map((p) => p.id),
    [10, 11]
  ); // 按 list_position
  assert.deepEqual(list.items[0], {
    id: 10,
    name: 'pl10',
    coverImgUrl: 'cover10',
    trackCount: 3,
    playCount: 99,
    subscribed: false,
    privacy: 0,
    updateTime: null,
    creator: { id: 1, name: 'me' },
  });
  assert.equal(list.items[1].subscribed, true);

  const tracks = playlistTracks(db, 10, { limit: 20, offset: 0 });
  assert.equal(tracks.playlist.name, 'pl10');
  assert.equal(tracks.total, 3);
  assert.equal(tracks.items.length, 3);
  assert.deepEqual(tracks.items[0], {
    id: 1,
    name: 'song1',
    artists: [{ id: 501, name: 'ar1' }],
    album: { id: 901, name: 'al1', picUrl: 'pic1' },
  });

  // 分页：limit=2 offset=1 → 取 position 1,2（song2,song3）
  const page = playlistTracks(db, 10, { limit: 2, offset: 1 });
  assert.deepEqual(
    page.items.map((s) => s.id),
    [2, 3]
  );
});

test('fetchUserPlaylists 退避重试：失败两次后成功（retries=[0,0,0]）', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 3) throw new Error('network boom');
    return {
      ok: true,
      json: async () => ({
        code: 200,
        playlist: [{ id: 7, name: 'x', coverImgUrl: 'c', trackCount: 0, playCount: 0 }],
        more: false,
      }),
    };
  };
  try {
    const res = await fetchUserPlaylists('123', { retries: [0, 0, 0] });
    assert.equal(calls, 3);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].id, 7);
  } finally {
    globalThis.fetch = realFetch;
  }
});
