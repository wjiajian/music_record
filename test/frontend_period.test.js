import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('统计窗口切换同时重置概览与排行周期，不重载趋势、封面墙、实时流或歌单', () => {
  const handlerStart = source.indexOf("const windowButton = event.target.closest('[data-window]')");
  const handlerEnd = source.indexOf("const dimension = event.target.closest('[data-dimension]')");
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /state\.window = windowButton\.dataset\.window/);
  assert.match(handler, /state\.rankingPeriod = state\.window/);
  assert.match(handler, /loadWindowData\(\)/);
  assert.doesNotMatch(handler, /loadDashboard\(\)|loadTrend\(\)|renderMosaic/);

  const loaderStart = source.indexOf('async function loadWindowData()');
  const loaderEnd = source.indexOf('// 排行维度', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert.match(loader, /\/api\/overview/);
  assert.match(loader, /\/api\/ranking/);
  assert.match(loader, /\/api\/overview[\s\S]*period: state\.window/);
  assert.match(loader, /\/api\/ranking[\s\S]*period: state\.rankingPeriod/);
  assert.doesNotMatch(loader, /\/api\/trend|daily-top-songs|record\/recent|listen\/data\/today|\/api\/playlists/);
});

test('排行维度切换只请求当前排行周期的本地 ranking 接口', () => {
  const handlerStart = source.indexOf("const dimension = event.target.closest('[data-dimension]')");
  const handlerEnd = source.indexOf("const granularity = event.target.closest('[data-granularity]')");
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /loadRanking\(\)/);
  assert.doesNotMatch(handler, /loadDashboard\(\)|loadTrend\(\)/);

  const loaderStart = source.indexOf('async function loadRanking()');
  const loaderEnd = source.indexOf('async function loadTrend()', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert.match(loader, /\/api\/ranking/);
  assert.match(loader, /period: state\.rankingPeriod/);
  assert.doesNotMatch(loader, /record\/recent|listen\/data\/today|\/api\/trend|loadDashboard/);
});

test('趋势周期切换同时刷新对应周期排行，不改变统计窗口或其它区域', () => {
  const handlerStart = source.indexOf("const granularity = event.target.closest('[data-granularity]')");
  const handlerEnd = source.indexOf("const pager = event.target.closest('[data-pager]')");
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /state\.granularity = granularity\.dataset\.granularity/);
  assert.match(handler, /state\.rankingPeriod = state\.granularity/);
  assert.match(handler, /loadTrend\(\)/);
  assert.match(handler, /loadRanking\(\)/);
  assert.doesNotMatch(handler, /state\.window\s*=|loadWindowData\(\)|loadDashboard\(\)/);

  const loaderStart = source.indexOf('async function loadTrend()');
  const loaderEnd = source.indexOf('async function loadDashboard()', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert.match(loader, /\/api\/trend/);
  assert.match(loader, /state\.granularity === 'day' \? 30 : 12/);
  assert.doesNotMatch(loader, /\/api\/ranking|record\/recent|listen\/data\/today|loadDashboard/);

  const dashboardStart = source.indexOf('async function loadDashboard()');
  const dashboardEnd = source.indexOf("document.addEventListener('click'", dashboardStart);
  const dashboard = source.slice(dashboardStart, dashboardEnd);
  assert.match(dashboard, /\/api\/ranking[\s\S]*period: state\.rankingPeriod/);
});

test('页面说明准确描述统计窗口与趋势周期的联动范围', () => {
  assert.match(html, /title="同时切换排行周期"/);
  assert.match(html, /aria-label="趋势周期；同时控制播放趋势与窗口排行"/);
  assert.doesNotMatch(html, /统计窗口可联动排行与趋势/);
});

