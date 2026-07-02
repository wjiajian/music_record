// 刺激登记 CLI：把「已知刺激法」的 t0 交给机器记录，消除人工对时。
//   verify --song <id>           选刺激歌前，确认它在 allData top~100、距截断线有余量
//   begin  --song <id> --k <K>   登记刺激起点(机器记 t0 + 抓基线 playCount)，返回 id
//   end    --id <id>             记 K 次放完的时刻 t0_done（头条延迟的锚）
//   list                         列出全部刺激
import { DateTime } from 'luxon';
import { getDb, initSchema, closeDb } from '../db/index.js';
import { ensureProbeTables } from './ensure.js';
import { fetchUserRecordRaw } from '../netease/client.js';
import { requireUid, config } from '../config.js';

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      o[k] = v;
    } else o._.push(a);
  }
  return o;
}

function nowUtcISO() {
  return new Date().toISOString();
}

async function main() {
  const sub = process.argv[2];
  const o = parseArgs(process.argv.slice(3));
  const db = initSchema(getDb());
  ensureProbeTables(db);

  if (sub === 'list') {
    const rows = db.prepare('SELECT id,song_id,t0,t0_done,expected_k,baseline_pc,kind,label FROM stimulus ORDER BY id').all();
    if (!rows.length) console.log('（无刺激记录）');
    for (const r of rows) {
      const localT0 = DateTime.fromISO(r.t0, { zone: 'utc' }).setZone(config.tz).toFormat('MM-dd HH:mm:ss');
      console.log(
        `#${r.id} ${r.kind} song=${r.song_id} K=${r.expected_k} base=${r.baseline_pc ?? '?'} t0=${localT0}(本地)` +
          `${r.t0_done ? ' done✓' : ' 未end'} ${r.label ? '[' + r.label + ']' : ''}`
      );
    }
    closeDb();
    return;
  }

  const uid = requireUid();

  if (sub === 'verify') {
    const songId = typeof o.song === 'string' ? Number(o.song) : NaN;
    if (!songId || Number.isNaN(songId)) throw new Error('用法：stimulus verify --song <id>');
    const r = await fetchUserRecordRaw(uid, 0);
    if (r.code !== 200 || !r.items.length) throw new Error(`抓取失败 code=${r.code} ${r.err || ''}`);
    const it = r.items.find((x) => x.song.id === songId);
    if (!it) {
      console.log(`✗ 歌 ${songId} 不在 allData top~${r.items.length} 里 —— 无法观测，请换一首在榜的歌。`);
    } else {
      const margin = r.items.length - it.rank;
      console.log(
        `✓ 歌 ${songId}「${it.song.name}」在榜：rank=${it.rank}/${r.items.length}，距截断线余量 ${margin}` +
          `，当前累计 playCount=${it.playCount}` +
          `${margin < 30 ? '  ⚠ 余量<30，实验中可能被挤出，建议换 rank 更靠前的歌' : ''}`
      );
    }
    closeDb();
    return;
  }

  if (sub === 'begin' || sub === 'start') {
    const songId = typeof o.song === 'string' ? Number(o.song) : NaN;
    const k = typeof o.k === 'string' ? Number(o.k) : 1;
    if (!songId || Number.isNaN(songId)) throw new Error('用法：stimulus begin --song <id> --k <K> [--kind midnight] [--at <本地ISO>] [--label ..] [--no-anchor]');
    const atStr = typeof o.at === 'string' ? o.at : null;
    const t0 = atStr ? DateTime.fromISO(atStr, { zone: config.tz }).toUTC().toISO() : nowUtcISO();
    if (!t0) throw new Error(`非法 --at: ${o.at}`);

    let baselinePc = null;
    if (!o['no-anchor']) {
      const r = await fetchUserRecordRaw(uid, 0); // 抓一张「播放前」锚点
      if (r.code === 200 && r.items.length) {
        const fetchedAt = r.respRecvAt;
        const ins = db.prepare('INSERT OR REPLACE INTO probe(fetched_at,song_id,play_count,rank) VALUES(?,?,?,?)');
        for (const x of r.items) ins.run(fetchedAt, x.song.id, x.playCount, x.rank ?? null);
        const it = r.items.find((x) => x.song.id === songId);
        baselinePc = it ? it.playCount : null;
        if (!it) console.log(`⚠ 歌 ${songId} 当前不在 top~${r.items.length}，可能观测不到，建议先 verify 换歌`);
      } else {
        console.log(`⚠ 锚点抓取失败 code=${r.code}，baseline 留空（analyze 会退化用刺激后首样本前一个）`);
      }
    }
    const res = db
      .prepare('INSERT INTO stimulus(song_id,t0,expected_k,baseline_pc,kind,label,note,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(songId, t0, k, baselinePc, typeof o.kind === 'string' ? o.kind : 'latency', typeof o.label === 'string' ? o.label : null, typeof o.note === 'string' ? o.note : null, nowUtcISO());
    const id = Number(res.lastInsertRowid);
    const localT0 = DateTime.fromISO(t0, { zone: 'utc' }).setZone(config.tz).toFormat('yyyy-MM-dd HH:mm:ss');
    console.log(`✓ 刺激 #${id} 已登记：song=${songId} K=${k} baseline=${baselinePc ?? '?'} t0=${localT0}(本地)`);
    console.log(`  → 现在请把这首歌单曲循环、整首播完，精确放 ${k} 次；放完后执行：npm run stimulus -- end --id ${id}`);
    closeDb();
    return;
  }

  if (sub === 'end') {
    const id = typeof o.id === 'string' ? Number(o.id) : NaN;
    if (!id || Number.isNaN(id)) throw new Error('用法：stimulus end --id <id>');
    const done = nowUtcISO();
    const r = db.prepare('UPDATE stimulus SET t0_done=? WHERE id=?').run(done, id);
    if (!r.changes) throw new Error(`找不到刺激 #${id}`);
    const localDone = DateTime.fromISO(done, { zone: 'utc' }).setZone(config.tz).toFormat('HH:mm:ss');
    console.log(`✓ 刺激 #${id} 标记放完 t0_done=${localDone}(本地)。继续保持探针运行，明天跑 npm run probe:analyze`);
    closeDb();
    return;
  }

  console.log('用法：stimulus <verify|begin|end|list> …\n  verify --song <id>\n  begin --song <id> --k <K> [--kind midnight] [--at <本地ISO>] [--label ..]\n  end --id <id>\n  list');
  closeDb();
}

main().catch((e) => {
  console.error('[stimulus] 失败：', e?.message || e);
  process.exitCode = 1;
});
