// correlate 纯函数单测：延迟区间、单调-驻留排除缓存闪现、机制判定、cron 建议。
import test from 'node:test';
import assert from 'node:assert';
import { correlateStimulus, classifyMode, recommend, median } from '../src/probe/correlate.js';

const MIN = 60000;
// 以某基准 ms 造序列；t 用「相对分钟」表达更直观
const T0 = 1_000_000_000_000;
const at = (min, pc) => ({ t: T0 + min * MIN, pc });

test('近实时 step：延迟区间与 delta 正确', () => {
  // t0=0min, 放完 t0_done=1min；基线 100；探针每 2min 一采，6min 时跳到 107
  const seq = [at(-2, 100), at(0, 100), at(2, 100), at(4, 100), at(6, 107), at(8, 107)];
  const r = correlateStimulus(seq, { t0Ms: T0, t0DoneMs: T0 + 1 * MIN, expectedK: 7, baselinePc: 100, label: 'A', kind: 'latency' });
  assert.equal(r.delta, 7);
  assert.equal(r.reachedK, true);
  assert.equal(r.pattern, 'step');
  // 锚=1min；首现=6min → hiFull=5min；前一个无增长样本=4min → lo=3min
  assert.equal(Math.round(r.hiFullMs / MIN), 5);
  assert.equal(Math.round(r.loMs / MIN), 3);
});

test('单调-驻留排除 CDN 闪现：107→100→107 取稳定的后者', () => {
  const seq = [at(0, 100), at(2, 107), at(4, 100), at(6, 107), at(8, 107)];
  const r = correlateStimulus(seq, { t0Ms: T0, t0DoneMs: T0, expectedK: 7, baselinePc: 100, label: 'B', kind: 'latency' });
  assert.equal(r.reachedK, true);
  // 闪现的 2min 被驻留检查否决，稳定点是 6min
  assert.equal(Math.round(r.fullAt - T0) / MIN, 6);
  assert.equal(r.delta, 7);
});

test('gradual：分两次涨到 K', () => {
  const seq = [at(0, 100), at(2, 103), at(4, 107), at(6, 107)];
  const r = correlateStimulus(seq, { t0Ms: T0, t0DoneMs: T0, expectedK: 7, baselinePc: 100, label: 'C', kind: 'latency' });
  assert.equal(r.pattern, 'gradual');
  assert.equal(r.delta, 7);
});

test('未观测到增长 → warn', () => {
  const seq = [at(0, 100), at(2, 100), at(4, 100)];
  const r = correlateStimulus(seq, { t0Ms: T0, t0DoneMs: T0, expectedK: 7, baselinePc: 100, label: 'D', kind: 'latency' });
  assert.ok(r.warn);
});

test('classifyMode 近实时：偏移离散 < 钟点离散', () => {
  // 两个刺激延迟都≈5min，但出现在不同钟点 → realtime
  const good = [
    { hiFullMs: 5 * MIN, reachedK: true, fullAt: T0 + 5 * MIN },
    { hiFullMs: 6 * MIN, reachedK: true, fullAt: T0 + 5 * MIN + 8 * 3600 * 1000 }, // 8 小时后
  ];
  const todMinOf = (ms) => Math.floor((ms / MIN) % 1440); // 简化的一日内分钟
  const cls = classifyMode(good, todMinOf);
  assert.equal(cls.mode, 'realtime');
  assert.equal(cls.lHiMs, 6 * MIN);
});

test('recommend：近实时 → cron=ceil(上界)+裕度, prev', () => {
  const rec = recommend({ mode: 'realtime', lHiMs: 18 * MIN, medianMs: 12 * MIN }, { marginMin: 10 });
  assert.equal(rec.attribution, 'prev');
  assert.equal(rec.cronLocal, '00:28'); // ceil(18)+10=28min
});

test('末样本达到K但无后续驻留样本 → 保守地不算稳定(reachedK=false)', () => {
  const seq = [at(0, 100), at(2, 100), at(4, 107)]; // 107 是最后一个样本，无从佐证不回退
  const r = correlateStimulus(seq, { t0Ms: T0, t0DoneMs: T0, expectedK: 7, baselinePc: 100, label: 'E', kind: 'latency' });
  assert.equal(r.reachedK, false);
});

test('recommend 对 unknown 机制拒绝出建议', () => {
  const rec = recommend({ mode: 'unknown', lHiMs: 5 * MIN, medianMs: 5 * MIN });
  assert.equal(rec.ok, false);
});

test('median 基本正确', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});