test('趋势使用直线分段面积图，在未知空桶中断并标记当前桶', () => {
  const start = source.indexOf('function renderTrend');
  const end = source.indexOf('function renderHourlyActivity', start);
  const renderer = source.slice(start, end);
  assert.match(source, /function splitTrendSegments/);
  assert.match(renderer, /trend-area/);
  assert.match(renderer, /trend-line/);
  assert.match(renderer, /trend-gap/);
  assert.match(renderer, /trend-current-line/);
  assert.match(renderer, /point\.is_current/);
  assert.match(renderer, /trend-text-data/);
  assert.doesNotMatch(renderer, /bezier|quadraticCurve|cubic/i);
});

test('趋势分段保留有记录的缺口桶与真实零值，只在未知空桶断线', () => {
  const start = source.indexOf('function splitTrendSegments');
  const end = source.indexOf('function renderTrend', start);
  const split = vm.runInNewContext(`${source.slice(start, end)}; splitTrendSegments`);
  const points = [
    { bucket: 'a', plays: 10 },
    { bucket: 'b', plays: 6, has_gap: true, lower_bound: true, missing: false },
    { bucket: 'c', plays: 0, missing: false },
    { bucket: 'd', plays: 0, has_gap: true, missing: true },
    { bucket: 'e', plays: 3 },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(split(points))), [points.slice(0, 3), points.slice(4)]);
});

