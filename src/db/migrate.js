// 建库 CLI：执行 schema.sql 初始化数据库，并幂等补建探针实验相关表。
import { getDb, initSchema } from './index.js';
import { ensureProbeTables } from '../probe/ensure.js';
import { config } from '../config.js';

const db = initSchema(getDb());
ensureProbeTables(db); // 已建库也能补上 probe_fetch/stimulus 与 probe.rank
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).all().map(r => r.name);

console.log(`[migrate] 数据库就绪：${config.dbPath}`);
console.log(`[migrate] 表：${tables.join(', ')}`);
