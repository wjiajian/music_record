// 只读 API 服务（Fastify）。需先跑过 migrate。
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getReadonlyDb } from '../db/index.js';
import routes from './routes.js';
import { config } from '../config.js';

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
    '/api/netease/user/playlist',
    '/api/netease/playlist/track/all',
  ],
}));

app
  .listen({ port: config.api.port, host: config.api.host })
  .then((addr) => app.log.info(`api 已启动：${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