test('顶部栏向下滚动自动隐藏，向上滚动或靠近顶部时恢复', () => {
  assert.match(source, /function updateTopbarOnScroll/);
  assert.match(source, /window\.addEventListener\('scroll', scheduleTopbarUpdate/);
  assert.match(source, /event\.clientY <= TOPBAR_REVEAL_ZONE/);
  assert.match(source, /nodes\.topbar\.classList\.add\('is-hidden'\)/);

  const hiddenRule = css.slice(css.indexOf('.topbar.is-hidden'), css.indexOf('.topbar__inner'));
  assert.match(hiddenRule, /translateY/);
  assert.match(hiddenRule, /pointer-events: none/);

  const innerRule = css.slice(css.indexOf('.topbar__inner'), css.indexOf('.brand {'));
  assert.match(innerRule, /border-radius: 12px/);
});

test('最近播放与今日足迹共用圆形封面，且不显示更新时间', () => {
  assert.doesNotMatch(html, /recentFreshness|todayFreshness|crystal-list/);
  assert.doesNotMatch(source, /recentFreshness|todayFreshness/);
  assert.match(css, /\.song-row__art,[\s\S]*?border-radius: 50%/);
  assert.doesNotMatch(css, /\.crystal-list/);
});

test('健康状态与最近播放文案覆盖无数据和无最近记录场景', () => {
  const start = source.indexOf('function renderHealth');
  const end = source.indexOf('function renderOverview', start);
  const renderer = source.slice(start, end);
  assert.match(renderer, /!hasService \? '暂无数据' : warning \? '数据更新异常' : '数据正常'/);
  assert.match(renderer, /health\?\.last_recent_poll_at/);
  assert.match(renderer, /更新于/);
  assert.doesNotMatch(renderer, /最近一次播放记录于/);
  assert.doesNotMatch(renderer, /尚未捕获.*记录/);
});

test('趋势横纵坐标使用更大、更轻的正文数字', () => {
  const axisRule = css.slice(css.indexOf('.trend-axis-label'), css.indexOf('.trend-current-line'));
  assert.match(axisRule, /font-family: var\(--body\)/);
  assert.match(axisRule, /font-size: 12\.5px/);
  assert.match(axisRule, /font-weight: 400/);
  assert.match(axisRule, /stroke: none/);
  assert.match(source, /'dominant-baseline': 'middle'/);
});

test('封面区移除中文标题，并彻底移除系统诊断区', () => {
  assert.doesNotMatch(html, /七日封面账本|系统诊断账本|class="diagnostics"|icon-cpu/);
  assert.doesNotMatch(source, /diagnosticService|diagnosticQuality|diagnosticGap/);
  assert.doesNotMatch(css, /\.diagnostics/);
});

test('封面统一走本站缓存、渐进加载与局部环境色增强', () => {
  assert.match(source, /function cachedCoverUrl/);
  assert.match(source, /function createCoverMedia/);
  assert.match(source, /function scheduleCoverGlow/);
  assert.match(source, /image\.loading = 'lazy'/);
  assert.ok((source.match(/createCoverMedia\(/g) || []).length >= 5);
  assert.match(source, /\/api\/cover\?url=/);
  assert.match(css, /cover-shimmer/);
  assert.match(css, /--cover-glow/);
});

test('小时活跃度呈现 24 个可键盘聚焦且带准确文本的桶', () => {
  const start = source.indexOf('function renderHourlyActivity');
  const end = source.indexOf('function renderPlaylistSelect', start);
  const renderer = source.slice(start, end);
  assert.match(renderer, /buckets\.length !== 24/);
  assert.match(renderer, /cell\.type = 'button'/);
  assert.match(renderer, /distinct_songs/);
  assert.match(renderer, /percentFormat/);
  assert.match(renderer, /aria-label/);
  assert.match(renderer, /占可按小时统计的播放/);
  assert.doesNotMatch(renderer, /占已统计时段播放/);
  assert.match(css, /grid-template-columns: repeat\(24/);
  assert.match(css, /grid-template-columns: repeat\(12/);
});

test('图标使用本地 Lucide SVG sprite，不再用字符充当控件图标', () => {
  assert.match(html, /data-lucide-version="0\.468\.0"/);
  assert.match(html, /id="icon-rotate-cw"/);
  assert.match(html, /id="icon-disc3"/);
  assert.match(html, /class="brand__mark" src="\/logo\.png"/);
  assert.match(html, /rel="icon"[^>]+href="\/favicon\.png"/);
  assert.match(html, /rel="apple-touch-icon" href="\/logo\.png"/);
  assert.doesNotMatch(`${html}\n${source}`, /↻|‹|›/);
});

test('空日期只合并连续且状态相同的日期，保留有歌曲的行', () => {
  const start = source.indexOf('function groupMosaicDays');
  const end = source.indexOf('function renderMosaic', start);
  const group = vm.runInNewContext(`${source.slice(start, end)}; groupMosaicDays`);
  const items = [
    { date: '2026-10-08', songs: [{}] },
    { date: '2026-10-07', reason: 'gap', songs: [] },
    { date: '2026-10-06', reason: 'gap', songs: [] },
    { date: '2026-10-05', reason: 'empty', songs: [] },
    { date: '2026-10-03', reason: 'empty', songs: [] },
  ];
  const result = group(items);
  assert.equal(result.length, 4);
  assert.equal(result[0].songs.length, 1);
  assert.equal(result[1].days.length, 2);
  assert.equal(result[2].reason, 'empty');
  assert.equal(items[1].days, undefined);
});

test('同一封面只取色一次，减少动态效果时不安排取色', () => {
  let reads = 0;
  const pending = [];
  const reducedMotion = { matches: false };
  const start = source.indexOf('const coverGlowCache');
  const end = source.indexOf('function createCoverMedia', start);
  const schedule = vm.runInNewContext(`${source.slice(start, end)}; scheduleCoverGlow`, {
    reducedMotion,
    window: { requestIdleCallback: (fn) => pending.push(fn) },
    document: { createElement: () => ({ getContext: () => ({
      drawImage() {},
      getImageData() { reads++; return { data: [100, 80, 60, 255] }; },
    }) }) },
  });
  const colors = [];
  const target = { style: { setProperty: (_name, value) => colors.push(value) } };
  schedule({ src: '/cover/a' }, target);
  schedule({ src: '/cover/a' }, target);
  pending.splice(0).forEach((fn) => fn());
  assert.equal(reads, 1);
  assert.equal(colors.length, 2);
  assert.equal(colors[0], colors[1]);
  reducedMotion.matches = true;
  schedule({ src: '/cover/b' }, target);
  assert.equal(pending.length, 0);
});
