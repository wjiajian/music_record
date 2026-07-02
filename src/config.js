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

  // 统计时区与周规则（周一为周首，ISO 周）
  tz: process.env.TZ_NAME || 'Asia/Shanghai',

  // 差分归属规则（由 §6 探针实测 allData 更新延迟后拍板）：
  //   'prev' = 把增量归到 snapDate 的前一天（cron 在凌晨抓时用，深夜播放已传播）
  //   'same' = 把增量归到 snapDate 当天（cron 在当天 23:55 抓时用）
  attribution: process.env.ATTRIBUTION || 'prev',

  api: {
    port: Number(process.env.API_PORT || 3000),
    host: process.env.API_HOST || '127.0.0.1',
  },

  // 冷启动门槛：攒够多少「有差分的天数」才出对应周期，否则返回「攒取中」
  sufficiency: { day: 1, week: 7, month: 30, year: 365 },
};

export function requireUid() {
  if (!config.uid) {
    throw new Error('缺少 NETEASE_UID 环境变量（你的网易云 uid，且听歌排行需设为公开）');
  }
  return config.uid;
}
