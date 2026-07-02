// weapi 加密形状校验（不发网络，纯本地）。
import test from 'node:test';
import assert from 'node:assert';
import { eapi, weapi } from '../src/netease/crypto.js';

test('weapi 产出 params(base64) 与 encSecKey(256 位十六进制)', () => {
  const { params, encSecKey } = weapi({ uid: '123', type: 0 });
  assert.ok(typeof params === 'string' && params.length > 0);
  assert.equal(encSecKey.length, 256);
  assert.match(encSecKey, /^[0-9a-f]+$/);
  // base64 合法性
  assert.doesNotThrow(() => Buffer.from(params, 'base64'));
});

test('每次随机 secretKey → encSecKey 不同（params 也不同）', () => {
  const a = weapi({ uid: '1', type: 0 });
  const b = weapi({ uid: '1', type: 0 });
  assert.notEqual(a.encSecKey, b.encSecKey);
});

test('eapi 产出十六进制 params', () => {
  const { params } = eapi('/api/content/activity/listen/data/today/song/play/rank', { header: { os: 'pc' } });
  assert.ok(typeof params === 'string' && params.length > 0);
  assert.equal(params.length % 32, 0);
  assert.match(params, /^[0-9A-F]+$/);
});
