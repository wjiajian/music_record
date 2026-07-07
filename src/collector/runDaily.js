// 每日采集核心：抓快照、算增量、跑实时、写 collection_log。
// 被 cron 脚本入口(main) 与 api 进程内调度器(scheduler.js) 共用（DRY）。
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';
import { getDb, initSchema } from '../db/index.js';
import { fetchSnapshot } from './fetchSnapshot.js';
import { collectRealtimePlayback } from './realtime.js';
import { collectPlaylists } from './playlists.js';
import { requireUid, config } from '../config.js';

// 执行一次完整采集。db 由调用方提供（脚本用单例可写连接，调度器用独立可写连接）。
// 返回一行可读摘要 + 结构化结果；异常向上抛，由调用方决定退出码/日志级别。
export async function runCollectOnce(db, { uid = config.uid, attribution = config.attribution } = {}) {
  const runAt = new Date().toISOString();
  const logStmt = db.prepare('INSERT INTO collection_log(run_at,kind,status,detail) VALUES(?,?,?,?)');
  try {
    const r = await fetchSnapshot(db, { uid, attribution });
    const realtime = await collectRealtimePlayback(db, {});
    // 歌单采集失败绝不拖垮整轮：try/catch 隔离，异常不冒泡（遵循「失败只记日志」）
    let playlists;
    try {
      playlists = await collectPlaylists(db, { uid });
    } catch (e) {
      playlists = { status: 'fail', message: String(e?.message || e) };
    }
    // status 归并：任何子链路非 ok → 整体 partial（仅 fetchSnapshot 硬抛才 fail）
    const partial = realtime.status === 'fail' || playlists.status !== 'ok';
    logStmt.run(runAt, 'collect', partial ? 'partial' : 'ok', JSON.stringify({ diff: r.diff, realtime, playlists }));
    const today = realtime.today?.status === 'ok'
      ? `；今日足迹 ${realtime.today.itemCount} 首`
      : `；今日足迹失败 ${realtime.today?.message || 'unknown'}`;
    const recent = realtime.recent?.status === 'ok'
      ? `；最近播放 ${realtime.recent.itemCount} 条 → daily_play ${realtime.recent.daily.written} 行`
      : `；最近播放失败 ${realtime.recent?.message || 'unknown'}`;
    const pl = playlists.status === 'ok'
      ? `；歌单 ${playlists.playlistCount} 个 / 曲目 ${playlists.trackRows} 行`
      : `；歌单采集${playlists.status === 'partial' ? '不完整' : '失败'}（${playlists.message || (playlists.failedPlaylists?.length ?? 0) + ' 单失败'}）`;
    const summary =
      `[collect] ${r.snapDate} ok：allData ${r.itemCount} 首 / weekData ${r.weekCount} 首；` +
      `增量 all ${r.diff.written} 行 + week ${r.diff.weekWritten} 行` +
      `（估算 ${r.diff.estimated + r.diff.weekEstimated}，两榜重叠 ${r.diff.coListed}，归属日 ${r.diff.attributeDate}` +
      `${r.diff.baseline ? '，首张基线' : ''}）` +
      today +
      recent +
      pl;
    return { status: partial ? 'partial' : 'ok', summary, snapshot: r, realtime, playlists };
  } catch (e) {
    logStmt.run(runAt, 'collect', 'fail', String(e?.message || e));
    throw e;
  }
}

async function main() {
  const uid = requireUid();
  const db = initSchema(getDb());
  try {
    const r = await runCollectOnce(db, { uid });
    console.log(r.summary);
  } catch (e) {
    console.error('[collect] 失败：', e?.message || e);
    process.exitCode = 1;
  }
}

// 仅作为脚本直接运行时才启动 main（被 import 复用时不触发）。
// 用 pathToFileURL 归一化，避免 Windows 盘符/斜杠差异导致误判。
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main();
}
