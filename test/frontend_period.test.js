import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('顶部周期切换只刷新概览卡片，不重载封面墙或其他模块', () => {
  const handlerStart = source.indexOf("const period = event.target.closest('[data-period]')");
  const handlerEnd = source.indexOf("const dimension = event.target.closest('[data-dimension]')");
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /loadPeriodOverview\(\)/);
  assert.doesNotMatch(handler, /loadDashboard\(\)/);

  const loaderStart = source.indexOf('async function loadPeriodOverview()');
  const loaderEnd = source.indexOf('function renderRanking', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert.match(loader, /\/api\/overview/);
  assert.doesNotMatch(loader, /daily-top-songs|\/api\/ranking|\/api\/trend|renderMosaic/);
});

test('排行维度切换只请求本地 ranking 接口', () => {
  const handlerStart = source.indexOf("const dimension = event.target.closest('[data-dimension]')");
  const handlerEnd = source.indexOf("const granularity = event.target.closest('[data-granularity]')");
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /loadRanking\(\)/);
  assert.doesNotMatch(handler, /loadDashboard\(\)/);

  const loaderStart = source.indexOf('async function loadRanking()');
  const loaderEnd = source.indexOf('async function loadTrend()', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert.match(loader, /\/api\/ranking/);
  assert.doesNotMatch(loader, /record\/recent|listen\/data\/today|\/api\/trend|loadDashboard/);
});

test('趋势粒度切换只请求本地 trend 接口', () => {
  const handlerStart = source.indexOf("const granularity = event.target.closest('[data-granularity]')");
  const handlerEnd = source.indexOf("const pager = event.target.closest('[data-pager]')");
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /loadTrend\(\)/);
  assert.doesNotMatch(handler, /loadDashboard\(\)/);

  const loaderStart = source.indexOf('async function loadTrend()');
  const loaderEnd = source.indexOf('function renderPager', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert.match(loader, /\/api\/trend/);
  assert.doesNotMatch(loader, /record\/recent|listen\/data\/today|\/api\/ranking|loadDashboard/);
});

test('趋势图按时间周期纵向排列并渲染横向柱与播放次数', () => {
  const start = source.indexOf('function renderTrend');
  const end = source.indexOf('function shortBucket', start);
  const renderer = source.slice(start, end);
  assert.match(renderer, /trend-bar__label/);
  assert.match(renderer, /trend-bar__track/);
  assert.match(renderer, /trend-bar__fill/);
  assert.match(renderer, /--bar-width/);
  assert.match(renderer, /trend-bar__value/);
  assert.match(renderer, /value\.textContent = formatNumber\(point\.plays \|\| 0\)/);
  assert.match(renderer, /bar\.append\(label, track, value\)/);
});

test('封面墙、歌曲行和歌单封面统一使用本站封面缓存', () => {
  assert.match(source, /function cachedCoverUrl/);
  assert.ok((source.match(/cachedCoverUrl\(/g) || []).length >= 4);
  assert.match(source, /\/api\/cover\?url=/);
});
