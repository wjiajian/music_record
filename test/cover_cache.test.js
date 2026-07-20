import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoverCacheError, createCoverCache, normalizeCoverSource } from '../src/api/coverCache.js';

test('封面缓存统一使用 HTTPS 和 160px 网易云图片', () => {
  const source = normalizeCoverSource('http://p1.music.126.net/example.jpg?foo=bar&param=40y40');
  assert.equal(source.protocol, 'https:');
  assert.equal(source.searchParams.get('param'), '160y160');
  assert.equal(source.searchParams.has('foo'), false);
});

test('封面缓存拒绝非网易云域名', () => {
  assert.throws(
    () => normalizeCoverSource('https://example.test/cover.jpg'),
    (error) => error instanceof CoverCacheError && error.code === 'unsupported_cover_host'
  );
});

test('封面首次从上游获取，后续命中磁盘缓存', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-cover-cache-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const calls = [];
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const cache = createCoverCache({
    cacheDir,
    fetchImpl: async (url) => {
      calls.push(url.href);
      return new Response(image, { status: 200, headers: { 'content-type': 'image/jpg' } });
    },
  });

  const first = await cache.get('https://p1.music.126.net/example.jpg');
  const second = await cache.get('https://p1.music.126.net/example.jpg');

  assert.equal(first.cacheStatus, 'MISS');
  assert.equal(second.cacheStatus, 'HIT');
  assert.equal(calls.length, 1);
  assert.deepEqual(first.body, image);
  assert.equal(first.contentType, 'image/jpeg');
  assert.equal(first.etag, second.etag);
});

test('过期封面刷新失败时继续提供旧缓存', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-cover-stale-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  let clock = 1_000_000;
  let fail = false;
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const cache = createCoverCache({
    cacheDir,
    ttlMs: 60_000,
    now: () => clock,
    fetchImpl: async () => {
      if (fail) throw new Error('network down');
      return new Response(image, { status: 200, headers: { 'content-type': 'image/png' } });
    },
  });

  await cache.get('https://p2.music.126.net/example.png');
  clock += 60_001;
  fail = true;
  const stale = await cache.get('https://p2.music.126.net/example.png');
  assert.equal(stale.cacheStatus, 'STALE');
  assert.deepEqual(stale.body, image);
});
