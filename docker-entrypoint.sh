#!/bin/sh
# 容器启动入口：先幂等建库/补表，再启动 API。
#
# migrate 是幂等的（schema.sql 全用 CREATE ... IF NOT EXISTS），
# 每次启动都跑一遍是安全的：库不存在则新建，已存在则自动补新表/新列。
# 这样全新的数据卷首次挂载也能自愈，无需人工进容器执行 npm run migrate。
set -e

echo "[entrypoint] 初始化数据库（幂等）..."
node --disable-warning=ExperimentalWarning src/db/migrate.js

echo "[entrypoint] 启动 API..."
exec node --disable-warning=ExperimentalWarning src/api/server.js
