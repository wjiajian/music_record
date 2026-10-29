import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('统计窗口切换同时刷新概览与排行，不重载趋势、封面墙、最近播放或歌单', () => {
  const handlerStart = source.indexOf("const windowButton = event.target.closest('[data-window]')");
  const handlerEnd = source.indexOf("const dimension = event.target.closest('[data-dimension]')");
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /state\.window = windowButton\.dataset\.window/);
  assert.match(handler, /loadWindowData\(\)/);
  assert.doesNotMatch(handler, /loadDashboard\(\)|loadTrend\(\)|renderMosaic/);

  const loaderStart = source.indexOf('async function loadWindowData()');
  const loaderEnd = source.indexOf('// 排行维度', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert.match(loader, /\/api\/overview[\s\S]*period: state\.window/);
  assert.match(loader, /\/api\/ranking[\s\S]*period: state\.window/);
  assert.doesNotMatch(loader, /\/api\/trend|daily-top-songs|record\/recent|listen\/data\/today|\/api\/playlists/);
});

test('排行维度切换只请求当前统计窗口的本地 ranking 接口', () => {
  const handlerStart = source.indexOf("const dimension = event.target.closest('[data-dimension]')");
  const handlerEnd = source.indexOf("const granularity = event.target.closest('[data-granularity]')");
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /loadRanking\(\)/);
  assert.doesNotMatch(handler, /loadDashboard\(\)|loadTrend\(\)/);

  const loaderStart = source.indexOf('async function loadRanking()');
  const loaderEnd = source.indexOf('async function loadTrend()', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert.match(loader, /\/api\/ranking/);
  assert.match(loader, /period: state\.window/);
  assert.doesNotMatch(loader, /record\/recent|listen\/data\/today|\/api\/trend|loadDashboard/);
});

test('趋势周期切换只刷新趋势图，不影响排行或统计窗口', () => {
  const handlerStart = source.indexOf("const granularity = event.target.closest('[data-granularity]')");
  const handlerEnd = source.indexOf("const pager = event.target.closest('[data-pager]')");
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /state\.granularity = granularity\.dataset\.granularity/);
  assert.match(handler, /loadTrend\(\)/);
  assert.doesNotMatch(handler, /loadRanking\(\)|state\.window\s*=|loadWindowData\(\)|loadDashboard\(\)/);

  const loaderStart = source.indexOf('async function loadTrend()');
  const loaderEnd = source.indexOf('async function loadDashboard()', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert.match(loader, /\/api\/trend/);
  assert.match(loader, /state\.granularity === 'day' \? 30 : 12/);
  assert.doesNotMatch(loader, /\/api\/ranking|record\/recent|listen\/data\/today|loadDashboard/);

  const dashboardStart = source.indexOf('async function loadDashboard()');
  const dashboardEnd = source.indexOf("document.addEventListener('click'", dashboardStart);
  const dashboard = source.slice(dashboardStart, dashboardEnd);
  assert.match(dashboard, /\/api\/ranking[\s\S]*period: state\.window/);
  assert.doesNotMatch(source, /rankingPeriod|listen\/data\/today/);
});

