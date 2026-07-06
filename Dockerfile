# music-record —— 网易云听歌统计 API + 进程内每日采集
# 纯 JS（ESM），无编译步骤；node:sqlite 内置模块要求 Node >= 22.5。
# 多阶段：deps 层装依赖可被缓存；runtime 层只带生产依赖 + 源码，镜像更小。

# ---- deps：只装生产依赖（利用 layer 缓存，源码变动不重装）----
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# 无 lockfile 时 `npm ci` 会失败，回退 install；--omit=dev 不装测试等开发依赖
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---- runtime：精简运行镜像 ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# 启动入口脚本：先幂等 migrate 建库，再启 api（详见脚本内注释）。
# sed 去掉可能的 Windows CRLF，避免 `\r` 导致 sh 解析失败；并加执行权限。
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh

# 数据库落在 /app/data —— 部署时用 volume 挂载持久化，否则容器重建数据全丢。
# 预建目录并交给非 root 用户（node:slim 自带 uid/gid 1000 的 node 用户）。
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

# 以非 root 运行（最小权限；配合 volume 的 owner）
USER node

# 服务端口（默认 3000，可用 API_PORT 覆盖）。容器内绑 0.0.0.0 才能被宿主访问。
ENV API_HOST=0.0.0.0
EXPOSE 3000

# 健康检查：打 /api/health（server.js 提供）。node 单行 http 探测，免装 curl。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 入口：先幂等建库再启 api（见 docker-entrypoint.sh）。
CMD ["/app/docker-entrypoint.sh"]
