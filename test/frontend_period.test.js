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

test('浏览器栏颜色首屏就对：两档 theme-color 跟随系统，与 --n-1 一致；手动主题在页头脚本里先改', () => {
  const lightPage = css.match(/:root \{[\s\S]*?--n-1: (#[0-9a-f]{6});/)[1];
  const darkPage = css.match(/:root\[data-theme="dark"\] \{[\s\S]*?--n-1: (#[0-9a-f]{6});/)[1];
  assert.match(html, new RegExp(`<meta name="theme-color" content="${lightPage}" media="\\(prefers-color-scheme: light\\)">`));
  assert.match(html, new RegExp(`<meta name="theme-color" content="${darkPage}" media="\\(prefers-color-scheme: dark\\)">`));
  const inline = html.slice(html.indexOf("localStorage.getItem('music-record-theme')"), html.indexOf('</script>'));
  assert.match(inline, new RegExp(`theme === 'dark' \\? '${darkPage}' : '${lightPage}'`));
  assert.match(source, /nodes\.themeColors\.forEach/);
});

test('别的标签页改了主题，本页通过 storage 事件立即同步', () => {
  const start = source.indexOf("window.addEventListener('storage'");
  assert.ok(start > 0);
  const handler = source.slice(start, source.indexOf('\n});', start));
  assert.match(handler, /event\.key !== THEME_KEY && event\.key !== null/);
  assert.match(handler, /storedTheme\(\)/);
  assert.match(handler, /syncThemeControls\(\)/);
});

test('过渡回调抛错：原始错误打到控制台，标记照常撤掉，不留未处理的 Promise 拒绝', async () => {
  const start = source.indexOf('function withViewTransition');
  const helper = source.slice(start, source.indexOf('\n}\n', start) + 2);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const root = { dataset: {} };
    const errors = [];
    const failure = new Error('render boom');
    // 假的 View Transition：回调在微任务里跑，ready / updateCallbackDone / finished 都随回调失败而 reject。
    const document = {
      documentElement: root,
      hidden: false,
      startViewTransition(update) {
        const done = Promise.resolve().then(update);
        return { ready: done, updateCallbackDone: done, finished: done };
      },
    };
    const withViewTransition = vm.runInNewContext(`let viewTransitionToken = 0; ${helper}; withViewTransition`, {
      document,
      reducedMotion: { matches: false },
      console: { error: (error) => errors.push(error) },
    });
    withViewTransition(() => {
      throw failure;
    }, 'theme');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(errors, [failure]);
    assert.equal(root.dataset.vt, undefined);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('日历在过渡回调里再核对请求号，较早的年份不会覆盖较新的请求', () => {
  const start = source.indexOf('async function loadCalendar');
  const loader = source.slice(start, source.indexOf('\n}\n', start));
  const update = loader.slice(loader.indexOf('const update = () => {'));
  assert.match(update, /^const update = \(\) => \{\s*if \(requestId !== calendarRequestId\) return;/);
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
  // 时长也要锁住：改成 0s 时关键帧还在，但擦除会瞬间完成。
  const applied = css.match(/:root\[data-vt="theme"\]::view-transition-new\(root\) \{\s*animation: theme-reveal (\d*\.?\d+)(m?s) both;/);
  assert.ok(applied, '主题动画应写成 animation: theme-reveal <时长> both');
  const seconds = Number(applied[1]) / (applied[2] === 'ms' ? 1000 : 1);
  assert.equal(seconds, 1.15);
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

test('sampleCoverTone：灰色封面不取色，彩色封面取到对应色相', () => {
  // Node 里没有 canvas：用假的 2D 上下文按给定像素填满 getImageData，其余按真实逻辑跑。
  const start = source.indexOf('const coverToneCache');
  const end = source.indexOf('function applyDetailTone', start);
  const sampler = (pixels) => {
    const document = {
      createElement: () => ({
        getContext: () => ({
          clearRect() {},
          drawImage() {},
          getImageData: (_x, _y, width, height) => ({
            data: Uint8ClampedArray.from({ length: width * height * 4 }, (_, index) => pixels(Math.floor(index / 4))[index % 4]),
          }),
        }),
      }),
    };
    return vm.runInNewContext(`${source.slice(start, end)}; sampleCoverTone`, { document });
  };

  // 中灰底 + 深灰方块：饱和度为零，不应取色。
  const grey = sampler((pixel) => (pixel % 24 > 6 && pixel % 24 < 18 ? [40, 40, 40, 255] : [128, 128, 128, 255]));
  assert.equal(grey({ src: 'grey.png' }), null);

  // 米白底上一大块蓝：取到蓝色附近的色相，饱和度落在 28–60 之间。
  const blue = sampler((pixel) => (pixel % 24 > 3 && pixel % 24 < 20 ? [47, 93, 138, 255] : [244, 241, 234, 255]));
  const tone = blue({ src: 'blue.png' });
  assert.ok(tone && Math.abs(tone.hue - 210) <= 3, `蓝色封面色相应在 210° 附近，实际 ${tone?.hue}`);
  assert.ok(tone.saturation >= 28 && tone.saturation <= 60);
});

test('最近播放显示封面，歌单索引与曲目左右排列', () => {
  const start = source.indexOf('function makeTimedRow');
  const end = source.indexOf('function renderRecent', start);
  assert.match(source.slice(start, end), /createCoverMedia\(/);
  assert.match(html, /class="playlist-layout"[\s\S]*class="playlist-index"[\s\S]*class="tracks"/);
  assert.match(css, /\.playlist-layout \{[^}]*grid-template-columns: minmax\(0, 2fr\) minmax\(0, 3fr\)/);
});

test('趋势换周期改为描线：不再走 View Transition 淡入淡出，宽度变化重画时不描', () => {
  const loaderStart = source.indexOf('async function loadTrend()');
  const loader = source.slice(loaderStart, source.indexOf('\n}\n', loaderStart));
  assert.doesNotMatch(loader, /withViewTransition/);
  assert.match(loader, /renderTrend\(trend, latestHealth, \{ animate: true \}\)/);
  assert.match(source, /if \(lastTrend\) renderTrend\(lastTrend\.payload, lastTrend\.health\);/);

  const start = source.indexOf('function renderTrend');
  const renderer = source.slice(start, source.indexOf('function renderHourlyActivity', start));
  assert.match(renderer, /class: 'trend-areas'/);
  assert.match(renderer, /class: 'trend-plot'/);
  assert.match(renderer, /areas\.append\(makeSvgElement\('path', \{ d: area, class: 'trend-area' \}\)\)/);
  assert.match(renderer, /plot\.append\(circle\)/);
  assert.match(renderer, /figure\.classList\.toggle\('is-drawing', animate\)/);

  assert.match(css, /@keyframes trend-draw \{\s*from \{ clip-path: inset\(-8px calc\(100% \+ 8px\) -8px -8px\); \}/);
  // backwards：播完撤掉裁剪，静止时折线描边不被切。
  assert.match(css, /\.trend-figure\.is-drawing \.trend-plot \{\s*animation: trend-draw [^;]* backwards;/);
  assert.doesNotMatch(css, /view-transition-name: trend-chart|:root\[data-vt="theme"\] \.trend-chart/);
});

test('柱子错开长出；区块未进场时先停住，减少动效时连延迟一起归零', () => {
  assert.match(source, /cell\.style\.setProperty\('--i', String\(bucket\.hour\)\)/);
  assert.match(css, /\.hour-cell__bar \{[^}]*animation: bar-grow [^;]*calc\(var\(--i, 0\) \* 16ms\) backwards;/);
  assert.match(source, /style: `--at: \$\{\(index \/ series\.length\)\.toFixed\(3\)\}`/);
  assert.match(source, /style: `--at: \$\{\(bucket\.hour \/ 24\)\.toFixed\(3\)\}`/);
  assert.match(css, /\.dc-bar,\s*\.dh-bar \{[^}]*transform-box: fill-box;[^}]*animation: bar-grow/);
  // 只挂上动画不够：关键帧得从 0 高度起步，柱子才真的是长出来的（终点省略，即回到柱子本身的高度）。
  assert.match(css, /@keyframes bar-grow \{\s*from \{ transform: scaleY\(0\); \}\s*\}/);
  assert.match(css, /\.hour-cell__bar \{[^}]*transform-origin: bottom;/);
  assert.match(css, /\.dc-bar,\s*\.dh-bar \{[^}]*transform-origin: bottom;/);

  const pause = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
  assert.match(pause, /^@media \(prefers-reduced-motion: no-preference\) \{\s*\.reveal:not\(\.is-revealed\) :is\(\.trend-plot, \.trend-areas, \.hour-cell__bar\) \{\s*animation-play-state: paused;/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /animation-delay: 0ms !important;/);
});

test('抽屉里前进从右边推入、返回从左边推回，内容到了再淡入', () => {
  const start = source.indexOf('async function openDetail');
  const opener = source.slice(start, source.indexOf('\n}\n', start));
  // 起点按方向偏开，终点必须回到原位、完全不透明，内容才算推到位。
  assert.match(opener, /if \(navigating\) \{\s*playMotion\(nodes\.drawerBody, \[\s*\{ opacity: 0, transform: `translateX\(\$\{remember \? 32 : -32\}px\)` \},\s*\{ opacity: 1, transform: 'none' \},\s*\]/);
  assert.match(opener, /for \(const section of nodes\.drawerBody\.children\) playMotion\(section/);
  assert.match(source, /openDetail\(previous\.dimension, previous\.id, \{ remember: false \}\)/);
  assert.match(css, /\.drawer \{[^}]*overflow-x: hidden;/);
});

test('日历当天面板：首次从 0 展开，换天平滑改高并整块淡入，同一天只在骨架换成歌曲时淡入列表', async () => {
  const helperStart = source.indexOf('const MOTION_EASE');
  const helper = source.slice(helperStart, source.indexOf('// 用 View Transitions', helperStart));
  const start = source.indexOf('let calDetailResize = null;');
  const end = source.indexOf('function renderCalendarDetail', start);

  const fades = [];
  const node = (name, height, extra = {}) => ({
    name,
    height,
    ...extra,
    animate() {
      fades.push(name);
      return { finished: new Promise(() => {}), cancel() {} };
    },
  });
  const resizes = [];
  const classes = new Set();
  const px = (value) => Number.parseFloat(value);
  const panel = {
    hidden: true,
    children: [],
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    replaceChildren(...nodes) { this.children = nodes; },
    querySelector(selector) {
      if (selector === '.skeleton') return this.children.find((child) => child.skeleton) || null;
      if (selector === '.cal-detail__songs') return this.children.find((child) => child.songs) || null;
      return null;
    },
    // 过渡还在跑时量到的是过渡中途的高度（这里取起止中点），停掉或播完之后才是内容的自然高度。
    getBoundingClientRect() {
      const running = resizes.find((entry) => !entry.cancelled && !entry.done);
      if (running) return { height: (px(running.keyframes[0].height) + px(running.keyframes[1].height)) / 2 };
      return { height: this.children.reduce((sum, child) => sum + child.height, 0) };
    },
    animate(keyframes) {
      let resolve;
      const entry = {
        keyframes: JSON.parse(JSON.stringify(keyframes)),
        cancelled: false,
        done: false,
        finished: new Promise((settle) => { resolve = settle; }),
        cancel() { this.cancelled = true; },
        finish() { this.done = true; resolve(); },
      };
      resizes.push(entry);
      return entry;
    },
  };
  const reducedMotion = { matches: false };
  const show = vm.runInNewContext(`${helper}; ${source.slice(start, end)}; showCalendarDetail`, {
    reducedMotion,
    document: { hidden: false },
    nodes: { calDetail: panel },
    getComputedStyle: () => ({ marginTop: '24px' }),
  });

  // 首次出现：从 0 展开，连上边距一起；所有块淡入。
  show('2026-10-01', [node('head', 20), node('list', 200, { songs: true, skeleton: true })]);
  assert.equal(panel.hidden, false);
  assert.deepEqual(resizes[0].keyframes, [{ height: '0px', marginTop: '0px' }, { height: '220px', marginTop: '24px' }]);
  assert.ok(classes.has('is-resizing'));
  assert.deepEqual(fades, ['head', 'list']);

  // 展开播完：撤掉裁剪。同一天骨架换成歌曲、高度不变：不改高，只淡入列表。
  resizes[0].finish();
  await new Promise((settle) => setImmediate(settle));
  assert.ok(!classes.has('is-resizing'));
  fades.length = 0;
  show('2026-10-01', [node('head', 20), node('songs', 200, { songs: true })]);
  assert.equal(resizes.length, 1);
  assert.deepEqual(fades, ['songs']);

  // 同一天内容不变的重画（切次数/时长）：不淡入、不改高。
  fades.length = 0;
  show('2026-10-01', [node('head', 20), node('songs', 200, { songs: true })]);
  assert.equal(fades.length, 0);
  assert.equal(resizes.length, 1);

  // 换到一天没播放的：从旧高度过渡到新高度，整块淡入。
  show('2026-10-02', [node('head', 20), node('text', 30)]);
  assert.deepEqual(resizes[1].keyframes, [{ height: '220px' }, { height: '50px' }]);
  assert.deepEqual(fades, ['head', 'text']);

  // 过渡中途又换天：停掉上一段，从中途的高度接着过渡，裁剪保持。
  show('2026-10-03', [node('head', 20), node('list', 200, { songs: true })]);
  assert.equal(resizes[1].cancelled, true);
  assert.deepEqual(resizes[2].keyframes, [{ height: '135px' }, { height: '220px' }]);
  assert.ok(classes.has('is-resizing'));
  // 被停掉那段的 finished 晚到也不能撤掉新一段的裁剪。
  resizes[1].finish();
  await new Promise((settle) => setImmediate(settle));
  assert.ok(classes.has('is-resizing'));

  // 减少动效：照常换内容，不播任何动画；进行中的过渡被停掉、裁剪撤掉。
  fades.length = 0;
  reducedMotion.matches = true;
  show('2026-10-04', [node('head', 20), node('text', 30)]);
  assert.equal(resizes[2].cancelled, true);
  assert.equal(resizes.length, 3);
  assert.ok(!classes.has('is-resizing'));
  assert.equal(fades.length, 0);
  assert.equal(panel.children.length, 2);
});
