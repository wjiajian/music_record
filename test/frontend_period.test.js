import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('统计窗口切换同时刷新概览与排行，不重载趋势、封面墙、实时流或歌单', () => {
  const handlerStart = source.indexOf("const windowButton = event.target.closest('[data-window]')");
  const handlerEnd = source.indexOf("const dimension = event.target.closest('[data-dimension]')");
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /state\.window = windowButton\.dataset\.window/);
  assert.match(handler, /loadWindowData\(\)/);
  assert.doesNotMatch(handler, /loadDashboard\(\)|loadTrend\(\)|renderMosaic/);

  const loaderStart = source.indexOf('async function loadWindowData()');
  const loaderEnd = source.indexOf('// 排行维度', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert.match(loader, /\/api\/overview/);
  assert.match(loader, /\/api\/ranking/);
  assert.ok((loader.match(/period: state\.window/g) || []).length >= 2);
  assert.doesNotMatch(loader, /\/api\/trend|daily-top-songs|record\/recent|listen\/data\/today|\/api\/playlists/);
});

test('排行维度切换只请求当前统计窗口的本地 ranking 接口', () => {
  const handlerStart = source.indexOf("const dimension = event.target.closest('[data-dimension]')");
  const handlerEnd = source.indexOf("const granularity = event.target.closest('[data-granularity]')");
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /loadRanking\(\)/);
  assert.doesNotMatch(handler, /loadDashboard\(\)|loadTrend\(\)/);

  const loaderStart = source.indexOf('async function loadRanking()');
  const loaderEnd = source.indexOf('// 趋势粒度', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert.match(loader, /\/api\/ranking/);
  assert.match(loader, /period: state\.window/);
  assert.doesNotMatch(loader, /record\/recent|listen\/data\/today|\/api\/trend|loadDashboard/);
});

test('趋势粒度与统计窗口解耦，只刷新固定范围趋势', () => {
  const handlerStart = source.indexOf("const granularity = event.target.closest('[data-granularity]')");
  const handlerEnd = source.indexOf("const pager = event.target.closest('[data-pager]')");
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /state\.granularity = granularity\.dataset\.granularity/);
  assert.match(handler, /loadTrend\(\)/);
  assert.doesNotMatch(handler, /loadRanking\(\)|state\.window|loadDashboard\(\)/);

  const loaderStart = source.indexOf('async function loadTrend()');
  const loaderEnd = source.indexOf('async function loadDashboard()', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert.match(loader, /\/api\/trend/);
  assert.match(loader, /state\.granularity === 'day' \? 30 : 12/);
  assert.doesNotMatch(loader, /\/api\/ranking|record\/recent|listen\/data\/today|loadDashboard/);
});

test('趋势使用直线分段面积图，在缺口中断并标记当前桶', () => {
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
