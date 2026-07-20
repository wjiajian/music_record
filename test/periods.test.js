// 日期/周期/ISO 周边界单测。
import test from 'node:test';
import assert from 'node:assert';
import { resolvePeriod, dayDiff, buckets, gapDates } from '../src/aggregate/periods.js';

test('week 解析为包含锚点的滚动近 7 天', () => {
  const r = resolvePeriod('week', '2026-07-20');
  assert.equal(r.start, '2026-07-14');
  assert.equal(r.end, '2026-07-20');
  assert.equal(r.label, '2026-07-14..2026-07-20');
  assert.equal(dayDiff(r.end, r.start), 6);
});

test('滚动 7 天支持跨年', () => {
  const r = resolvePeriod('week', '2026-12-31');
  assert.equal(r.start, '2026-12-25');
  assert.equal(r.end, '2026-12-31');
});

test('month / year 分别解析为滚动 30 / 365 天', () => {
  assert.deepEqual(
    { s: resolvePeriod('month', '2026-02-15').start, e: resolvePeriod('month', '2026-02-15').end, l: resolvePeriod('month', '2026-02-15').label },
    { s: '2026-01-17', e: '2026-02-15', l: '2026-01-17..2026-02-15' }
  );
  const y = resolvePeriod('year', '2026-08-08');
  assert.equal(y.end, '2026-08-08');
  assert.equal(dayDiff(y.end, y.start), 364);
});

test('dayDiff 与 gapDates', () => {
  assert.equal(dayDiff('2026-03-01', '2026-02-28'), 1);
  assert.equal(dayDiff('2026-01-01', '2026-01-01'), 0);
  assert.deepEqual(gapDates(['2026-01-01', '2026-01-04']), ['2026-01-02', '2026-01-03']);
  assert.deepEqual(gapDates(['2026-01-01']), []);
});

test('buckets 按天切分 [from,to]', () => {
  const bs = buckets('day', '2026-01-01', '2026-01-03');
  assert.equal(bs.length, 3);
  assert.deepEqual(bs.map((b) => b.bucket), ['2026-01-01', '2026-01-02', '2026-01-03']);
});