test('页面说明准确描述统计窗口与趋势周期的作用范围', () => {
  assert.match(html, /aria-label="统计窗口；同时控制概览与排行"/);
  assert.match(html, /aria-label="趋势周期"/);
  assert.doesNotMatch(html, /同时切换排行周期|统计窗口可联动排行与趋势/);
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

test('顶部栏常驻吸顶，不再随滚动隐藏', () => {
  assert.doesNotMatch(source, /updateTopbarOnScroll|scheduleTopbarUpdate|is-hidden/);
  const topbarRule = css.slice(css.indexOf('.topbar {'), css.indexOf('.topbar__inner'));
  assert.match(topbarRule, /position: sticky/);
});

test('最近播放与今日足迹合并为一份带时间的列表', () => {
  assert.doesNotMatch(html, /todayList|recentFreshness|todayFreshness|crystal-list/);
  assert.doesNotMatch(source, /renderToday|recentFreshness|todayFreshness/);
  assert.match(source, /song-row--timed/);
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

test('趋势坐标使用等宽小字，且不描边', () => {
  const axisRule = css.slice(css.indexOf('.trend-axis-label'), css.indexOf('.trend-current-line'));
  assert.match(axisRule, /font-family: var\(--mono\)/);
  assert.match(axisRule, /font-size: 12px/);
  assert.match(axisRule, /font-weight: 400/);
  assert.match(axisRule, /stroke: none/);
  assert.match(source, /'dominant-baseline': 'middle'/);
});

test('封面区移除中文标题，并彻底移除系统诊断区', () => {
  assert.doesNotMatch(html, /七日封面账本|系统诊断账本|class="diagnostics"|icon-cpu/);
  assert.doesNotMatch(source, /diagnosticService|diagnosticQuality|diagnosticGap/);
  assert.doesNotMatch(css, /\.diagnostics/);
});

test('封面统一走本站缓存与渐进加载，不再做取色光晕', () => {
  assert.match(source, /function cachedCoverUrl/);
  assert.match(source, /function createCoverMedia/);
  assert.match(source, /image\.loading = 'lazy'/);
  assert.ok((source.match(/createCoverMedia\(/g) || []).length >= 4);
  assert.match(source, /\/api\/cover\?url=/);
  assert.doesNotMatch(source, /scheduleCoverGlow|coverGlowCache/);
  assert.doesNotMatch(css, /--cover-glow|cover-shimmer/);
  assert.match(source, /const MOSAIC_COLUMNS = 10/);
});

test('小时活跃度呈现 24 个可键盘聚焦且带准确文本的桶', () => {
  const start = source.indexOf('function renderHourlyActivity');
  const end = source.indexOf('function renderPlaylists', start);
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
  assert.match(html, /rel="icon"[^>]+href="\/favicon\.svg"/);
  assert.match(html, /rel="icon"[^>]+href="\/favicon\.png"/);
  assert.match(html, /<use href="#logo-mark">/);
  assert.match(html, /rel="apple-touch-icon" href="\/logo\.png"/);
  assert.doesNotMatch(`${html}\n${source}`, /↻|‹|›/);
  // 生产环境不依赖 Google Fonts（国内不可达）。
  assert.doesNotMatch(`${html}\n${css}`, /fonts\.googleapis\.com/);
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

test('标题日期使用中文数字', () => {
  const start = source.indexOf('function chineseNumber');
  const end = source.indexOf('function toLocalDate', start);
  const chineseNumber = vm.runInNewContext(`${source.slice(start, end)}; chineseNumber`, {
    CN_DIGITS: ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'],
  });
  assert.equal(chineseNumber(3), '三');
  assert.equal(chineseNumber(10), '十');
  assert.equal(chineseNumber(12), '十二');
  assert.equal(chineseNumber(20), '二十');
  assert.equal(chineseNumber(23), '二十三');
  assert.equal(chineseNumber(31), '三十一');
});

test('手机上趋势图换用窄画布，并在宽度变化时重画', () => {
  const start = source.indexOf('function renderTrend');
  const end = source.indexOf('function renderHourlyActivity', start);
  const renderer = source.slice(start, end);
  assert.match(source, /const compactChart = window\.matchMedia\('\(max-width: 640px\)'\)/);
  assert.match(renderer, /compact \? 360 : 900/);
  assert.match(source, /compactChart\.addEventListener\('change'/);
});

test('图表元素点击后把说明写到区块下方，触屏也能看到明细', () => {
  for (const id of ['trendDetail', 'hourlyDetail', 'mosaicDetail']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(source, new RegExp(`'${id}'`));
  }
  assert.match(source, /event\.target\.closest\('\[data-detail\]'\)/);
  assert.match(css, /\.detail-line:empty/);
});

test('品牌名统一为音乐记录，页面不再放概括句', () => {
  assert.match(html, /<title>音乐记录<\/title>/);
  assert.match(html, /class="brand__name">音乐记录</);
  assert.doesNotMatch(`${html}\n${source}`, /声波时间账本|music record|heroSummary|trendSummary|describeTrend/);
});

test('歌曲、歌手、专辑标题点开详情抽屉，网易云外链收进抽屉顶栏', () => {
  const start = source.indexOf('function createTitle');
  const end = source.indexOf('function getInsufficientText', start);
  const creator = source.slice(start, end);
  assert.match(creator, /dataset\.entity = type/);
  assert.doesNotMatch(creator, /music\.163\.com/);
  assert.match(html, /<dialog class="drawer" id="drawer"/);
  assert.match(html, /id="drawerExternal"/);
  assert.match(source, /\/api\/detail\/\$\{dimension\}/);
  assert.match(source, /event\.target\.closest\('\[data-entity\]'\)/);
});

test('听歌日历复用趋势逐日序列，区分还没开始记录、数据未知与确认的零播放', () => {
  const start = source.indexOf('function calendarDays');
  const end = source.indexOf('function calendarValue', start);
  const calendarDays = vm.runInNewContext(`${source.slice(start, end)}; calendarDays`);
  const days = calendarDays([
    { start: '2026-01-01', plays: 0, missing: true },
    { start: '2026-01-02', plays: 3, missing: false },
    { start: '2026-01-03', plays: 0, missing: true },
    { start: '2026-01-04', plays: 0, missing: false },
    { start: '2026-01-05', plays: 2, missing: false, estimated: true },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(days.map((day) => day.state))), ['blank', 'played', 'gap', 'zero', 'estimated']);

  const loaderStart = source.indexOf('async function loadCalendar');
  const loader = source.slice(loaderStart, source.indexOf('function renderCalendarDetail', loaderStart));
  assert.match(loader, /\/api\/trend/);
  assert.match(loader, /granularity: 'day'/);
  assert.match(html, /<a href="#calendar">日历<\/a>/);
});

test('深色模式跟随系统也可手动指定，主题在样式生效前写上，颜色只走令牌', () => {
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.match(css, /:root\[data-theme="dark"\] \{/);
  assert.ok(html.indexOf("localStorage.getItem('music-record-theme')") < html.indexOf('href="/styles.css"'));
  assert.match(html, /id="themeToggle"/);
  assert.doesNotMatch(css, /rgba\(249, 248, 245/);
});

test('切换动画：排行行带稳定的 view-transition-name，减少动效或不支持时直接替换', () => {
  const start = source.indexOf('function withViewTransition');
  const helper = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(helper, /!document\.startViewTransition \|\| reducedMotion\.matches/);
  assert.match(source, /row\.style\.viewTransitionName = `rank-\$\{state\.dimension\}-\$\{item\.id\}`/);
  assert.match(css, /:root\[data-vt="swap"\]::view-transition-old\(root\)/);
  assert.match(source, /function syncSwitchIndicators/);
});

test('换主题从右下往左上斜向擦过：先拉开一段、停顿、再铺满，期间整页作为一张快照', () => {
  const keyframes = css.slice(css.indexOf('@keyframes theme-reveal'), css.indexOf('}\n}', css.indexOf('@keyframes theme-reveal')));
  assert.match(keyframes, /0% \{\s*clip-path: polygon\(100% 100%, 100% 100%, 100% 100%\)/);
  assert.match(keyframes, /30%,\s*46% \{\s*clip-path: polygon\(100% 100%, 100% 72%, 72% 100%\)/);
  assert.match(keyframes, /100% \{\s*clip-path: polygon\(100% 100%, 100% -110%, -110% 100%\)/);
  assert.match(css, /:root\[data-vt="theme"\]::view-transition-new\(root\) \{\s*animation: theme-reveal/);
  assert.match(css, /:root\[data-vt="theme"\] \.rank-row,[\s\S]*?view-transition-name: none !important/);
  assert.match(source, /\}, 'theme'\);/);
});

test('封面墙同曲联动：指到或聚焦一格时同一首歌高亮，其余变淡', () => {
  assert.match(source, /function linkMosaicSong/);
  assert.match(source, /nodes\.mosaic\.addEventListener\('pointerover'/);
  assert.match(source, /nodes\.mosaic\.addEventListener\('focusin'/);
  assert.match(css, /\.mosaic\[data-linked-song\] \.mosaic-cover:not\(\.is-linked\)/);
});

test('封面取色只用于详情抽屉，灰色像素不参与', () => {
  const start = source.indexOf('function rgbToHsl');
  const end = source.indexOf('function sampleCoverTone', start);
  const rgbToHsl = vm.runInNewContext(`${source.slice(start, end)}; rgbToHsl`);
  assert.deepEqual(JSON.parse(JSON.stringify(rgbToHsl(255, 0, 0))), [0, 1, 0.5]);
  assert.equal(rgbToHsl(128, 128, 128)[1], 0);
  assert.ok(Math.abs(rgbToHsl(0, 0, 255)[0] - 2 / 3) < 1e-9);
  assert.match(css, /\.drawer\.has-tone \{/);
  assert.equal((css.match(/has-tone/g) || []).length, 1);
});

test('最近播放显示封面，歌单索引与曲目左右排列', () => {
  const start = source.indexOf('function makeTimedRow');
  const end = source.indexOf('function renderRecent', start);
  assert.match(source.slice(start, end), /createCoverMedia\(/);
  assert.match(html, /class="playlist-layout"[\s\S]*class="playlist-index"[\s\S]*class="tracks"/);
  assert.match(css, /\.playlist-layout \{[^}]*grid-template-columns: minmax\(0, 2fr\) minmax\(0, 3fr\)/);
});
