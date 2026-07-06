// api 进程内每日采集调度器：替代 Windows 计划任务。
// 递归 setTimeout 睡到每日固定时刻跑一次 collect；用独立可写连接，与 api 只读连接
// 在 WAL 下并发共存。采集失败只记日志、不拖垮 api，并继续排下一次。
import { DateTime } from 'luxon';
import { openWritableConnection, initSchema } from '../db/index.js';
import { runCollectOnce } from './runDaily.js';
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

// 启动调度器。返回 stop() 用于优雅关停（清 timer + 关连接）。
export function startDailyCollectScheduler({ logger = console } = {}) {
  const db = initSchema(openWritableConnection());
  let timer = null;
  let stopped = false;

  async function runOnce(reason) {
    try {
      const r = await runCollectOnce(db);
      logger.info?.(`[scheduler] ${reason} 采集完成：${r.summary}`) ?? logger.log(r.summary);
    } catch (e) {
      // 采集失败绝不拖垮 api：只记录，等下一次
      logger.error?.(`[scheduler] ${reason} 采集失败（已记录，继续）：${e?.message || e}`);
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

  // 可选：启动时若今天还没抓过则立即补抓一次（默认关，避免白天抓乱归属日）
  if (config.collect.onStart && !hasSnapshotToday(db)) {
    runOnce('启动补抓').then(scheduleNext);
  } else {
    scheduleNext();
  }

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    db.close();
  };
}
