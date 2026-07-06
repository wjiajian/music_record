// 调度器「下一个触发时刻」纯函数单测：跨午夜、当天已过点、正好等点。
import test from 'node:test';
import assert from 'node:assert';
import { DateTime } from 'luxon';
import { nextRunDelayMs } from '../src/collector/scheduler.js';

const TZ = 'Asia/Shanghai';
// 构造某个本地时刻的毫秒时间戳
function localMs(iso) {
  return DateTime.fromISO(iso, { zone: TZ }).toMillis();
}

test('当天尚未到点：延迟到今天该时刻', () => {
  const now = localMs('2026-07-06T01:30:00'); // 01:30，目标 04:00
  const delay = nextRunDelayMs(now, '04:00', TZ);
  assert.equal(delay, localMs('2026-07-06T04:00:00') - now);
  assert.equal(delay, 150 * 60000); // 2.5h
});

test('当天已过点：延迟到次日该时刻（跨午夜）', () => {
  const now = localMs('2026-07-06T09:00:00'); // 09:00 已过 04:00
  const delay = nextRunDelayMs(now, '04:00', TZ);
  assert.equal(delay, localMs('2026-07-07T04:00:00') - now);
});

test('正好等于目标时刻：视为已过，排到次日（避免 0 延迟空转）', () => {
  const now = localMs('2026-07-06T04:00:00');
  const delay = nextRunDelayMs(now, '04:00', TZ);
  assert.equal(delay, localMs('2026-07-07T04:00:00') - now);
  assert.equal(delay, 24 * 3600000);
});

test('支持任意 HH:mm（含分钟）', () => {
  const now = localMs('2026-07-06T00:00:00');
  const delay = nextRunDelayMs(now, '23:45', TZ);
  assert.equal(delay, localMs('2026-07-06T23:45:00') - now);
});

test('延迟恒为正数（不会返回负或 0）', () => {
  for (const h of ['00:00', '04:00', '12:30', '23:59']) {
    for (const t of ['2026-07-06T00:00:00', '2026-07-06T12:00:00', '2026-07-06T23:59:59']) {
      const delay = nextRunDelayMs(localMs(t), h, TZ);
      assert.ok(delay > 0, `delay 应为正：at=${h} now=${t} got=${delay}`);
      assert.ok(delay <= 24 * 3600000, `delay 不应超过 24h：at=${h} now=${t} got=${delay}`);
    }
  }
});
