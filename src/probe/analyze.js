// 分析探针数据：自动算延迟、判机制、识别缓存/时钟问题，直出 ATTRIBUTION + cron 建议。
import { DateTime } from 'luxon';
import { getDb, initSchema, closeDb } from '../db/index.js';
import { ensureProbeTables } from './ensure.js';
import { correlateStimulus, classifyMode, recommend, median } from './correlate.js';
import { config } from '../config.js';

const fmt = (ms) => (ms == null ? '?' : `${Math.round((ms / 60000) * 10) / 10}min`);
const localOf = (iso) => DateTime.fromISO(iso, { zone: 'utc' }).setZone(config.tz).toFormat('MM-dd HH:mm:ss');
const todMinOf = (ms) => {
  const d = DateTime.fromMillis(ms, { zone: 'utc' }).setZone(config.tz); // ms 是绝对时刻，显式锚到 UTC 再转本地
  return d.hour * 60 + d.minute;
};

function main() {
  const db = initSchema(getDb());
  ensureProbeTables(db);

  const fetches = db.prepare('SELECT * FROM probe_fetch ORDER BY fetched_at').all();
  const probeRows = db.prepare('SELECT fetched_at,song_id,play_count,rank FROM probe ORDER BY song_id, fetched_at').all();
  const stimuli = db.prepare('SELECT * FROM stimulus ORDER BY id').all();

  if (!fetches.length && !probeRows.length) {
    console.log('probe 数据为空。先起探针：npm run probe:watch -- --for 72（或用任务计划器每 30min 跑 npm run probe）');
    closeDb();
    return;
  }

  // ---- 1) 采样概况 + 时钟/缓存 ----
  console.log('========== 采样概况 ==========');
  console.log(`probe_fetch ${fetches.length} 次，probe 明细 ${probeRows.length} 行，刺激 ${stimuli.length} 个`);
  if (fetches.length) {
    const span = `${localOf(fetches[0].fetched_at)} ~ ${localOf(fetches[fetches.length - 1].fetched_at)}`;
    const fails = fetches.filter((f) => !f.ok).length;
    const skews = fetches.filter((f) => f.skew_ms != null).map((f) => f.skew_ms);
    const hits = fetches.filter((f) => (f.x_cache || '').toUpperCase().includes('HIT')).length;
    const ages = fetches.filter((f) => f.age != null && f.age > 0).length;
    console.log(`跨度 ${span}；失败 ${fails} 次`);
    if (skews.length) {
      const sk = median(skews) / 1000;
      const skMax = Math.max(...skews.map(Math.abs)) / 1000;
      console.log(`本地↔服务器时钟偏差 中位 ${Math.round(sk * 10) / 10}s（|max| ${Math.round(skMax * 10) / 10}s）${skMax > 120 ? ' ⚠ 偏差>2min，会污染分钟级延迟，先校时(w32tm /resync)' : ''}`);
    }
    if (hits || ages) console.log(`⚠ CDN 缓存迹象：X-Cache=HIT ${hits} 次、Age>0 ${ages} 次 —— 有效新鲜度可能滞后，cron 需再后推或加 cache-bust`);
    else console.log('未见明显 CDN 缓存命中（X-Cache 多为 MISS / Age=0）');
  }

  // ---- 2) 单调性（生产 diff 会静默 clamp 的那部分）----
  const bySong = new Map();
  for (const r of probeRows) {
    if (!bySong.has(r.song_id)) bySong.set(r.song_id, []);
    bySong.get(r.song_id).push({ t: Date.parse(r.fetched_at), pc: r.play_count, rank: r.rank });
  }
  let drops = 0;
  for (const seq of bySong.values()) for (let i = 1; i < seq.length; i++) if (seq[i].pc < seq[i - 1].pc) drops++;
  console.log(`\n累计 playCount 回退事件：${drops}${drops ? ' ✗（最终一致性/缓存抖动，生产 diff 会 clamp 丢弃，需把 cron 推到值稳定后）' : ' ✓（单调）'}`);

  // ---- 3) 刺激关联 → 延迟 ----
  if (!stimuli.length) {
    console.log('\n（尚无刺激记录，无法自动算延迟。用 npm run stimulus -- begin --song <id> --k 7 登记刺激后再分析。）');
    closeDb();
    return;
  }
  console.log('\n========== 刺激延迟 ==========');
  const results = [];
  for (const s of stimuli) {
    const seq = bySong.get(s.song_id) || [];
    const res = correlateStimulus(seq, {
      t0Ms: Date.parse(s.t0),
      t0DoneMs: s.t0_done ? Date.parse(s.t0_done) : null,
      expectedK: s.expected_k,
      baselinePc: s.baseline_pc,
      label: s.label || `#${s.id}`,
      kind: s.kind,
    });
    results.push({ s, res });
    if (res.warn) {
      console.log(`#${s.id} ${res.label} [${s.kind}] song=${s.song_id}：${res.warn}`);
      continue;
    }
    console.log(
      `#${s.id} ${res.label} [${s.kind}] song=${s.song_id}：` +
        `delta=${res.delta}/K=${res.expected}(保真${res.fidelity}) ${res.pattern} ` +
        `延迟∈[${fmt(res.loMs)}, ${fmt(res.hiFullMs)}] 首现${fmt(res.hiFirstMs)} ` +
        `稳定于 ${localOf(new Date(res.fullAt).toISOString())}` +
        `${res.reachedK ? '' : ' ⚠未稳定达到K'}`
    );
  }

  // ---- 4) 机制判定 + 建议 ----
  const good = results.map((r) => r.res).filter((r) => !r.warn && r.reachedK);
  console.log('\n========== 机制与建议 ==========');
  if (!good.length) {
    console.log('没有「稳定达到 K」的有效刺激，无法判机制。检查：歌是否在榜、是否真放满 K 次、探针是否覆盖了刺激后时段。');
    closeDb();
    return;
  }
  const cls = classifyMode(good, todMinOf);
  if (cls.mode === 'unknown') console.log(`机制：未定（${cls.reason}）。建议在不同钟点补做刺激（早/午/深夜各一）以区分近实时 vs 批刷。`);
  else console.log(`机制：${cls.mode === 'realtime' ? '近实时' : '定时批刷'}（偏移离散 ${cls.offsetStdMin}min vs 钟点离散 ${cls.todStdMin}min，n=${cls.n}）`);
  console.log(`延迟：上界 ${fmt(cls.lHiMs)}，中位 ${fmt(cls.medianMs)}`);

  const rec = recommend(cls);
  if (rec.ok) {
    console.log(`\n>>> 建议 ATTRIBUTION = ${rec.attribution}`);
    if (rec.cronLocal) {
      console.log(`>>> 建议 cron 抓取时刻 = ${rec.cronLocal}（本地 ${config.tz}）`);
      console.log(`>>> 可直接粘贴的每日任务（先建好 scripts\\collect.cmd 注入 NETEASE_UID/ATTRIBUTION）：`);
      console.log(`    schtasks /Create /TN "music_record_daily" /SC DAILY /ST ${rec.cronLocal} /TR "D:\\Project\\music_record\\scripts\\collect.cmd" /F`);
    }
    console.log(`说明：${rec.note}`);
  }

  // 跨午夜专项
  const mid = results.filter((r) => r.s.kind === 'midnight' && !r.res.warn);
  if (mid.length) {
    console.log('\n---------- 跨午夜验收 ----------');
    for (const { s, res } of mid) {
      console.log(`#${s.id} ${res.label}：t0=${localOf(s.t0)} → 首次可见 ${localOf(new Date(res.appearAt).toISOString())}（核对它落在你拟定 cron 时刻的哪一侧，决定 prev/same 是否安全）`);
    }
  }
  closeDb();
}

main();
