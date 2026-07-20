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
