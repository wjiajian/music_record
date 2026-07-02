// 纯函数：把一次刺激与某歌的 probe 序列关联，算出可见延迟区间；判机制；给 cron 建议。
// 全部不依赖 IO/luxon（时区换算由调用方以函数注入），便于 node --test 回归。

// seq: [{ t:ms, pc:number }] 升序（同一首歌）
// s:   { t0Ms, t0DoneMs, expectedK, baselinePc, label, kind }
export function correlateStimulus(seq, s) {
  const anchor = s.t0DoneMs ?? s.t0Ms; // 头条延迟以「K 次放完」为锚
  const before = seq.filter((x) => x.t <= s.t0Ms);
  const base = s.baselinePc != null ? s.baselinePc : before.length ? before[before.length - 1].pc : null;
  const out = { label: s.label, kind: s.kind, expected: s.expectedK, base };
  if (base == null) return { ...out, warn: '刺激前无基线样本' };

  const after = seq.filter((x) => x.t > s.t0Ms);
  if (!after.length) return { ...out, warn: '刺激后无采样' };

  const firstIdx = after.findIndex((x) => x.pc - base >= 1);
  if (firstIdx === -1) return { ...out, warn: '未观测到增长（未传播？或歌掉出 top~100？）' };

  // 单调-驻留：首个达到 base+expectedK 且其后样本不回退（排除 CDN 缓存「闪现又回退」伪命中）
  let fullIdx = -1;
  for (let i = firstIdx; i < after.length; i++) {
    if (after[i].pc - base >= s.expectedK) {
      const dwell = after.slice(i + 1, i + 3);
      // 至少要有 1 个后续样本佐证「不回退」，否则无法排除 CDN 闪现，保守地不算稳定
      if (dwell.length >= 1 && dwell.every((x) => x.pc >= after[i].pc)) {
        fullIdx = i;
        break;
      }
    }
  }
  const reachedK = fullIdx !== -1;
  if (!reachedK) fullIdx = after.length - 1; // 未稳定达到 K：取末样本，delta<K 会被标注

  const prev = firstIdx > 0 ? after[firstIdx - 1] : before.length ? before[before.length - 1] : null;
  const delta = after[fullIdx].pc - base;
  return {
    ...out,
    delta,
    reachedK,
    fidelity: s.expectedK ? Math.round((delta / s.expectedK) * 100) / 100 : null, // 计数保真度
    pattern: firstIdx === fullIdx ? 'step' : 'gradual',
    loMs: prev ? Math.max(0, prev.t - anchor) : 0, // 删失下界（延迟至少这么多）
    hiFirstMs: after[firstIdx].t - anchor, // 首次出现 +1 的上界
    hiFullMs: after[fullIdx].t - anchor, // 稳定达到 +K 的上界（用于定 cron）
    appearAt: after[firstIdx].t,
    fullAt: after[fullIdx].t,
  };
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// results: correlateStimulus 的产出（只取有 hiFullMs 的）
// todMinOf(ms) -> 该时刻在本地时区的「一日内分钟数」(0..1439)，由调用方注入(luxon)
// 判据：相对 t0 的偏移离散度 << 出现钟点离散度 → 近实时；反之 → 定时批刷
export function classifyMode(results, todMinOf) {
  const valid = results.filter((r) => r.hiFullMs != null && r.reachedK);
  if (valid.length < 2) {
    return { mode: 'unknown', reason: '有效样本 < 2，无法判机制', lHiMs: valid[0]?.hiFullMs ?? null, medianMs: valid[0]?.hiFullMs ?? null };
  }
  const offsets = valid.map((r) => r.hiFullMs);
  const tod = valid.map((r) => todMinOf(r.fullAt));
  const offStdMin = stdev(offsets) / 60000;
  const todStdMin = stdev(tod);
  return {
    mode: offStdMin <= todStdMin ? 'realtime' : 'batch',
    offsetStdMin: Math.round(offStdMin * 10) / 10,
    todStdMin: Math.round(todStdMin * 10) / 10,
    lHiMs: Math.max(...offsets),
    medianMs: median(offsets),
    n: valid.length,
  };
}

// 把机制判定翻译成 cron 时刻 + ATTRIBUTION 建议
export function recommend(cls, { marginMin = 10 } = {}) {
  if (!cls || cls.lHiMs == null) return { ok: false, reason: '无足够数据给建议' };
  if (cls.mode === 'unknown') return { ok: false, reason: '机制未定（有效样本 < 2），需在不同钟点补做刺激再下结论' };
  if (cls.mode === 'batch') {
    return {
      ok: true,
      attribution: 'prev',
      cronLocal: null,
      note: '定时批刷：把 cron 设在实测批刷钟点之后 15~30 分钟；ATTRIBUTION=prev；日级归属不确定度上升（diff 会更频繁标 estimated）。',
    };
  }
  const lHiMin = cls.lHiMs / 60000;
  let mins = Math.max(5, Math.ceil(lHiMin) + marginMin); // 用上界+裕度，不用中位数
  const cronLocal = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  return {
    ok: true,
    mode: 'realtime',
    attribution: 'prev',
    cronLocal,
    lHiMin: Math.round(lHiMin * 10) / 10,
    medianMin: cls.medianMs != null ? Math.round((cls.medianMs / 60000) * 10) / 10 : null,
    note: `近实时：cron = 00:00 + ceil(延迟上界 ${Math.round(lHiMin)}min) + 裕度 ${marginMin}min ≈ ${cronLocal}，ATTRIBUTION=prev（增量归前一天）。`,
  };
}
