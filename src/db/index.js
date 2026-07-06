// 数据库薄封装：隔离 node:sqlite，将来若换 better-sqlite3 只需改本文件。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

let _db = null;

// 可写连接统一 PRAGMA（DRY）：WAL 支持一写多读并发。
function applyWritablePragmas(db) {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

// 打开（或创建）可读写数据库并应用 PRAGMA。进程内复用单连接（单写者）。
export function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  _db = applyWritablePragmas(new DatabaseSync(config.dbPath));
  return _db;
}

// 独立的可写连接（不进单例 _db）。供 api 进程内调度器采集用——
// api 主连接是只读（getReadonlyDb），采集需另开可写连接，WAL 下与只读连接并发共存。
export function openWritableConnection() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  return applyWritablePragmas(new DatabaseSync(config.dbPath));
}

// 只读打开（api 进程用）。需先跑过 migrate 让库文件存在。
export function getReadonlyDb() {
  if (_db) return _db;
  if (!fs.existsSync(config.dbPath)) {
    throw new Error(`数据库不存在：${config.dbPath}，请先执行 npm run migrate`);
  }
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');
  _db = db;
  return db;
}

// 执行 schema.sql 初始化。schema.sql 全部用 CREATE ... IF NOT EXISTS，
// 幂等可重复执行——新增表（如 snapshot_week_item）会在下次启动时自动补建。
export function initSchema(db = getDb()) {
  db.exec(fs.readFileSync(config.schemaPath, 'utf8'));
  // 老库补列：schema.sql 的 IF NOT EXISTS 不会给已存在的 daily_play 加 source 列
  try {
    db.exec("ALTER TABLE daily_play ADD COLUMN source TEXT NOT NULL DEFAULT 'all'");
  } catch {
    /* 列已存在，忽略 */
  }
  return db;
}

// 简单事务封装：fn 抛错则回滚（不支持嵌套）。
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}
