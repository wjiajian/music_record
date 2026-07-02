// 高频任务入口：只抓今日足迹 + 最近播放，不跑 allData 差分。
import { config } from '../config.js';
import { getDb, initSchema } from '../db/index.js';
import { collectRealtimePlayback } from './realtime.js';

async function main() {
  const db = initSchema(getDb());
  const runAt = new Date().toISOString();
  const logStmt = db.prepare(
    'INSERT INTO collection_log(run_at,kind,status,detail) VALUES(?,?,?,?)'
  );
  const realtime = await collectRealtimePlayback(db, {});
  logStmt.run(runAt, 'collect_realtime', realtime.status, JSON.stringify(realtime));

  const today = realtime.today?.status === 'ok'
    ? `今日足迹 ${realtime.today.itemCount} 首`
    : `今日足迹失败 ${realtime.today?.message || 'unknown'}`;
  const recent = realtime.recent?.status === 'ok'
    ? `最近播放 ${realtime.recent.itemCount} 条 → daily_play ${realtime.recent.daily.written} 行`
    : `最近播放失败 ${realtime.recent?.message || 'unknown'}`;
  console.log(`[collect:realtime] ${config.tz} ${realtime.status}：${today}；${recent}`);

  if (realtime.status === 'fail') process.exitCode = 1;
}

main().catch((error) => {
  console.error('[collect:realtime] 失败：', error?.message || error);
  process.exitCode = 1;
});
