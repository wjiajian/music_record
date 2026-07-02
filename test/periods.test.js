// 日期/周期/ISO 周边界单测。
import test from 'node:test';
import assert from 'node:assert';
import { resolvePeriod, dayDiff, buckets, gapDates } from '../src/aggregate/periods.js';

test('week 解析为 周一..周日（ISO），end-start=6 天', () => {
  const r = resolvePeriod('week', '2026-06-29'); // 周一
  assert.equal(r.start, '2026-06-29');
  assert.equal(r.end, '2026-07-05');
  assert.equal(r.label, '2026-W27');
  assert.equal(dayDiff(r.end, r.start), 6);
});

test('跨年周用 weekYear（2026-12-31 属于 2026-W53 或 2027-W01）', () => {
  const r = resolvePeriod('week', '2026-12-31');
  assert.match(r.label, /^\d{4}-W\d{2}$/);
  // anchor 落在 [start,end] 内
  assert.ok(r.start <= '2026-12-31' && '2026-12-31' <= r.end);
});

test('month / year 解析', () => {
  assert.deepEqual(
    { s: resolvePeriod('month', '2026-02-15').start, e: resolvePeriod('month', '2026-02-15').end, l: resolvePeriod('month', '2026-02-15').label },
    { s: '2026-02-01', e: '2026-02-28', l: '2026-02' }
  );
  const y = resolvePeriod('year', '2026-08-08');
  assert.deepEqual([y.start, y.end, y.label], ['2026-01-01', '2026-12-31', '2026']);
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
