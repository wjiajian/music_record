// api 进程内每日采集调度器：替代 Windows 计划任务。
// 递归 setTimeout 睡到每日固定时刻跑一次 collect；用独立可写连接，与 api 只读连接
// 在 WAL 下并发共存。采集失败只记日志、不拖垮 api，并继续排下一次。
import { DateTime } from 'luxon';
import { openWritableConnection, initSchema } from '../db/index.js';
import { runCollectOnce } from './runDaily.js';
import { collectPlaylists } from './playlists.js';
import { config } from '../config.js';

// 纯函数（可单测）：从 nowMs 到「下一个本地 HH:mm」的毫秒延迟。
// 已过点或正好等于 → 排到次日，恒返回正数（不会 0 延迟空转）。
export function nextRunDelayMs(nowMs, hhmm, tz = config.tz) {
  const [h, m] = hhmm.split(':').map(Number);
  const now = DateTime.fromMillis(nowMs, { zone: tz });
  let target = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (target.toMillis() <= nowMs) target = target.plus({ days: 1 });
  return target.toMillis() - nowMs;
}

// 是否今天（本地时区）已抓过快照——用于 onStart 补抓判断，避免重复抓触发限流。
function hasSnapshotToday(db) {
  const today = DateTime.now().setZone(config.tz).toISODate();
  return !!db.prepare('SELECT 1 FROM snapshot WHERE snapshot_date=?').get(today);
}

// 歌单表是否已有数据——冷启动补抓判断。歌单是当前状态镜像、无归属日顾虑，
// 故只以「表为空」为条件补抓，独立于 config.collect.onStart（不新增 env，KISS）。
export function hasPlaylistsData(db) {
  return !!db.prepare('SELECT 1 FROM playlist LIMIT 1').get();
}

// 启动调度器。返回 stop() 用于优雅关停（清 timer + 关连接）。
export function startDailyCollectScheduler({ logger = console } = {}) {
  const db = initSchema(openWritableConnection());
  let timer = null;
  let stopped = false;

  // pino 的 logger.info() 返回 undefined，不能用 `logger.info?.() ?? logger.log()`
  // 判断（会在成功打印后又去调不存在的 logger.log）。按「方法是否存在」择一。
  const info = (msg) => (logger.info ? logger.info(msg) : logger.log?.(msg));

  async function runOnce(reason) {
    try {
      const r = await runCollectOnce(db);
      info(`[scheduler] ${reason} 采集完成：${r.summary}`);
    } catch (e) {
      // 采集失败绝不拖垮 api：只记录，等下一次
      logger.error?.(`[scheduler] ${reason} 采集失败（已记录，继续）：${e?.message || e}`);
    }
  }

  // 只补歌单（不碰 snapshot/归属日）：冷启动时若歌单空则立即填一次，无需等到 04:00。
  async function runPlaylistBackfill(reason) {
    const runAt = new Date().toISOString();
    const logStmt = db.prepare('INSERT INTO collection_log(run_at,kind,status,detail) VALUES(?,?,?,?)');
    try {
      const r = await collectPlaylists(db, {});
      logStmt.run(runAt, 'collect_playlists', r.status, JSON.stringify(r));
      info(`[scheduler] ${reason} 完成：歌单 ${r.playlistCount ?? 0} 个 / 曲目 ${r.trackRows ?? 0} 行`);
    } catch (e) {
      logStmt.run(runAt, 'collect_playlists', 'fail', String(e?.message || e));
      logger.error?.(`[scheduler] ${reason} 失败（已记录，继续）：${e?.message || e}`);
    }
  }

  function scheduleNext() {
    if (stopped) return;
    const delay = nextRunDelayMs(Date.now(), config.collect.at);
    const at = DateTime.now().setZone(config.tz).plus({ milliseconds: delay }).toFormat('yyyy-LL-dd HH:mm');
    logger.info?.(`[scheduler] 下次采集：${at}（${Math.round(delay / 60000)} 分钟后）`);
    timer = setTimeout(async () => {
      await runOnce('定时');
      scheduleNext(); // 跑完再排下一个，避免 setInterval 漂移/重叠
    }, delay);
    timer.unref?.(); // 不阻止进程正常退出
  }

  // 可选：启动时若今天还没抓过则立即补抓一次（默认关，避免白天抓乱归属日）。
  // 整轮 collect 已含歌单，故只在不走整轮时，才单独判「歌单空 → 立即补抓歌单」。
  if (config.collect.onStart && !hasSnapshotToday(db)) {
    runOnce('启动补抓').then(scheduleNext);
  } else if (!hasPlaylistsData(db)) {
    runPlaylistBackfill('冷启动歌单补抓').then(scheduleNext);
  } else {
    scheduleNext();
  }

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    db.close();
  };
}
