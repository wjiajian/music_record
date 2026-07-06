# music-record

> 网易云音乐个人听歌统计 —— 每日快照 + 累计差分，把「只给总数」的官方接口还原成逐日听歌账本，按天 / 周 / 月 / 年出排行与趋势。

![Node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)
![Fastify](https://img.shields.io/badge/api-Fastify%205-black)
![SQLite](https://img.shields.io/badge/db-node%3Asqlite-blue)
![Zero deps](https://img.shields.io/badge/runtime%20deps-2-lightgrey)

网易云的听歌排行接口只提供**累计播放次数**（allData，自注册以来的总和）和**最近 7 天滚动窗口**（weekData）—— 唯独没有「某一天听了什么」。`music-record` 每天定时抓一次快照，用相邻两天的累计差值反推出**当日每首歌的播放增量**，保存进本地 SQLite，再对外提供只读的统计 API 和一个轻量前端。

全程只用到两个运行时依赖（Fastify + Luxon），数据库、测试、`.env` 加载、`fetch` 全部走 Node 22 内置能力，无需编译。

## 特性

- **快照差分引擎** —— 相邻快照累计值作差 → 逐日播放增量，单调裁剪、跨天标记，杜绝「老歌进榜」造成的假尖峰。
- **双数据源分域** —— `all`（累计差分，真实次数）与 `recent`（最近播放事件，存在性占位）分域共存，各取所长。
- **多维聚合** —— 歌曲 / 歌手 / 专辑三个维度，天 / 周 / 月 / 年四种周期，附带听歌时长估算。
- **可视化端点** —— 概览、排行、趋势时序、每日封面墙、GitHub 式日历热力、周几分布，一应俱全。
- **进程内定时采集** —— API 进程自带每日调度器（默认 04:00），无需 cron 或 Windows 计划任务。
- **缺数据诚实标注** —— 用 `missing` / `has_gap` / `estimated` 区分「真的是 0」与「那天没抓到」，冷启动期返回「攒取中」而非假数据。
- **一键部署** —— 附 Dockerfile + Compose，多阶段构建、非 root 运行、数据卷持久化、内置健康检查。

## 工作原理

```
        网易云 play/record 接口                  本地 SQLite
   ┌───────────────────────────┐        ┌────────────────────────┐
   │ allData  = 累计播放次数     │  抓取   │ snapshot / snapshot_item│
   │ weekData = 最近7天滚动窗口  │ ─────► │  (不可变原始快照，审计源) │
   └───────────────────────────┘        └───────────┬────────────┘
                                                     │ 相邻快照累计值作差
   昨天 allData:  歌A=120  歌B=88                     ▼
   今天 allData:  歌A=127  歌B=88            ┌────────────────────────┐
                    │                       │ daily_play              │
                    ▼ 差分                   │ (派生事实表：逐日每歌增量)│
   歌A +7  (归属到昨天)  歌B +0 (跳过)         └───────────┬────────────┘
                                                     │ 聚合查询
                                                     ▼
                                    day / week / month / year 排行 · 趋势 · 热力
```

> [!NOTE]
> **归属规则**：由于 allData 有传播延迟，凌晨抓到的增量其实是「昨天」听的。默认 `ATTRIBUTION=prev` 把增量归到快照日的前一天；若改在当天 23:55 抓，则设 `same` 归当天。

> [!NOTE]
> 全库**第一张快照**只能作为基线，没有可对比的前值，故当天不产生增量 —— 这是正常现象，攒到第二天才会出数据。

## 快速开始

### 环境要求

- **Node.js >= 22.5.0**（依赖内置 `node:sqlite`、`node:test`、`process.loadEnvFile`、`fetch`）
- 一个网易云音乐账号

### 1. 安装

```bash
git clone <repo-url> music-record
cd music-record
npm install
```

### 2. 配置

复制环境变量模板并填入你的信息：

```bash
cp .env.example .env
```

至少填两项：

```ini
NETEASE_UID=你的网易云UID
NETEASE_COOKIE=MUSIC_U=xxxxxxxx...
```

> [!IMPORTANT]
> - **听歌排行必须在网易云客户端设为「公开」**（我的 → 听歌排行 → 设置为公开），否则接口返回空。
> - `NETEASE_COOKIE` 只需登录后的 `MUSIC_U` 一项。**缺了它 `playCount` 会全为 0 且很快被限流**。Cookie 可从网页版登录后的浏览器开发者工具里取。

### 3. 初始化数据库

```bash
npm run migrate
```

### 4. 采集第一张快照

```bash
npm run collect
```

首次运行只建立基线，次日再次采集才会产生增量数据。

### 5. 启动 API 与前端

```bash
npm run api
```

打开 <http://127.0.0.1:3000> 查看前端，或直接访问 <http://127.0.0.1:3000/api> 浏览端点列表。

> [!TIP]
> API 进程默认内置每日采集调度器（`COLLECT_AT`，默认 04:00），所以**日常只需让 `npm run api` 常驻运行**，无需再单独跑 `collect`。设 `COLLECT_IN_API=0` 可关闭，退化为纯只读服务。

## 配置项

所有配置经环境变量注入（`config.js` 启动时自动加载项目根的 `.env`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NETEASE_UID` | *（必填）* | 你的网易云 UID，听歌排行需设为公开 |
| `NETEASE_COOKIE` | *（必填）* | 登录 Cookie，只需 `MUSIC_U` 一项 |
| `TZ_NAME` | `Asia/Shanghai` | 统计时区（周一为周首，ISO 周） |
| `ATTRIBUTION` | `prev` | 差分归属：`prev`=归前一天 / `same`=归当天 |
| `DB_PATH` | `data/music.db` | SQLite 数据库路径 |
| `API_PORT` | `3000` | API 服务端口 |
| `API_HOST` | `127.0.0.1` | 绑定地址 |
| `COLLECT_IN_API` | `1` | 是否在 API 进程内挂定时采集 |
| `COLLECT_AT` | `04:00` | 每日采集触发的本地时刻 `HH:mm` |
| `COLLECT_ON_START` | `0` | 启动时若当天未抓则立即补抓一次 |

> [!WARNING]
> 本服务**无鉴权**，且 `.env` 内含你的登录 Cookie。对外暴露时请保持 `API_HOST=127.0.0.1`，由 nginx 反代加 HTTPS/鉴权，切勿直接把 `0.0.0.0` 端口开到公网。

## npm 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run migrate` | 建表 / 迁移数据库结构 |
| `npm run collect` | 采集一次每日快照 + 差分 + 实时数据 |
| `npm run collect:realtime` | 只采集实时接口（今日足迹 / 最近播放） |
| `npm run api` | 启动只读 API + 前端（含进程内调度器） |
| `npm run rebuild` | 从原始快照整表重建 `daily_play` |
| `npm test` | 运行测试（Node 内置 `node:test`） |
| `npm run probe` | 运行探针，实测 allData 更新延迟（见下） |

## API 端点

统计端点均返回 `meta`（含 `period_resolved`、数据新鲜度等），数据不足时返回 `200` + `{ insufficientData: true }`。

| 端点 | 说明 |
| --- | --- |
| `GET /api/health` | 采集健康状况，驱动「攒取中」判断 |
| `GET /api/overview` | 总览：总播放、时长估算、Top 歌/歌手/专辑、周环比 |
| `GET /api/ranking` | 多维排行（`dimension` × `metric` × `period`） |
| `GET /api/trend` | 趋势时序（可按歌曲 / 歌手 / 专辑过滤） |
| `GET /api/daily-top-songs` | 最近 N 天每日 Top 歌曲封面行 |
| `GET /api/calendar` | GitHub 贡献图式的日历热力 |
| `GET /api/weekday` | 周几听歌分布 |
| `GET /api/netease/*` | 网易云增强接口代理（近期播放 / 今日足迹 / 歌单等） |

## 数据模型

三层结构，职责分明：

- **原始快照层**（不可变审计源）—— `snapshot` / `snapshot_item`（allData 累计）/ `snapshot_week_item`（weekData 滚动）。
- **维度层**（每次抓取 upsert）—— `song` / `artist` / `album` / `song_artist`。
- **派生事实层** —— `daily_play`：逐日每歌播放增量，**所有排行 / 趋势查询的基表**，可随时从快照层用 `npm run rebuild` 重算。

此外还有实时采集表（`today_listen_*` / `recent_play_*`）和运维表（`collection_log` / `probe` / `meta`）。完整结构见 [`src/db/schema.sql`](src/db/schema.sql)。

## Docker 部署

项目自带多阶段 Dockerfile 与 Compose 编排，采集靠 API 进程内调度，无需额外容器或 cron：

```bash
# 在项目根建好 .env（填 NETEASE_UID / NETEASE_COOKIE）
docker compose up -d --build

docker compose logs -f   # 查看日志
docker compose down      # 停止
```

数据库通过命名卷 `music-data` 挂载到 `/app/data` 持久化，容器重建数据不丢；端口默认只映射到宿主 `127.0.0.1:3000`，对外由 nginx 反代。

## 探针（进阶）

`play/record` 的 allData 从「实际播放」到「接口可见」存在传播延迟，直接决定了差分该归到哪一天。`src/probe/` 是一套采样工具，用来实测这个延迟并校准 `ATTRIBUTION` 规则：

```bash
npm run probe           # 单发采样一次
npm run probe:watch     # 自循环，刺激窗口内自动加密采样
npm run probe:analyze   # 分析已采集的延迟数据
```

> [!NOTE]
> 探针是一次性的研发标定工具，得出归属规则后即可停用，不影响日常采集。

## 项目结构

```
src/
├── api/          Fastify 服务与路由（只读）
├── collector/    每日快照采集、实时采集、进程内调度器
├── netease/      网易云接口客户端与 weapi/eapi 加密
├── aggregate/    周期解析（periods）与聚合 SQL（queries）
├── db/           schema / migrate / rebuild / 连接管理
├── probe/        allData 更新延迟标定探针
└── config.js     集中配置（环境变量覆盖）
public/           轻量前端（原生 ESM，无框架）
scripts/          Windows .cmd 启动 / 采集 / 探针包装
test/             node:test 单元测试
```
