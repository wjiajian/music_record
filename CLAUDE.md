# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 说明：本仓库全部注释 / README / `.env.example` 均为中文，为保持语言统一，本文正文用中文书写。改代码时注释语言请与现有文件保持一致。

## 项目本质

网易云音乐个人听歌统计后端。核心难点在于**数据源约束**：网易云 `play/record` 接口只给「累计播放次数」（allData，自注册以来总和）和「最近 7 天滚动窗口」（weekData），**唯独没有「某一天听了什么」**。本项目每天抓一次快照，用**相邻两天累计值作差**反推当日每首歌播放增量，落 SQLite，再对外提供只读统计 API + 轻量前端。

## 运行环境（硬约束）

- **Node.js >= 22.5.0**，因为直接用了内置 `node:sqlite`、`node:test`、`process.loadEnvFile`、`fetch` —— 这些都是免依赖的关键。运行时依赖只有 `fastify` + `luxon` 两个，**不要为已能用内置能力解决的问题引入新依赖**。
- ESM（`"type":"module"`），全项目无编译步骤。
- 所有 npm 脚本都带 `--disable-warning=ExperimentalWarning`（压掉 `node:sqlite` 的实验特性警告）。

## 常用命令

```bash
npm run migrate            # 幂等建表/迁移（schema.sql 全用 IF NOT EXISTS）
npm run collect            # 采集一次：allData 快照 + 差分 + 实时接口
npm run collect:realtime   # 只采实时接口（今日足迹 / 最近播放）
npm run api                # 启动只读 API + 前端（默认含进程内每日调度器）
npm run rebuild            # 从原始快照整表重建 daily_play（改差分逻辑后必跑）
npm test                   # 跑全部测试（node:test）
npm run probe              # 探针：实测 allData 更新延迟（一次性标定工具，日常不用）
```

**跑单个测试文件**（node 内置 test runner，无 jest/mocha）：

```bash
node --disable-warning=ExperimentalWarning --test test/diff.test.js
# 按测试名过滤：
node --disable-warning=ExperimentalWarning --test --test-name-pattern="幂等" test/diff.test.js
```

配置全走环境变量（`src/config.js` 启动时自动 `loadEnvFile` 项目根 `.env`）。最少要填 `NETEASE_UID` + `NETEASE_COOKIE`（只需 `MUSIC_U`）。**缺 cookie 或听歌排行未设「公开」→ playCount 全 0 且很快被限流成空响应。**

## 数据模型：三层结构（理解全项目的钥匙）

```
① 原始快照层（不可变，审计源）  snapshot / snapshot_item(allData累计) / snapshot_week_item(weekData滚动)
        │  相邻快照累计值作差（diff.js）
        ▼
③ 派生事实层  daily_play —— 逐日每歌播放增量，所有排行/趋势查询的唯一基表
        ▲
② 维度层（每次抓取 upsert）  song / artist / album / song_artist
```

- **`daily_play` 是所有聚合查询的基表**，可随时从①层用 `npm run rebuild` 整表重算（差分是纯函数）。改动差分逻辑后**务必 rebuild**，否则历史数据用旧逻辑、新数据用新逻辑，会不一致。
- **`snapshot` 层永不重算/删除**——它是审计源，daily_play 坏了能靠它复原。

### daily_play 的双数据源规则（最容易踩坑处）

`daily_play.source` 有两个真实来源，冲突时按次数取较大值：

| source | 含义 | 语义 |
| --- | --- | --- |
| `'all'` | allData 累计差分 | 排行前 100 首可见的累计增量 |
| `'recent'` | 高频最近播放事件 | 按唯一 `playTime` 捕获的播放次数 |

关键约束（见 `persist.js:replaceDailyPlayWithRecentEvents`）：
- recent 接口每首歌只暴露最后一次 `playTime`，因此默认每 60 秒轮询；新时间戳计为新事件，相同时间戳幂等去重。
- daily_play 对同一首歌同一天取 `recent 事件数` 与 `allData 差分` 的较大值，只补高、不调低。
- 轮询间隔内连续重复播放仍可能漏计；历史与 `counter_poll_gap` 覆盖区间必须标为下界。

### weekData 只留原始、不再递推

`snapshot_week_item` 只做原始快照留存，**不再拆进 daily_play**（历史上试过，会把滚动窗口硬拆成单日造假）。排行统一查询 `daily_play`；`diff.js` 里对 weekData 的统计（`weekIgnored`/`coListed`）纯粹是监控用。

