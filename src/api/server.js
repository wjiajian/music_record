// 只读 API 服务（Fastify）。需先跑过 migrate。
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getReadonlyDb } from '../db/index.js';
import routes from './routes.js';
import { config } from '../config.js';
import { startDailyCollectScheduler } from '../collector/scheduler.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

const app = Fastify({ logger: true });
app.decorate('db', getReadonlyDb());
app.register(routes);

async function sendPublic(reply, fileName, contentType) {
  const body = await fs.readFile(path.join(publicDir, fileName));
  return reply.type(contentType).send(body);
}

app.get('/', async (_req, reply) => sendPublic(reply, 'index.html', 'text/html; charset=utf-8'));
app.get('/styles.css', async (_req, reply) => sendPublic(reply, 'styles.css', 'text/css; charset=utf-8'));
app.get('/app.js', async (_req, reply) => sendPublic(reply, 'app.js', 'text/javascript; charset=utf-8'));
app.get('/logo.png', async (_req, reply) => sendPublic(reply, 'logo.png', 'image/png'));
app.get('/favicon.png', async (_req, reply) => sendPublic(reply, 'favicon.png', 'image/png'));
// 浏览器有时自动请求 /favicon.ico，指向同一张 png 兜底，避免 404 噪音
app.get('/favicon.ico', async (_req, reply) => sendPublic(reply, 'favicon.png', 'image/png'));

app.get('/api', async () => ({
  ok: true,
  service: 'music-record',
  endpoints: [
    '/api/health',
    '/api/overview',
    '/api/ranking',
    '/api/trend',
    '/api/daily-top-songs',
    '/api/calendar',
    '/api/weekday',
    '/api/netease/record/recent/song',
    '/api/netease/listen/data/today/song',
    '/api/netease/song/detail',
    '/api/playlists',
    '/api/playlists/:id/tracks',
  ],
}));

app
  .listen({ port: config.api.port, host: config.api.host })
  .then((addr) => {
    app.log.info(`api 已启动：${addr}`);
    // 进程内每日采集调度（替代 Windows 计划任务；COLLECT_IN_API=0 可关）
    if (config.collect.inApi) {
      const stop = startDailyCollectScheduler({ logger: app.log });
      const shutdown = () => {
        stop();
        app.close().finally(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } else {
      app.log.info('[scheduler] COLLECT_IN_API=0，进程内采集已禁用');
    }
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
