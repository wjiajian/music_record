// 集中配置：全部可经环境变量覆盖（KISS，单用户场景）
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 自动加载项目根目录的 .env（Node 内置，无需 dotenv 依赖）
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    /* .env 解析失败则忽略，回退到真实环境变量 */
  }
}

export const config = {
  // 你的网易云 uid（听歌排行需在网易云客户端设为「公开」）。必填。
  uid: process.env.NETEASE_UID || '',

  dbPath: process.env.DB_PATH || path.join(root, 'data', 'music.db'),
  schemaPath: path.join(root, 'src', 'db', 'schema.sql'),

  // 统计时区；趋势图按周分桶时仍采用 ISO 周。
  tz: process.env.TZ_NAME || 'Asia/Shanghai',

  // 差分归属规则（由 §6 探针实测 allData 更新延迟后拍板）：
  //   'prev' = 把增量归到 snapDate 的前一天（cron 在凌晨抓时用，深夜播放已传播）
  //   'same' = 把增量归到 snapDate 当天（cron 在当天 23:55 抓时用）
  attribution: process.env.ATTRIBUTION || 'prev',

  api: {
    port: Number(process.env.API_PORT || 3000),
    host: process.env.API_HOST || '127.0.0.1',
  },

  // api 进程内每日采集调度（替代 Windows 计划任务）：
  //   inApi   = 是否在 api 进程里挂定时采集（默认开；设 COLLECT_IN_API=0 关）
  //   at      = 每日触发的本地时刻 HH:mm（默认 04:00，凌晨抓、配合 ATTRIBUTION=prev）
  //   onStart = api 启动时若今天还没抓过快照是否立即补抓一次（默认关，避免白天抓乱了归属日）
  collect: {
    inApi: process.env.COLLECT_IN_API !== '0',
    at: process.env.COLLECT_AT || '04:00',
    onStart: process.env.COLLECT_ON_START === '1',
  },

  // 高频最近播放计数器。网易云 recent 接口只暴露每首歌最后一次播放时间，
  // 因此轮询间隔越短，捕获重复播放的概率越高；默认按已确认的 60 秒运行。
  realtime: {
    inApi: process.env.REALTIME_IN_API !== '0',
    intervalMs: Math.max(Number(process.env.REALTIME_INTERVAL_MS || 60000), 15000),
    limit: Math.min(Math.max(Number(process.env.REALTIME_LIMIT || 300), 1), 300),
  },
};

export function requireUid() {
  if (!config.uid) {
    throw new Error('缺少 NETEASE_UID 环境变量（你的网易云 uid，且听歌排行需设为公开）');
  }
  return config.uid;
}
