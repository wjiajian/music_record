// 探针采样器。
//   单发(默认)：抓一次，写 probe_fetch + probe。被任务计划器每 30 分钟调用，或手动跑。
//   --watch    ：自循环，无需任务计划器。每轮读 stimulus 表，刺激窗口内自动加密采样(DB 当 IPC)。
//   --burst=N  ：每次采样连抓 N 次(间隔 --gap ms)，把删失区间压窄(阶段2 细扫)。
import { getDb, initSchema, closeDb } from '../db/index.js';
import { ensureProbeTables } from './ensure.js';
import { fetchUserRecordRaw } from '../netease/client.js';
import { requireUid } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 同时支持 --key=value 与 --key value（空格）两种写法
function parseArgs(argv) {
  const o = { watch: false, burst: 1, gapMs: 1500, intervalMin: 30, denseMin: 2, leadMin: 15, windowMin: 90, forHours: null, until: null };
  for (let i = 0; i < argv.length; i++) {
    let k = argv[i];
    let v;
    if (k.includes('=')) [k, v] = k.split('=');
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) v = argv[++i];
    else v = true;
    const numOr = (d) => (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
    if (k === '--watch') o.watch = v !== 'false';
    else if (k === '--burst') o.burst = Math.max(1, numOr(1));
    else if (k === '--gap') o.gapMs = Math.max(300, numOr(1500));
    else if (k === '--interval') o.intervalMin = Math.max(1, numOr(30));
    else if (k === '--dense') o.denseMin = Math.max(1, numOr(2));
    else if (k === '--lead') o.leadMin = Math.max(0, numOr(15));
    else if (k === '--window') o.windowMin = Math.max(1, numOr(90));
    else if (k === '--for') o.forHours = typeof v === 'string' && v !== '' ? Number(v) : null;
    else if (k === '--until') o.until = typeof v === 'string' && v !== '' && v !== 'true' ? v : null;
  }
  return o;
}

// 落库一次抓取（成功失败都记 probe_fetch；成功才写 probe 明细）
function persistFetch(db, r) {
  const fetchedAt = r.respRecvAt;
  const dateMs = r.headers.date ? Date.parse(r.headers.date) : NaN; // Date 头可能缺失/异常
  const recvMs = Date.parse(r.respRecvAt);
  const serverDate = Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : null;
  const skewMs = Number.isFinite(dateMs) && Number.isFinite(recvMs) ? dateMs - recvMs : null;
  const ok = r.code === 200 && r.items.length ? 1 : 0;
  const minPc = r.items.length ? Math.min(...r.items.map((x) => x.playCount)) : null;
  const maxRank = r.items.length ? Math.max(...r.items.map((x) => x.rank)) : null;

  db.prepare(
    `INSERT OR REPLACE INTO probe_fetch
     (fetched_at,req_sent_at,resp_recv_at,rtt_ms,http_status,api_code,server_date,skew_ms,age,x_cache,item_count,min_play_count,max_rank,ok,err)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    fetchedAt, r.reqSentAt, r.respRecvAt, r.rttMs, r.httpStatus, r.code,
    serverDate, skewMs, r.headers.age != null ? Number(r.headers.age) : null, r.headers.xCache ?? null,
    r.items.length, minPc, maxRank, ok, r.err ?? null
  );

  if (ok) {
    const ins = db.prepare('INSERT OR REPLACE INTO probe(fetched_at,song_id,play_count,rank) VALUES(?,?,?,?)');
    for (const it of r.items) ins.run(fetchedAt, it.song.id, it.playCount, it.rank ?? null);
  }
  return ok;
}

// 一次采样（可能是 burst N 连抓）
async function sample(db, uid, burst, gapMs) {
  for (let i = 0; i < burst; i++) {
    const r = await fetchUserRecordRaw(uid, 0);
    const ok = persistFetch(db, r);
    if (!ok) console.warn(`[probe] ${r.respRecvAt} 抓取异常：code=${r.code} ${r.err || ''}`);
    if (i < burst - 1) await sleep(gapMs);
  }
}

// watch 模式：当前是否落在某个刺激的 [t0-lead, t0+window] 窗口内 → 加密采样
function isDense(db, o) {
  const now = Date.now();
  const rows = db.prepare('SELECT t0 FROM stimulus').all();
  return rows.some((row) => {
    const t = Date.parse(row.t0);
    if (Number.isNaN(t)) return false;
    return now >= t - o.leadMin * 60000 && now <= t + o.windowMin * 60000;
  });
}

async function main() {
  const uid = requireUid();
  const o = parseArgs(process.argv.slice(2));
  const db = initSchema(getDb());
  ensureProbeTables(db);

  if (!o.watch) {
    await sample(db, uid, o.burst, o.gapMs);
    const n = db.prepare('SELECT COUNT(*) AS n FROM probe_fetch').get().n;
    console.log(`[probe] 单发完成（burst=${o.burst}），probe_fetch 累计 ${n} 行`);
    closeDb();
    return;
  }

  const startMs = Date.now();
  const endMs = o.until ? Date.parse(o.until) : o.forHours ? startMs + o.forHours * 3600000 : Infinity;
  let stop = false;
  process.on('SIGINT', () => {
    console.log('\n[probe] 收到中断，准备退出…');
    stop = true;
  });
  console.log(`[probe] watch 启动：粗 ${o.intervalMin}min / 密 ${o.denseMin}min（刺激窗口内）/ burst ${o.burst}，${o.until ? '至 ' + o.until : o.forHours ? o.forHours + 'h 后停' : '无限'}`);

  while (!stop && Date.now() < endMs) {
    try {
      await sample(db, uid, o.burst, o.gapMs);
    } catch (e) {
      console.warn('[probe] 采样失败（已记录，继续）：', e?.message || e);
    }
    const dense = isDense(db, o);
    const sleepMs = (dense ? o.denseMin : o.intervalMin) * 60000;
    // 分段 sleep，便于及时响应 SIGINT 与到点退出
    const wakeAt = Date.now() + sleepMs;
    while (!stop && Date.now() < wakeAt && Date.now() < endMs) await sleep(Math.min(2000, wakeAt - Date.now()));
  }
  console.log('[probe] watch 结束');
  closeDb();
}

main().catch((e) => {
  console.error('[probe] 致命错误：', e?.message || e);
  process.exitCode = 1;
});