## 差分引擎（`src/collector/diff.js`）核心规则

- **归属日（attribution）**：allData 有传播延迟，凌晨抓到的增量其实是「昨天」听的。`ATTRIBUTION=prev`（默认）把增量归到快照日**前一天**，配合 04:00 采集；若改在当天 23:55 抓则设 `same`。
- **首张快照 = 基线**：全库第一张没有可对比前值，当天不产生增量，正常现象。
- **单调裁剪**：`delta <= 0` 直接跳过（累计值理应单调不减，负增量视为异常回退）。
- **新歌记 0**：全历史首见的歌当天不入表（避免「早就在听、今天才进榜」的假尖峰）。
- **跨天标记**：若与上次可见快照隔了多天（漏抓/掉榜重入），`span_days > 1` 且 `is_estimated=1`，把隐身期增量一次性补回但标「日级归属不确定」。`/api/weekday` 会排除 estimated 行，因为「具体哪天」不可知。

这五个边缘（漏抓/截断/重入/新歌/幂等/负增量）都有单测锁定，见 `test/diff.test.js`。改差分逻辑前先读这个测试。

## 进程架构：只读 API + 进程内采集调度

- **API 进程（`src/api/server.js`）是只读的**（`getReadonlyDb()`），无鉴权。
- 采集**不靠 cron / Windows 计划任务**。同一调度器每天到 `COLLECT_AT` 跑完整快照，并按 `REALTIME_INTERVAL_MS`（默认 60 秒）轮询最近播放。
- 采集调度器用**独立的可写连接**（`openWritableConnection()`），与 API 的只读连接在 **WAL 模式**下并发共存 —— 这是 `db/index.js` 里区分三种连接的原因：单例可写（脚本用）/ 独立可写（调度器用）/ 只读（API 用）。
- 采集失败**只记 `collection_log`、绝不拖垮 API**，继续排下一次。
- `COLLECT_IN_API` 与 `REALTIME_IN_API` 可分别关闭每日快照和高频计数器。

## 模块职责边界（避免改错地方）

- `src/aggregate/periods.js` —— **全项目唯一**的日期/时区/滚动周期逻辑（DRY）。日/周/月/年是滚动 1/7/30/365 天；趋势周桶仍采用 ISO 周。
- `src/aggregate/queries.js` —— 所有聚合 SQL，统一在 `daily_play` 上按 `[start,end]` GROUP BY。排序列走 `ORDER_COL` 白名单防注入，**新增可排序 metric 必须加进白名单**。
- `src/netease/client.js` —— 网易云接口封装。allData/weekData 走 weapi，今日足迹走 eapi，最近播放走 web 接口。`normalizeSong` 兼容网易云多套返回结构（`al`/`album`、`ar`/`artists` 等），新接口解析优先复用它。
- `src/netease/crypto.js` —— weapi(AES 双层+自定义 RSA) / eapi(AES-ECB+MD5)。常量多年稳定，**别动**。
- `src/db/index.js` —— 数据库薄封装，隔离 `node:sqlite`。将来换 better-sqlite3 只改这一个文件。`initSchema` 里有给老库补 `source` 列的 `ALTER TABLE`（迁移模式：schema.sql 的 IF NOT EXISTS 不会给已存在表加新列）。
- `public/` —— 原生 ESM 前端，无框架无构建。由 `server.js` 直接读文件返回。

## 部署

多阶段 Dockerfile + Compose：非 root 运行、`/app/data` 命名卷持久化、内置 `/api/health` 健康检查。`docker-entrypoint.sh` 每次启动先幂等 `migrate` 再启 API（新数据卷首挂即自愈，无需人工进容器）。容器内 `API_HOST=0.0.0.0`，但**对外务必由 nginx 反代加 HTTPS/鉴权**（本服务无鉴权且 `.env` 含登录 cookie），宿主端口只映射到 `127.0.0.1:3000`。

## 危险操作提醒（本仓库特有）

- **不要把 `.env` 或 `data/*.db` 提交或外传** —— `.env` 含登录 cookie，db 含个人听歌数据。
- 改差分/归属逻辑后跑 `npm run rebuild` 前，注意它会 `DELETE FROM daily_play` 全表重建 —— recent 行也会重放，但确认 snapshot 层完好再执行。
