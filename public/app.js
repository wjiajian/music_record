const state = {
  window: 'day',
  dimension: 'song',
  granularity: 'day',
  playlistId: null,
  playlistOffset: 0,
  trackOffset: 0,
  calendarYear: new Date().getFullYear(),
  calendarMetric: 'plays',
  calendarDay: null,
};

let latestHealth = { have_days: 0 };
let overviewRequestId = 0;
let rankingRequestId = 0;
let trendRequestId = 0;
let calendarRequestId = 0;
let calendarDayRequestId = 0;
let detailRequestId = 0;
let viewTransitionToken = 0;
let lastTrend = null;
let lastCalendar = null;
let calendarDayMap = new Map();
const calendarTopSongs = new Map();
// 抽屉里从歌曲点到歌手、专辑时记下来路，「返回」逐层退回；关闭抽屉即清空。
let currentDetail = null;
const detailHistory = [];

const PLAYLIST_PAGE_SIZE = 10;
const TRACK_PAGE_SIZE = 10;
const MOSAIC_DAYS = 7;
const MOSAIC_COLUMNS = 10;
const CALENDAR_DAY_SONGS = 10;
const DETAIL_CHART_DAYS = 90;
// 抽屉里「统计窗口」的说法，与顶部窗口按钮一一对应。
const WINDOW_LABEL = { day: '今天', week: '近 7 天', month: '近 30 天', year: '近一年', all: '全部记录' };
const SVG_NS = 'http://www.w3.org/2000/svg';
const numberFormat = new Intl.NumberFormat('zh-CN');
const percentFormat = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const compactChart = window.matchMedia('(max-width: 640px)');
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
const THEME_KEY = 'music-record-theme';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

const nodes = {
  heroDate: document.querySelector('#heroDate'),
  heroSubtitle: document.querySelector('#heroSubtitle'),
  serviceStatus: document.querySelector('#serviceStatus'),
  serviceStatusText: document.querySelector('#serviceStatusText'),
  refreshButton: document.querySelector('#refreshButton'),
  metricPlays: document.querySelector('#metricPlays'),
  metricPlaysHint: document.querySelector('#metricPlaysHint'),
  metricHours: document.querySelector('#metricHours'),
  metricSongs: document.querySelector('#metricSongs'),
  metricDays: document.querySelector('#metricDays'),
  metricRange: document.querySelector('#metricRange'),
  rankingRange: document.querySelector('#rankingRange'),
  rankingList: document.querySelector('#rankingList'),
  recentList: document.querySelector('#recentList'),
  playlistList: document.querySelector('#playlistList'),
  playlistCount: document.querySelector('#playlistCount'),
  playlistPager: document.querySelector('#playlistPager'),
  playlistTracks: document.querySelector('#playlistTracks'),
  playlistTracksPager: document.querySelector('#playlistTracksPager'),
  playlistTrackTitle: document.querySelector('#playlistTrackTitle'),
  trackCount: document.querySelector('#trackCount'),
  trendChart: document.querySelector('#trendChart'),
  hourlyHeatmap: document.querySelector('#hourlyHeatmap'),
  hourlyMeta: document.querySelector('#hourlyMeta'),
  mosaic: document.querySelector('#mosaic'),
  mosaicSummary: document.querySelector('#mosaicSummary'),
  calYear: document.querySelector('#calYear'),
  calSummary: document.querySelector('#calSummary'),
  calNote: document.querySelector('#calNote'),
  calHeatmap: document.querySelector('#calHeatmap'),
  calLegend: document.querySelector('#calLegend'),
  calDetail: document.querySelector('#calDetail'),
  drawer: document.querySelector('#drawer'),
  drawerBody: document.querySelector('#drawerBody'),
  drawerExternal: document.querySelector('#drawerExternal'),
  drawerBack: document.querySelector('#drawerBack'),
  drawerClose: document.querySelector('#drawerClose'),
  themeToggle: document.querySelector('#themeToggle'),
  themeColors: document.querySelectorAll('meta[name="theme-color"]'),
  footerTimezone: document.querySelector('#footerTimezone'),
};

function icon(name, className = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  if (className) svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return numberFormat.format(value);
}

function chineseNumber(value) {
  if (value <= 10) return CN_DIGITS[value];
  if (value < 20) return `十${CN_DIGITS[value - 10]}`;
  const ones = value % 10;
  return `${CN_DIGITS[Math.floor(value / 10)]}十${ones ? CN_DIGITS[ones] : ''}`;
}

function toLocalDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || !timestamp) return null;
  const date = new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatPlayTime(value) {
  const date = toLocalDate(value);
  if (!date) return '未知时间';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// 今天的播放只显示时分，更早的带上月日。
function formatRecentTime(value) {
  const date = toLocalDate(value);
  if (!date) return '--:--';
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${time}`;
}

function formatRange(range) {
  if (!range?.start || !range?.end) return '统计数据还在生成';
  return range.start === range.end ? range.start : `${range.start} — ${range.end}`;
}

function formatDayLabel(isoDate) {
  if (!isoDate) return '--.--';
  const [year, month, day] = isoDate.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(year, month - 1, day).getDay()];
  return `${isoDate.slice(5).replace('-', '.')} ${weekday}`;
}

function cachedCoverUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return '';
  return `/api/cover?url=${encodeURIComponent(value)}`;
}

async function getJson(path, params = {}) {
  const query = new URLSearchParams(params);
  const search = query.toString();
  const url = search ? `${path}?${search}` : path;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function setActiveButtons() {
  const groups = [
    ['window', state.window],
    ['dimension', state.dimension],
    ['granularity', state.granularity],
  ];
  for (const [key, active] of groups) {
    document.querySelectorAll(`[data-${key}]`).forEach((button) => {
      const selected = button.dataset[key] === active;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }
  syncSwitchIndicators();
}

// 切换动画：分段按钮与标签页的选中块滑到新位置。滑块由脚本插入，没有脚本时仍是原来的选中底色/下划线。
function syncSwitchIndicator(group) {
  let indicator = group.querySelector(':scope > .switch-indicator');
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.className = 'switch-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    group.prepend(indicator);
    group.classList.add('has-indicator');
  }
  const active = group.querySelector(':scope > .is-active');
  indicator.hidden = !active;
  if (!active) return;
  indicator.style.setProperty('--x', `${active.offsetLeft}px`);
  indicator.style.setProperty('--y', `${active.offsetTop}px`);
  indicator.style.setProperty('--w', `${active.offsetWidth}px`);
  indicator.style.setProperty('--h', `${active.offsetHeight}px`);
  // 第一次定位不滑，之后才打开过渡。
  if (!indicator.classList.contains('is-ready')) requestAnimationFrame(() => indicator.classList.add('is-ready'));
}

function syncSwitchIndicators() {
  document.querySelectorAll('.segmented, .tabs').forEach(syncSwitchIndicator);
}

// 一次性的进场动画（Web Animations）：减少动效、页面在后台或不支持时不播，返回 null。
const MOTION_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
function playMotion(node, keyframes, options) {
  if (reducedMotion.matches || document.hidden || !node?.animate) return null;
  return node.animate(keyframes, { easing: MOTION_EASE, ...options });
}

// 用 View Transitions 把一次 DOM 替换变成动画：swap 只动被命名的区块（排行行、日历），theme 整页从右下往左上擦过。
// 不支持、减少动效或页面在后台时直接替换。
function withViewTransition(update, kind = 'swap') {
  if (!document.startViewTransition || reducedMotion.matches || document.hidden) {
    update();
    return;
  }
  const root = document.documentElement;
  const token = ++viewTransitionToken;
  root.dataset.vt = kind;
  const transition = document.startViewTransition(update);
  // 连点或翻页会打断过渡，ready 随之 reject；内容已照常更新，这里只是不让它变成未处理的错误。
  transition.ready.catch(() => {});
  // 更新回调本身抛错时 ready / finished 都会 reject：把原始错误打到控制台（和不用过渡时一样看得见），其余吞掉。
  transition.updateCallbackDone.catch((error) => console.error(error));
  // 新的过渡会打断旧的；只有最后一次过渡结束时才撤掉标记。
  transition.finished
    .catch(() => {})
    .finally(() => {
      if (token === viewTransitionToken) delete root.dataset.vt;
    });
}

function setMetricValue(node, text) {
  const raw = String(text);
  if (node.dataset.raw === raw) return;
  const previous = node.dataset.raw;
  const prefix = raw.startsWith('≥') ? '≥' : '';
  const digits = prefix ? raw.slice(1) : raw;
  const prefixNode = document.createElement('span');
  prefixNode.className = 'metric-prefix';
  prefixNode.textContent = prefix;
  const digitNode = document.createElement('span');
  digitNode.textContent = digits;
  node.replaceChildren(prefixNode, digitNode);
  node.dataset.raw = raw;
  if (previous && previous !== raw) playMotion(digitNode, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
}

function emptyState(title, text, { kind = 'empty', tag = 'div' } = {}) {
  const wrap = document.createElement(tag);
  wrap.className = `empty-state is-${kind}`;
  const strong = document.createElement('strong');
  strong.textContent = title;
  wrap.append(strong);
  if (text) {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    wrap.append(paragraph);
  }
  return wrap;
}

// 骨架块：--w / --h 让每行宽度、每根柱高略有不同，看起来像真实内容。
function skeleton(className, vars = {}) {
  const block = document.createElement('span');
  block.className = `skeleton ${className}`;
  for (const [key, value] of Object.entries(vars)) block.style.setProperty(`--${key}`, value);
  return block;
}

function skeletonLines(width) {
  const lines = document.createElement('span');
  lines.className = 'skeleton-lines';
  lines.append(skeleton('skeleton--line', { w: width }), skeleton('skeleton--line is-sub', { w: width }));
  return lines;
}

function skeletonRow(className, cells) {
  const row = document.createElement('li');
  row.className = `${className} is-skeleton`;
  row.setAttribute('aria-hidden', 'true');
  row.append(...cells);
  return row;
}

const SKELETON_WIDTHS = ['72%', '48%', '64%', '56%', '80%', '44%', '68%', '52%', '76%', '60%'];

// 首屏数据回来前，各区块先占好与真实布局同形的位置。
function renderSkeletons() {
  nodes.rankingList.replaceChildren(...SKELETON_WIDTHS.map((width) => skeletonRow('rank-row', [
    skeleton('skeleton--short'), skeleton('skeleton--cover'), skeletonLines(width), skeleton('skeleton--short'),
  ])));
  nodes.recentList.replaceChildren(...SKELETON_WIDTHS.map((width) => skeletonRow('song-row song-row--timed', [
    skeleton('skeleton--time'), skeleton('skeleton--cover'), skeletonLines(width),
  ])));
  nodes.trendChart.replaceChildren(skeleton('skeleton--chart'));
  nodes.hourlyHeatmap.replaceChildren(...Array.from({ length: 24 }, (_, hour) => {
    const cell = document.createElement('span');
    cell.className = 'hour-cell is-skeleton';
    cell.setAttribute('aria-hidden', 'true');
    const track = document.createElement('span');
    track.className = 'hour-cell__track';
    track.append(skeleton('skeleton--bar', { h: `${Math.round(30 + 25 * Math.sin(hour / 3.5))}%` }));
    cell.append(track, document.createElement('strong'));
    return cell;
  }));
  nodes.mosaic.replaceChildren(...SKELETON_WIDTHS.slice(0, 3).map(() => {
    const meta = document.createElement('span');
    meta.className = 'mosaic-row__meta';
    meta.append(skeletonLines('80%'));
    const covers = document.createElement('span');
    covers.className = 'mosaic-covers';
    covers.append(...Array.from({ length: MOSAIC_COLUMNS }, () => skeleton('mosaic-slot')));
    return skeletonRow('mosaic-row', [meta, covers]);
  }));
  nodes.playlistList.replaceChildren(...SKELETON_WIDTHS.slice(0, 6).map((width) => {
    const row = document.createElement('div');
    row.className = 'playlist-row is-skeleton';
    row.setAttribute('aria-hidden', 'true');
    row.append(skeleton('skeleton--line', { w: width }), skeleton('skeleton--short'));
    return row;
  }));
  nodes.playlistTracks.replaceChildren(...SKELETON_WIDTHS.slice(0, 6).map((width) => skeletonRow('song-row', [
    skeleton('skeleton--cover'), skeletonLines(width), skeleton('skeleton--short'),
  ])));
  nodes.calHeatmap.replaceChildren(skeleton('skeleton--chart'));
}

// 悬停提示在触屏上不可见，点击后把同一段说明写到区块下方。
function setDetail(targetId, text, selected = null) {
  const target = document.getElementById(targetId);
  if (!target) return;
  target.textContent = text;
  document.querySelectorAll(`[data-detail-target="${targetId}"]`).forEach((element) => {
    element.classList.toggle('is-selected', element === selected);
  });
}

function createCoverMedia(source, alt) {
  const media = document.createElement('span');
  media.className = 'cover-media';
  const cached = cachedCoverUrl(source);
  if (!cached) {
    media.classList.add('is-loaded', 'is-empty');
    return media;
  }
  const image = document.createElement('img');
  image.alt = alt;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('load', () => media.classList.add('is-loaded'), { once: true });
  image.addEventListener('error', () => media.classList.add('is-loaded', 'is-error'), { once: true });
  image.src = cached;
  media.append(image);
  return media;
}

// 标题即按钮：.rank-link 的 ::after 铺满整行，整行点开详情抽屉，只有一个可聚焦元素。
function createTitle(text, type, id) {
  const title = document.createElement(id ? 'button' : 'span');
  title.className = 'rank-title';
  title.textContent = text || '未命名';
  if (id) {
    title.classList.add('rank-link');
    title.type = 'button';
    title.dataset.entity = type;
    title.dataset.entityId = String(id);
  }
  return title;
}

function getInsufficientText(payload, haveDays) {
  if (payload?.error) return `读取失败：${payload.error}`;
  const have = payload?.haveDays ?? haveDays ?? 0;
  const need = payload?.needDays ?? 1;
  return `目前只有 ${formatNumber(have)} 天有效记录，至少需要 ${formatNumber(need)} 天。`;
}

function missingDailyTopText(reason) {
  if (reason === 'gap') return '这天采集中断，记录可能不完整。';
  if (reason === 'insufficient') return '记录还不够，暂时无法生成这一天的统计。';
  return '这一天没有听歌记录。';
}

function groupMosaicDays(items) {
  const groups = [];
  for (const item of items) {
    const previous = groups.at(-1);
    const previousDay = previous?.days.at(-1);
    const consecutive = previousDay && Date.parse(previousDay.date) - Date.parse(item.date) === 86400000;
    if (!item.songs?.length && previous && !previous.songs?.length
        && previous.reason === item.reason && consecutive) {
      previous.days.push(item);
    } else {
      groups.push({ ...item, days: [item] });
    }
  }
  return groups;
}

function renderMosaic(payload = null) {
  const source = payload?.items || [];
  const today = new Date();
  const items = Array.from({ length: MOSAIC_DAYS }, (_, index) => {
    if (source[index]) return source[index];
    const date = new Date(today);
    date.setDate(today.getDate() - index);
    return {
      date: date.toLocaleDateString('en-CA'),
      missing: true,
      reason: 'insufficient',
      plays: 0,
      distinct_songs: 0,
      songs: [],
    };
  });

  // 同一首歌这周出现在几天：悬停时联动高亮，标签里也说出来。
  const daysBySong = new Map();
  for (const item of items) {
    for (const id of new Set((item.songs || []).map((entry) => entry.song?.id).filter(Boolean))) {
      daysBySong.set(id, (daysBySong.get(id) || 0) + 1);
    }
  }

  const rows = groupMosaicDays(items).map((item) => {
    const row = document.createElement('li');
    row.className = 'mosaic-row';

    if (!item.songs?.length) {
      row.classList.add('is-summary');
      const first = item.days.at(-1).date.slice(5).replace('-', '.');
      const last = item.date.slice(5).replace('-', '.');
      const range = item.days.length > 1 ? `${first}–${last}` : formatDayLabel(item.date);
      const summary = document.createElement('span');
      summary.className = 'mosaic-summary-text';
      summary.textContent = `${range} · ${missingDailyTopText(item.reason)}`;
      row.append(summary);
      return row;
    }

    const meta = document.createElement('span');
    meta.className = 'mosaic-row__meta';
    const date = document.createElement('strong');
    date.textContent = formatDayLabel(item.date);
    const count = document.createElement('span');
    count.textContent = `${item.lower_bound ? '≥' : ''}${formatNumber(item.plays)} 次 · ${formatNumber(item.distinct_songs)} 首`;
    meta.append(date, count);

    const covers = document.createElement('span');
    covers.className = 'mosaic-covers';
    covers.append(...Array.from({ length: MOSAIC_COLUMNS }, (_, coverIndex) => {
      const entry = item.songs[coverIndex];
      if (!entry) {
        const slot = document.createElement('span');
        slot.className = 'mosaic-slot';
        slot.setAttribute('aria-hidden', 'true');
        return slot;
      }
      const button = document.createElement('button');
      button.className = 'mosaic-cover';
      button.type = 'button';
      const songDays = daysBySong.get(entry.song?.id) || 0;
      const label = `${item.date}，${entry.song?.name || '未命名歌曲'}，${songSubtitle(entry.song)}，${formatNumber(entry.plays)} 次播放${songDays > 1 ? `，这周有 ${songDays} 天都听了` : ''}`;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.dataset.detail = label;
      button.dataset.detailTarget = 'mosaicDetail';
      if (entry.song?.id) {
        button.dataset.entity = 'song';
        button.dataset.entityId = String(entry.song.id);
        button.dataset.songId = String(entry.song.id);
      }
      button.append(createCoverMedia(entry.song?.album?.picUrl || entry.song?.picUrl, ''));
      return button;
    }));
    row.append(meta, covers);
    return row;
  });
  nodes.mosaic.replaceChildren(...rows);
  linkMosaicSong(null);
  setDetail('mosaicDetail', '');

  if (payload?.error) {
    nodes.mosaicSummary.textContent = `封面读取失败：${payload.error}`;
  } else if (payload?.meta?.data_quality?.lower_bound) {
    nodes.mosaicSummary.textContent = '部分日期记录不完整，≥ 表示已记录的最低次数。';
  } else {
    nodes.mosaicSummary.textContent = '';
  }
  nodes.mosaicSummary.hidden = !nodes.mosaicSummary.textContent;
}

// 封面墙同曲联动：指到（或键盘聚焦）一格时，这周其他天的同一首歌一起亮起，其余格子变淡。
function linkMosaicSong(songId) {
  const linked = songId || '';
  if ((nodes.mosaic.dataset.linkedSong || '') === linked) return;
  if (linked) nodes.mosaic.dataset.linkedSong = linked;
  else delete nodes.mosaic.dataset.linkedSong;
  nodes.mosaic.querySelectorAll('.mosaic-cover').forEach((cover) => {
    cover.classList.toggle('is-linked', Boolean(linked) && cover.dataset.songId === linked);
  });
}

function renderHealth(health) {
  const hasService = Boolean(health?.last_recent_poll_at || health?.last_snapshot);
  const warning = health?.counter_stale || health?.last_fetch_status === 'fail';
  const stateName = !hasService ? 'loading' : warning ? 'warning' : 'healthy';
  nodes.serviceStatus.dataset.state = stateName;
  nodes.serviceStatusText.textContent = !hasService ? '暂无数据' : warning ? '数据更新异常' : '数据正常';
  nodes.heroSubtitle.textContent = health?.last_recent_poll_at
    ? `更新于 ${formatPlayTime(Date.parse(health.last_recent_poll_at))}`
    : health?.last_snapshot ? `更新于 ${health.last_snapshot}` : '';
}

function renderOverview(overview, health) {
  if (!overview || overview.error || overview.insufficientData) {
    setMetricValue(nodes.metricPlays, '--');
    setMetricValue(nodes.metricHours, '--');
    setMetricValue(nodes.metricSongs, '--');
    setMetricValue(nodes.metricDays, formatNumber(health.have_days));
    nodes.metricRange.textContent = overview?.error ? '读取失败' : '天';
    nodes.metricPlaysHint.textContent = '次';
    nodes.metricPlays.title = overview?.error ? `读取失败：${overview.error}` : getInsufficientText(overview, health.have_days);
    return;
  }

  const lowerBound = Boolean(overview.meta?.data_quality?.lower_bound);
  const prefix = lowerBound ? '≥' : '';
  const { plays, est_hours: hours, distinct_songs: songs, days_tracked: days } = overview.totals;
  setMetricValue(nodes.metricPlays, `${prefix}${formatNumber(plays)}`);
  setMetricValue(nodes.metricHours, `${prefix}${formatNumber(hours)}`);
  setMetricValue(nodes.metricSongs, `${prefix}${formatNumber(songs)}`);
  setMetricValue(nodes.metricDays, `${prefix}${formatNumber(days)}`);
  nodes.metricRange.textContent = formatRange(overview.range);
  nodes.metricPlaysHint.textContent = lowerBound ? '次，记录不完整' : '次';
  nodes.metricPlays.title = lowerBound ? '≥ 表示已记录的最低次数' : '';
}

function rankingPic(item) {
  if (state.dimension === 'song') return item.album?.picUrl || item.picUrl;
  if (state.dimension === 'album') return item.picUrl;
  return '';
}

function renderRanking(payload, health) {
  nodes.rankingList.replaceChildren();
  if (!payload || payload.error) {
    nodes.rankingList.append(emptyState('排行读取失败', payload?.error || '请稍后重试', { kind: 'error', tag: 'li' }));
    return;
  }
  if (payload.insufficientData) {
    nodes.rankingList.append(emptyState('数据不足', getInsufficientText(payload, health.have_days), { kind: 'insufficient', tag: 'li' }));
    return;
  }
  nodes.rankingRange.textContent = formatRange(payload.meta?.period_resolved);
  const items = payload.items || [];
  if (!items.length) {
    nodes.rankingList.append(emptyState('暂无播放记录', '', { tag: 'li' }));
    return;
  }

  const lowerBound = Boolean(payload.meta?.data_quality?.lower_bound);
  const rows = items.map((item) => {
    const row = document.createElement('li');
    row.className = 'rank-row';
    // 同一首歌/歌手/专辑在切换窗口前后同名，View Transition 才能让它滑到新名次。
    row.style.viewTransitionName = `rank-${state.dimension}-${item.id}`;

    const index = document.createElement('span');
    index.className = 'rank-index';
    index.textContent = String(item.rank).padStart(2, '0');

    const cover = document.createElement('span');
    cover.className = 'rank-cover';
    const pic = rankingPic(item);
    if (pic) cover.append(createCoverMedia(pic, ''));
    else cover.append(icon(state.dimension === 'artist' ? 'mic2' : 'music'));

    const main = document.createElement('span');
    main.className = 'rank-main';
    const title = createTitle(item.name, state.dimension, item.id);
    const subtitle = document.createElement('span');
    subtitle.className = 'rank-subtitle';
    subtitle.textContent = subtitleFor(item);
    main.append(title, subtitle);

    const value = document.createElement('span');
    value.className = 'rank-value';
    value.textContent = `${lowerBound ? '≥' : ''}${formatNumber(item.plays)} 次`;
    row.append(index, cover, main, value);
    return row;
  });
  nodes.rankingList.replaceChildren(...rows);
}

function subtitleFor(item) {
  if (state.dimension === 'song') {
    const artists = (item.artists || []).map((artist) => artist.name).join(' / ');
    return artists || item.album?.name || '歌曲';
  }
  return `${formatNumber(item.est_minutes)} 分钟`;
}

function songSubtitle(song) {
  const artists = (song?.artists || []).map((artist) => artist.name).filter(Boolean).join(' / ');
  return artists || song?.album?.name || '歌曲';
}

function songTitleBlock(song) {
  const main = document.createElement('span');
  main.className = 'song-row__main';
  const title = createTitle(song?.name, 'song', song?.id);
  const subtitle = document.createElement('span');
  subtitle.className = 'rank-subtitle';
  subtitle.textContent = songSubtitle(song);
  main.append(title, subtitle);
  return main;
}

function makeSongRow(song, valueText) {
  const row = document.createElement('li');
  row.className = 'song-row';
  const art = document.createElement('span');
  art.className = 'song-row__art';
  art.append(createCoverMedia(song?.album?.picUrl || song?.picUrl, ''));
  const value = document.createElement('span');
  value.className = 'song-row__value';
  value.textContent = valueText;
  row.append(art, songTitleBlock(song), value);
  return row;
}

function makeTimedRow(item) {
  const row = document.createElement('li');
  row.className = 'song-row song-row--timed';
  const time = document.createElement('time');
  time.className = 'song-row__time';
  time.textContent = formatRecentTime(item.playTime);
  const art = document.createElement('span');
  art.className = 'song-row__art';
  art.append(createCoverMedia(item.song?.album?.picUrl || item.song?.picUrl, ''));
  row.append(time, art, songTitleBlock(item.song));
  return row;
}

function renderRecent(payload) {
  if (!payload || payload.error) {
    nodes.recentList.replaceChildren(emptyState('读取失败', payload?.error || '请稍后重试', { kind: 'error', tag: 'li' }));
    return;
  }
  const items = payload.items || [];
  if (!items.length) {
    nodes.recentList.replaceChildren(emptyState('暂无最近播放', '', { tag: 'li' }));
    return;
  }
  nodes.recentList.replaceChildren(...items.slice(0, 10).map(makeTimedRow));
}

function makeSvgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function shortBucket(bucket) {
  if (!bucket) return '';
  if (bucket.includes('-W')) return bucket.split('-').at(-1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) return bucket.slice(5);
  if (/^\d{4}-\d{2}$/.test(bucket)) return bucket.slice(2);
  return bucket;
}

function splitTrendSegments(points) {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (point.missing) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

// animate：折线从左往右描出、面积随后淡入（区块还没滚进视口时等到进场再画）；宽度变化重画时不描。
function renderTrend(payload, health, { animate = false } = {}) {
  lastTrend = { payload, health };
  nodes.trendChart.replaceChildren();
  setDetail('trendDetail', '');
  if (!payload || payload.error) {
    nodes.trendChart.append(emptyState('趋势读取失败', payload?.error || '请稍后重试', { kind: 'error' }));
    return;
  }
  if (payload.insufficientData) {
    nodes.trendChart.append(emptyState('数据不足', getInsufficientText(payload, health.have_days), { kind: 'insufficient' }));
    return;
  }
  const series = payload.series || [];
  if (!series.length) {
    nodes.trendChart.append(emptyState('暂无数据', '', { kind: 'insufficient' }));
    return;
  }
  if (series.every((point) => !point.plays) && !series.some((point) => point.missing)) {
    nodes.trendChart.append(emptyState('暂无播放记录', ''));
    return;
  }

  // 手机上换一块接近实际像素的画布，坐标文字才不会被等比缩小到看不清。
  const compact = compactChart.matches;
  const width = compact ? 360 : 900;
  const height = compact ? 200 : 250;
  const left = compact ? 32 : 40;
  const right = compact ? 8 : 12;
  const top = 10;
  const baseline = height - 38;
  const plotWidth = width - left - right;
  const max = Math.max(...series.map((point) => point.plays || 0), 1);
  const step = series.length > 1 ? plotWidth / (series.length - 1) : plotWidth;
  const points = series.map((point, index) => ({
    ...point,
    x: series.length > 1 ? left + index * step : left + plotWidth / 2,
    y: baseline - ((point.plays || 0) / max) * (baseline - top),
  }));

  const figure = document.createElement('figure');
  figure.className = 'trend-figure';
  const svg = makeSvgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-labelledby': 'trendSvgTitle trendSvgDesc' });
  const title = makeSvgElement('title', { id: 'trendSvgTitle' });
  title.textContent = '播放趋势直线分段面积图';
  const desc = makeSvgElement('desc', { id: 'trendSvgDesc' });
  desc.textContent = '每个点为已记录播放量；虚线仅表示进行中的周期，下界在数值中以 ≥ 标注。未知数据断线，并以浅色竖带标出空缺，不按零次绘制。';
  svg.append(title, desc);

  for (let gridIndex = 0; gridIndex <= 2; gridIndex += 1) {
    const y = top + ((baseline - top) / 2) * gridIndex;
    svg.append(makeSvgElement('line', { x1: left, y1: y, x2: width - right, y2: y, class: 'trend-grid-line' }));
    const label = makeSvgElement('text', { x: left - 10, y, 'text-anchor': 'end', 'dominant-baseline': 'middle', class: 'trend-axis-label' });
    label.textContent = formatNumber(Math.round(max * (1 - gridIndex / 2)));
    svg.append(label);
  }

  for (const point of points.filter((entry) => entry.missing)) {
    // 空缺带裁剪在绘图区内，避免盖住纵轴刻度。
    const gapStart = Math.max(left, point.x - Math.max(6, step) / 2);
    const gapEnd = Math.min(width - right, point.x + Math.max(6, step) / 2);
    svg.append(makeSvgElement('rect', { x: gapStart, y: top, width: gapEnd - gapStart, height: baseline - top, class: 'trend-gap' }));
  }

  // 面积与折线分组：描线时折线、圆点一起从左往右擦出，面积整组淡入；网格、空缺带和坐标不动。
  const areas = makeSvgElement('g', { class: 'trend-areas' });
  const plot = makeSvgElement('g', { class: 'trend-plot' });
  svg.append(areas, plot);

  for (const segment of splitTrendSegments(points)) {
    // 每段只画一块面积，进行中的桶不填充。
    const settled = segment.filter((point) => !point.is_current);
    if (settled.length > 1) {
      const outline = settled.map((point) => `L ${point.x} ${point.y}`).join(' ');
      const area = `M ${settled[0].x} ${baseline} ${outline} L ${settled.at(-1).x} ${baseline} Z`;
      areas.append(makeSvgElement('path', { d: area, class: 'trend-area' }));
    }
    for (let index = 1; index < segment.length; index += 1) {
      const previous = segment[index - 1];
      const point = segment[index];
      const inProgress = previous.is_current || point.is_current;
      const line = `M ${previous.x} ${previous.y} L ${point.x} ${point.y}`;
      plot.append(makeSvgElement('path', { d: line, class: `trend-line${inProgress ? ' is-current' : ''}` }));
    }
  }

  const labelStride = Math.max(1, Math.ceil(series.length / (compact ? 4 : 7)));
  points.forEach((point, index) => {
    if (point.is_current) {
      plot.append(makeSvgElement('line', { x1: point.x, y1: top, x2: point.x, y2: baseline, class: 'trend-current-line' }));
    }
    if (!point.missing) {
      const circle = makeSvgElement('circle', {
        cx: point.x,
        cy: point.y,
        r: point.is_current ? 4 : compact ? 3.5 : 2.5,
        class: `trend-point${point.is_current ? ' is-current' : ''}`,
        tabindex: 0,
        role: 'img',
        'data-detail-target': 'trendDetail',
        'aria-label': `${point.bucket}：${point.lower_bound ? '至少 ' : ''}${formatNumber(point.plays)} 次${point.has_gap ? '，记录不完整' : ''}${point.estimated ? '，日级归属不确定' : ''}${point.is_current ? '，进行中' : ''}`,
      });
      circle.dataset.detail = circle.getAttribute('aria-label');
      const tooltip = makeSvgElement('title');
      tooltip.textContent = circle.dataset.detail;
      circle.append(tooltip);
      plot.append(circle);
    }
    if (index % labelStride === 0 || index === points.length - 1) {
      const label = makeSvgElement('text', { x: point.x, y: baseline + 26, 'text-anchor': 'middle', class: 'trend-axis-label' });
      label.textContent = shortBucket(point.bucket);
      svg.append(label);
    }
  });
  figure.classList.toggle('is-drawing', animate);
  figure.append(svg);

  const caption = document.createElement('figcaption');
  caption.className = 'trend-caption';
  for (const [className, label] of [['legend-line', '已记录'], ['legend-current', '进行中'], ['legend-gap', '采集中断，数据未知']]) {
    const item = document.createElement('span');
    const marker = document.createElement('i');
    marker.className = className;
    item.append(marker, document.createTextNode(label));
    caption.append(item);
  }
  figure.append(caption);

  const textData = document.createElement('ul');
  textData.className = 'trend-text-data';
  textData.setAttribute('aria-label', '趋势文本数据');
  for (const point of series) {
    const item = document.createElement('li');
    item.classList.toggle('is-gap', Boolean(point.has_gap || point.missing));
    item.textContent = `${point.bucket} · ${point.missing ? '数据未知' : `${point.lower_bound ? '≥' : ''}${formatNumber(point.plays)}`}${point.has_gap ? ' · 记录不完整' : ''}${point.estimated ? ' · 日级归属不确定' : ''}${point.is_current ? ' · 进行中' : ''}`;
    textData.append(item);
  }
  const details = document.createElement('details');
  details.className = 'trend-details';
  const summary = document.createElement('summary');
  summary.textContent = '查看数据';
  details.append(summary, textData);
  nodes.trendChart.append(figure, details);
}

function renderHourlyActivity(payload) {
  nodes.hourlyHeatmap.replaceChildren();
  if (!payload || payload.error) {
    nodes.hourlyHeatmap.append(emptyState('小时分布读取失败', payload?.error || '请稍后重试', { kind: 'error' }));
    nodes.hourlyMeta.textContent = '读取失败';
    return;
  }
  const buckets = payload.buckets || [];
  if (buckets.length !== 24) {
    nodes.hourlyHeatmap.append(emptyState('数据不足', '', { kind: 'insufficient' }));
    return;
  }
  const max = Math.max(...buckets.map((bucket) => bucket.plays || 0), 1);
  const lowerBound = Boolean(payload.meta?.lower_bound);
  const peaks = [];
  const cells = buckets.map((bucket) => {
    const cell = document.createElement('button');
    cell.className = 'hour-cell';
    cell.type = 'button';
    const intensity = (bucket.plays || 0) / max;
    cell.style.setProperty('--intensity', intensity.toFixed(3));
    // 柱子按小时依次长出来。
    cell.style.setProperty('--i', String(bucket.hour));
    cell.dataset.level = String(bucket.plays ? Math.max(1, Math.ceil(intensity * 5)) : 0);
    // 接近峰值的时段用强调色，其余保持中性。
    if (bucket.plays && intensity >= 0.8) {
      cell.classList.add('is-peak');
      peaks.push(bucket.hour);
    }
    const label = `${String(bucket.hour).padStart(2, '0')} 时：${lowerBound ? '至少 ' : ''}${formatNumber(bucket.plays)} 次，${formatNumber(bucket.distinct_songs)} 首不同歌曲，占可按小时统计的播放 ${percentFormat.format(bucket.share || 0)}`;
    cell.setAttribute('aria-label', label);
    cell.title = label;
    cell.dataset.detail = label;
    cell.dataset.detailTarget = 'hourlyDetail';
    const track = document.createElement('span');
    track.className = 'hour-cell__track';
    track.setAttribute('aria-hidden', 'true');
    const bar = document.createElement('i');
    bar.className = 'hour-cell__bar';
    track.append(bar);
    const hour = document.createElement('strong');
    hour.textContent = String(bucket.hour).padStart(2, '0');
    cell.append(track, hour);
    return cell;
  });
  nodes.hourlyHeatmap.replaceChildren(...cells);
  setDetail('hourlyDetail', '');
  const meta = payload.meta || {};
  const qualityLabel = meta.data_quality?.historical && !meta.located_plays ? '数据不足 · ' : lowerBound ? '最低估计 · ' : '';
  const unlocated = meta.unlocated_plays
    ? `；另有 ${formatNumber(meta.unlocated_plays)} 次播放只能统计到天，无法细分到小时`
    : '';
  const gap = meta.collection_gaps?.length ? `；存在 ${formatNumber(meta.collection_gaps.length)} 段记录不完整` : '';
  const peakText = peaks.length ? ` · 高峰 ${peaks.map((hourValue) => String(hourValue).padStart(2, '0')).join('、')} 时` : '';
  nodes.hourlyMeta.textContent = `${formatRange(meta.range)} · 不含今天${peakText}`;
  nodes.hourlyMeta.title = `${qualityLabel}${formatNumber(meta.located_plays)} 次已定位播放${unlocated}${gap}`;
  nodes.footerTimezone.textContent = meta.timezone || '本地时间';
}

function renderPlaylists(payload) {
  if (!payload || payload.error) {
    nodes.playlistList.replaceChildren(emptyState('歌单读取失败', payload?.error || '请稍后重试', { kind: 'error' }));
    nodes.playlistTracks.replaceChildren(emptyState('未选择歌单', '', { kind: 'insufficient', tag: 'li' }));
    nodes.playlistCount.textContent = '--';
    return;
  }
  const items = payload.items || [];
  nodes.playlistCount.textContent = `${formatNumber(payload.total || items.length)} 份`;
  if (!items.length) {
    nodes.playlistList.replaceChildren(emptyState('暂无歌单', ''));
    nodes.playlistTracks.replaceChildren(emptyState('暂无曲目', '', { kind: 'insufficient', tag: 'li' }));
    return;
  }
  if (!state.playlistId) state.playlistId = items[0].id;
  const rows = items.map((item) => {
    const row = document.createElement('button');
    row.className = 'playlist-row';
    row.type = 'button';
    row.dataset.playlistId = item.id;
    row.classList.toggle('is-active', String(item.id) === String(state.playlistId));
    row.setAttribute('aria-pressed', String(String(item.id) === String(state.playlistId)));
    const name = document.createElement('span');
    name.className = 'playlist-row__name';
    name.textContent = item.name || '未命名歌单';
    const count = document.createElement('span');
    count.className = 'playlist-row__count';
    count.textContent = `${formatNumber(item.trackCount)} 首`;
    row.append(name, count);
    return row;
  });
  nodes.playlistList.replaceChildren(...rows);
}

function renderPlaylistTracks(payload) {
  if (!payload || payload.error) {
    nodes.playlistTrackTitle.textContent = '曲目';
    nodes.trackCount.textContent = '--';
    nodes.playlistTracks.replaceChildren(emptyState('曲目读取失败', payload?.error || '请稍后重试', { kind: 'error', tag: 'li' }));
    return;
  }
  nodes.playlistTrackTitle.textContent = payload.playlist?.name || '曲目';
  nodes.trackCount.textContent = `${formatNumber(payload.total || 0)} 首`;
  const rows = (payload.items || []).map((song, index) => makeSongRow(song, String(state.trackOffset + index + 1).padStart(2, '0')));
  nodes.playlistTracks.replaceChildren(...(rows.length ? rows : [emptyState('暂无曲目', '', { tag: 'li' })]));
}

function renderPager(container, { offset = 0, pageSize = 0, total = 0, kind = '' } = {}) {
  if (!container) return;
  if (!total || total <= pageSize) {
    container.replaceChildren();
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const pageCount = Math.ceil(total / pageSize);
  const current = Math.floor(offset / pageSize) + 1;
  const prev = document.createElement('button');
  prev.className = 'pager-btn';
  prev.type = 'button';
  prev.dataset.pager = kind;
  prev.dataset.dir = 'prev';
  prev.append(icon('chevron-left'), document.createTextNode('上一页'));
  prev.disabled = offset <= 0;
  const info = document.createElement('span');
  info.className = 'pager-info';
  info.textContent = `${current} / ${pageCount} · 共 ${formatNumber(total)}`;
  const next = document.createElement('button');
  next.className = 'pager-btn';
  next.type = 'button';
  next.dataset.pager = kind;
  next.dataset.dir = 'next';
  next.append(document.createTextNode('下一页'), icon('chevron-right'));
  next.disabled = offset + pageSize >= total;
  container.replaceChildren(prev, info, next);
}

async function loadPlaylists() {
  const payload = await getJson('/api/playlists', { limit: PLAYLIST_PAGE_SIZE, offset: state.playlistOffset })
    .catch((error) => ({ error: error.message }));
  renderPlaylists(payload);
  renderPager(nodes.playlistPager, {
    offset: state.playlistOffset,
    pageSize: PLAYLIST_PAGE_SIZE,
    total: payload && !payload.error ? payload.total : 0,
    kind: 'playlist',
  });
}

async function loadPlaylistTracks() {
  if (!state.playlistId) {
    nodes.playlistTracks.replaceChildren(emptyState('请选择歌单', '', { kind: 'insufficient', tag: 'li' }));
    renderPager(nodes.playlistTracksPager, { total: 0 });
    return;
  }
  nodes.playlistTracks.setAttribute('aria-busy', 'true');
  const tracks = await getJson(`/api/playlists/${encodeURIComponent(state.playlistId)}/tracks`, {
    limit: TRACK_PAGE_SIZE,
    offset: state.trackOffset,
  }).catch((error) => ({ error: error.message }));
  renderPlaylistTracks(tracks);
  renderPager(nodes.playlistTracksPager, {
    offset: state.trackOffset,
    pageSize: TRACK_PAGE_SIZE,
    total: tracks && !tracks.error ? tracks.total : 0,
    kind: 'track',
  });
  nodes.playlistTracks.removeAttribute('aria-busy');
}

// ---- 日期小工具（日历与抽屉共用；'YYYY-MM-DD' 按 UTC 计算，避开夏令时） ----

function isoAddDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isoDayDiff(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

function monthDayLabel(isoDate) {
  const label = `${Number(isoDate.slice(5, 7))}月${Number(isoDate.slice(8, 10))}日`;
  return isoDate.slice(0, 4) === String(new Date().getFullYear()) ? label : `${isoDate.slice(0, 4)}年${label}`;
}

function dayTitle(isoDate) {
  return `${monthDayLabel(isoDate)} ${WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()]}`;
}

function hoursLabel(minutes) {
  return (Math.round((minutes || 0) / 6) / 10).toFixed(1);
}

// 连续日期合并成「9月20–21日」。
function dateRanges(dates) {
  const groups = [];
  for (const date of dates) {
    const last = groups.at(-1);
    if (last && isoDayDiff(date, last.at(-1)) === 1) last.push(date);
    else groups.push([date]);
  }
  return groups.map((group) => {
    const [first, last] = [group[0], group.at(-1)];
    if (first === last) return monthDayLabel(first);
    return first.slice(0, 7) === last.slice(0, 7)
      ? `${monthDayLabel(first).replace(/日$/, '')}–${Number(last.slice(8))}日`
      : `${monthDayLabel(first)}–${monthDayLabel(last)}`;
  });
}

// ---- 听歌日历：直接用趋势接口的逐日序列，「数据未知 / 下界 / 日期不确定」口径与趋势图一致 ----

// 第一个有记录的日子之前算「还没开始记录」，之后的 missing 才是数据未知。
function calendarDays(series) {
  const startIndex = series.findIndex((point) => !point.missing);
  return series.map((point, index) => ({
    ...point,
    date: point.start,
    state: startIndex < 0 || index < startIndex ? 'blank'
      : point.missing ? 'gap'
        : point.estimated ? 'estimated'
          : point.plays > 0 ? 'played' : 'zero',
  }));
}

function calendarValue(day) {
  return state.calendarMetric === 'minutes' ? day.est_minutes || 0 : day.plays || 0;
}

function calendarStats(days) {
  const recorded = days.filter((day) => day.state !== 'blank');
  const played = recorded.filter((day) => day.state === 'played');
  const ranked = played
    .filter((day) => !day.is_current && calendarValue(day) > 0)
    .sort((a, b) => calendarValue(b) - calendarValue(a));
  // 数据未知或日期不确定的日子都会打断连续记录：那几天是否在听无法确认。
  let streak = null;
  let run = null;
  for (const day of recorded) {
    if (day.state === 'played') {
      run = run ? { ...run, end: day.date, length: run.length + 1 } : { start: day.date, end: day.date, length: 1 };
      if (!streak || run.length > streak.length) streak = run;
    } else {
      run = null;
    }
  }
  // 与 GitHub 贡献图一样按四分位分档：少数特别多的日子不会把其余格子都压成最浅。
  const values = recorded
    .filter((day) => (day.state === 'played' || day.state === 'estimated') && calendarValue(day) > 0)
    .map(calendarValue)
    .sort((a, b) => a - b);
  const quantile = (share) => values[Math.min(values.length - 1, Math.floor(share * values.length))] || 0;
  return {
    firstRecorded: recorded[0]?.date || null,
    listened: played.length,
    streak,
    peak: ranked[0] || null,
    thresholds: [quantile(0.25), quantile(0.5), quantile(0.75)],
    gaps: recorded.filter((day) => day.state === 'gap').map((day) => day.date),
  };
}

function calendarLevel(value, thresholds) {
  if (value <= 0) return 0;
  const index = thresholds.findIndex((limit) => value <= limit);
  return index < 0 ? 4 : index + 1;
}

function calendarDayText(day) {
  const count = `${day.lower_bound ? '至少 ' : ''}${formatNumber(day.plays)} 次`;
  if (day.state === 'blank') return '还没开始记录';
  if (day.state === 'gap') return '数据未知';
  if (day.state === 'zero') return '没有播放';
  if (day.state === 'estimated') return `${count}，具体日期不确定`;
  if (day.is_current) return `今天，已记下 ${count}`;
  return `${count}，约 ${hoursLabel(day.est_minutes)} 小时`;
}

function renderCalendarSummary(days, stats) {
  const thisYear = state.calendarYear === new Date().getFullYear();
  const clauses = [`${thisYear ? '今年' : `${state.calendarYear} 年`}有 ${formatNumber(stats.listened)} 天在听`];
  if (stats.streak?.length > 1) {
    clauses.push(`最长连着听了 ${formatNumber(stats.streak.length)} 天（${monthDayLabel(stats.streak.start)}–${monthDayLabel(stats.streak.end)}）`);
  }
  let summary = `${clauses.join('，')}。`;
  if (stats.peak) {
    const peak = stats.peak;
    summary += state.calendarMetric === 'minutes'
      ? `听得最久的是 ${monthDayLabel(peak.date)}，约 ${hoursLabel(peak.est_minutes)} 小时。`
      : `听得最多的是 ${monthDayLabel(peak.date)}，${peak.lower_bound ? '至少 ' : ''}${formatNumber(peak.plays)} 次。`;
  }
  nodes.calSummary.textContent = summary;

  const notes = [];
  if (stats.firstRecorded > `${state.calendarYear}-01-01`) notes.push(`从 ${monthDayLabel(stats.firstRecorded)}开始记录。`);
  if (stats.gaps.length) {
    const ranges = dateRanges(stats.gaps);
    notes.push(ranges.length <= 3
      ? `${ranges.join('、')}数据未知，画成斜纹格。`
      : `有 ${formatNumber(stats.gaps.length)} 天数据未知，画成斜纹格。`);
  }
  if (days.some((day) => day.state === 'estimated')) notes.push('补记的次数无法确定具体日期，画成空心格。');
  if (days.some((day) => day.lower_bound && day.state === 'played')) notes.push('≥ 表示已记录到的最低次数。');
  nodes.calNote.textContent = notes.join('');
}

// GitHub 式年历：一列一周、一行一天（周一在上），整年 53 列左右；今年只画到今天。
function renderCalendarGrid(days, stats) {
  const year = state.calendarYear;
  const jan1 = `${year}-01-01`;
  const gridStart = isoAddDays(jan1, -((new Date(`${jan1}T00:00:00Z`).getUTCDay() + 6) % 7));
  const weeks = Math.floor(isoDayDiff(`${year}-12-31`, gridStart) / 7) + 1;
  const grid = document.createElement('div');
  grid.className = 'cal-grid';
  grid.style.setProperty('--weeks', String(weeks));

  for (let month = 1; month <= 12; month += 1) {
    const label = document.createElement('span');
    label.className = 'cal-grid__month';
    label.setAttribute('aria-hidden', 'true');
    label.textContent = `${month}月`;
    const column = Math.floor(isoDayDiff(`${year}-${String(month).padStart(2, '0')}-01`, gridStart) / 7);
    label.style.gridColumn = `${column + 2} / span 4`;
    grid.append(label);
  }
  for (const [row, text] of [[1, '一'], [3, '三'], [5, '五']]) {
    const label = document.createElement('span');
    label.className = 'cal-grid__weekday';
    label.setAttribute('aria-hidden', 'true');
    label.textContent = text;
    label.style.gridRow = String(row + 1);
    grid.append(label);
  }

  for (const day of days) {
    const index = isoDayDiff(day.date, gridStart);
    const blank = day.state === 'blank';
    const cell = document.createElement(blank ? 'span' : 'button');
    cell.className = 'cal-cell';
    cell.dataset.state = day.state;
    cell.style.gridColumn = String(Math.floor(index / 7) + 2);
    cell.style.gridRow = String((index % 7) + 2);
    if (!blank) {
      cell.type = 'button';
      cell.tabIndex = -1;
      cell.dataset.date = day.date;
      if (day.state !== 'gap') cell.dataset.level = String(calendarLevel(calendarValue(day), stats.thresholds));
      cell.classList.toggle('is-today', Boolean(day.is_current));
      cell.setAttribute('aria-label', `${dayTitle(day.date)}：${calendarDayText(day)}`);
      cell.title = cell.getAttribute('aria-label');
    }
    grid.append(cell);
  }
  nodes.calHeatmap.replaceChildren(grid);
  // 手机上一屏放不下整年：让最近有记录的那一列贴着右边，而不是滚到年底的空白。
  const latest = [...grid.querySelectorAll('button.cal-cell')].at(-1);
  if (latest && nodes.calHeatmap.scrollWidth > nodes.calHeatmap.clientWidth) {
    const overflow = latest.getBoundingClientRect().right - nodes.calHeatmap.getBoundingClientRect().right;
    nodes.calHeatmap.scrollLeft = Math.max(0, nodes.calHeatmap.scrollLeft + overflow + 8);
  }
}

function legendSwatch(stateName, level = null, extraClass = '') {
  const swatch = document.createElement('i');
  swatch.className = `cal-cell ${extraClass}`.trim();
  swatch.dataset.state = stateName;
  if (level !== null) swatch.dataset.level = String(level);
  return swatch;
}

function renderCalendarLegend(days, stats) {
  const keys = document.createElement('span');
  keys.className = 'cal-legend__keys';
  for (const [show, swatch, label] of [
    [stats.gaps.length > 0, legendSwatch('gap'), '数据未知'],
    [days.some((day) => day.state === 'estimated'), legendSwatch('estimated', 2), '日期不确定'],
    [days.some((day) => day.state === 'blank'), legendSwatch('blank'), '还没开始记录'],
    [days.some((day) => day.is_current), legendSwatch('zero', 0, 'is-today'), '今天'],
  ]) {
    if (!show) continue;
    const item = document.createElement('span');
    item.append(swatch, document.createTextNode(label));
    keys.append(item);
  }
  const scale = document.createElement('span');
  scale.className = 'cal-legend__scale';
  scale.append(document.createTextNode('少'));
  for (let level = 0; level <= 4; level += 1) scale.append(legendSwatch(level ? 'played' : 'zero', level));
  scale.append(document.createTextNode(state.calendarMetric === 'minutes' ? '久' : '多'));
  nodes.calLegend.replaceChildren(keys, scale);
}

function syncCalendarControls() {
  const thisYear = new Date().getFullYear();
  const firstYear = Number((latestHealth.first_date || '').slice(0, 4)) || thisYear;
  nodes.calYear.textContent = String(state.calendarYear);
  document.querySelector('[data-cal-year="-1"]').disabled = state.calendarYear <= firstYear;
  document.querySelector('[data-cal-year="1"]').disabled = state.calendarYear >= thisYear;
  document.querySelectorAll('[data-cal-metric]').forEach((tab) => {
    const active = tab.dataset.calMetric === state.calendarMetric;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-pressed', String(active));
  });
  syncSwitchIndicators();
}

// 日历只占一个 Tab 位：选中的那天（没有就第一天）可聚焦，其余用方向键到达。
function syncCalendarSelection() {
  const cells = [...nodes.calHeatmap.querySelectorAll('button.cal-cell')];
  const focusable = cells.find((cell) => cell.dataset.date === state.calendarDay) || cells[0];
  for (const cell of cells) {
    const selected = cell.dataset.date === state.calendarDay;
    cell.classList.toggle('is-selected', selected);
    cell.setAttribute('aria-pressed', String(selected));
    cell.tabIndex = cell === focusable ? 0 : -1;
  }
}

function renderCalendar(payload) {
  lastCalendar = payload;
  syncCalendarControls();
  const clear = () => {
    nodes.calSummary.textContent = '';
    nodes.calNote.textContent = '';
    nodes.calLegend.replaceChildren();
    nodes.calDetail.hidden = true;
  };
  if (!payload || payload.error) {
    clear();
    nodes.calHeatmap.replaceChildren(emptyState('日历读取失败', payload?.error || '请稍后重试', { kind: 'error' }));
    return;
  }
  if (payload.insufficientData) {
    clear();
    nodes.calHeatmap.replaceChildren(emptyState('数据不足', getInsufficientText(payload, latestHealth.have_days), { kind: 'insufficient' }));
    return;
  }
  const days = calendarDays(payload.series || []);
  calendarDayMap = new Map(days.map((day) => [day.date, day]));
  const stats = calendarStats(days);
  if (!stats.firstRecorded) {
    clear();
    nodes.calHeatmap.replaceChildren(emptyState('这一年还没有记录', '', { kind: 'insufficient' }));
    return;
  }
  renderCalendarSummary(days, stats);
  renderCalendarGrid(days, stats);
  renderCalendarLegend(days, stats);

  // 默认看今天；翻到往年时看那年听得最多的一天。
  const selected = calendarDayMap.get(state.calendarDay);
  if (!selected || selected.state === 'blank') {
    const fallback = days.find((day) => day.is_current && day.state !== 'blank') || stats.peak
      || [...days].reverse().find((day) => day.state !== 'blank');
    state.calendarDay = fallback.date;
  }
  selectCalendarDay(state.calendarDay);
}

// animate：翻年份时用 View Transition 淡入淡出；首屏加载直接替换骨架。
async function loadCalendar({ animate = false } = {}) {
  const requestId = ++calendarRequestId;
  // 每日快照会补进昨天的差分，刷新时不能沿用旧的当天歌曲。
  calendarTopSongs.clear();
  const thisYear = state.calendarYear === new Date().getFullYear();
  nodes.calHeatmap.setAttribute('aria-busy', 'true');
  // 今年不传 to，由服务端按统计时区取「今天」，与趋势图对齐。
  const params = { granularity: 'day', from: `${state.calendarYear}-01-01` };
  if (!thisYear) params.to = `${state.calendarYear}-12-31`;
  const payload = await getJson('/api/trend', params).catch((error) => ({ error: error.message }));
  if (requestId !== calendarRequestId) return;
  // View Transition 的回调要等下一帧才跑，这期间可能又翻了年份；到时再核一次，旧年份不覆盖新请求。
  const update = () => {
    if (requestId !== calendarRequestId) return;
    renderCalendar(payload);
    nodes.calHeatmap.removeAttribute('aria-busy');
  };
  if (animate) withViewTransition(update);
  else update();
}

// 当天面板：第一次出现时从 0 展开；换天或骨架换成歌曲后高度变了，就从旧高度过渡到新高度。
// 换了一天整块淡入；同一天只在骨架换成歌曲时淡入列表，切次数/时长这类内容不变的重画不闪。
let calDetailResize = null;
let calDetailDate = null;

function showCalendarDetail(date, parts) {
  const panel = nodes.calDetail;
  const wasHidden = panel.hidden;
  const sameDay = !wasHidden && calDetailDate === date;
  const wasLoading = sameDay && Boolean(panel.querySelector('.skeleton'));
  // 先量旧高度（上一段过渡还在跑时量到的是过渡中的高度），再停掉它，否则量不到新内容的自然高度。
  const from = wasHidden ? 0 : panel.getBoundingClientRect().height;
  if (calDetailResize) {
    calDetailResize.cancel();
    calDetailResize = null;
    panel.classList.remove('is-resizing');
  }
  panel.hidden = false;
  panel.replaceChildren(...parts);
  calDetailDate = date;

  const fresh = !sameDay ? [...panel.children] : wasLoading ? [panel.querySelector('.cal-detail__songs')] : [];
  for (const node of fresh) playMotion(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 });

  const to = panel.getBoundingClientRect().height;
  if (Math.abs(to - from) < 1) return;
  const margin = getComputedStyle(panel).marginTop;
  const resize = playMotion(panel, wasHidden
    ? [{ height: '0px', marginTop: '0px' }, { height: `${to}px`, marginTop: margin }]
    : [{ height: `${from}px` }, { height: `${to}px` }], { duration: 500 });
  if (!resize) return;
  calDetailResize = resize;
  panel.classList.add('is-resizing');
  resize.finished.catch(() => {}).finally(() => {
    if (calDetailResize !== resize) return;
    calDetailResize = null;
    panel.classList.remove('is-resizing');
  });
}

function renderCalendarDetail(day, tops) {
  const head = document.createElement('div');
  head.className = 'cal-detail__head';
  const title = document.createElement('h3');
  title.textContent = dayTitle(day.date);
  const meta = document.createElement('span');
  head.append(title, meta);

  const text = (content) => {
    const paragraph = document.createElement('p');
    paragraph.className = 'cal-detail__text';
    paragraph.textContent = content;
    return paragraph;
  };
  const count = `${day.lower_bound ? '至少 ' : ''}${formatNumber(day.plays)} 次`;
  if (day.state === 'gap') {
    meta.textContent = '数据未知';
    showCalendarDetail(day.date, [head, text('这天的播放没有完整记下，无法知道听了多少。')]);
    return;
  }
  if (day.state === 'zero') {
    meta.textContent = '0 次';
    showCalendarDetail(day.date, [head, text('这天没有播放。')]);
    return;
  }

  const songs = tops?.songs?.length && !tops.error ? `，${formatNumber(tops.distinct_songs)} 首歌` : '';
  meta.textContent = day.is_current
    ? `进行中，已记下 ${count}`
    : day.state === 'estimated' ? `${count}，日期不确定` : `${count}${songs}，约 ${hoursLabel(day.est_minutes)} 小时`;
  const parts = [head];
  if (day.state === 'estimated') parts.push(text(`这 ${formatNumber(day.plays)} 次可能包含前几天没记下的播放，具体哪天听的无法确定。`));

  // 与首页排行同一种行：名次、封面、歌名、次数；宽屏分两列，省一半高度。
  const list = document.createElement('ol');
  list.className = 'cal-detail__songs';
  let rows;
  if (!tops) {
    rows = SKELETON_WIDTHS.slice(0, CALENDAR_DAY_SONGS).map((width) => skeletonRow('rank-row', [
      skeleton('skeleton--short'), skeleton('skeleton--cover'), skeletonLines(width), skeleton('skeleton--short'),
    ]));
  } else if (tops.error) {
    rows = [emptyState('这天的歌曲读取失败', tops.error, { kind: 'error', tag: 'li' })];
  } else {
    rows = (tops.songs || []).map((entry) => {
      const row = document.createElement('li');
      row.className = 'rank-row';
      const index = document.createElement('span');
      index.className = 'rank-index';
      index.textContent = String(entry.rank).padStart(2, '0');
      const cover = document.createElement('span');
      cover.className = 'rank-cover';
      cover.append(createCoverMedia(entry.song?.album?.picUrl, ''));
      const main = document.createElement('span');
      main.className = 'rank-main';
      const subtitle = document.createElement('span');
      subtitle.className = 'rank-subtitle';
      subtitle.textContent = songSubtitle(entry.song);
      main.append(createTitle(entry.song?.name, 'song', entry.song?.id), subtitle);
      const value = document.createElement('span');
      value.className = 'rank-value';
      value.textContent = `${tops.lower_bound ? '≥' : ''}${formatNumber(entry.plays)} 次`;
      row.append(index, cover, main, value);
      return row;
    });
  }
  // 两列竖排：先排满左列再排右列，名次从上往下读。
  list.style.setProperty('--rows', String(Math.max(Math.ceil(rows.length / 2), 1)));
  list.append(...rows);
  parts.push(list);
  showCalendarDetail(day.date, parts);
}

async function selectCalendarDay(date) {
  const day = calendarDayMap.get(date);
  if (!day || day.state === 'blank') return;
  state.calendarDay = date;
  syncCalendarSelection();
  const requestId = ++calendarDayRequestId;
  const needsSongs = day.state === 'played' || day.state === 'estimated';
  // 今天还在变，不缓存。
  const cached = day.is_current ? null : calendarTopSongs.get(date);
  renderCalendarDetail(day, needsSongs ? cached : null);
  if (!needsSongs || cached) return;
  const payload = await getJson('/api/daily-top-songs', { days: 1, to: date, limit: CALENDAR_DAY_SONGS })
    .catch((error) => ({ error: error.message }));
  const tops = payload.error ? { error: payload.error } : payload.items?.[0] || { songs: [] };
  if (!tops.error && !day.is_current) calendarTopSongs.set(date, tops);
  if (requestId === calendarDayRequestId) renderCalendarDetail(day, tops);
}

// ---- 详情抽屉：歌曲 / 歌手 / 专辑 ----

function drawerLink(text, dimension, id) {
  if (!id) return document.createTextNode(text || '');
  const button = document.createElement('button');
  button.className = 'drawer__link';
  button.type = 'button';
  button.dataset.entity = dimension;
  button.dataset.entityId = String(id);
  button.textContent = text || '未命名';
  return button;
}

function joinedLinks(className, items, dimension) {
  const line = document.createElement('p');
  line.className = className;
  items.forEach((item, index) => {
    if (index) line.append(document.createTextNode(' / '));
    line.append(drawerLink(item.name, dimension, item.id));
  });
  return line;
}

function detailSectionHead(title, meta = '') {
  const head = document.createElement('div');
  head.className = 'hourly__head';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const note = document.createElement('p');
  note.textContent = meta;
  head.append(heading, note);
  return head;
}

function detailFact(label, value, unit, { lowerBound = false, accent = false } = {}) {
  const item = document.createElement('div');
  const term = document.createElement('dt');
  term.textContent = label;
  const data = document.createElement('dd');
  if (accent) data.className = 'is-accent';
  if (lowerBound) {
    const prefix = document.createElement('span');
    prefix.className = 'metric-prefix';
    prefix.textContent = '≥';
    data.append(prefix);
  }
  data.append(document.createTextNode(value));
  if (unit) {
    const small = document.createElement('small');
    small.textContent = unit;
    data.append(small);
  }
  item.append(term, data);
  return item;
}

function detailEmpty(text) {
  const paragraph = document.createElement('p');
  paragraph.className = 'drawer__empty';
  paragraph.textContent = text;
  return paragraph;
}

// 近 90 天逐日柱：缺口画浅色竖带、日期不确定用浅色柱、今天用强调色；指针跟随显示当天读数。
function detailDailyChart(trend) {
  if (!trend || trend.error || trend.insufficientData || !trend.series?.length) {
    return [detailEmpty(trend?.error ? `逐日记录读取失败：${trend.error}` : '还没有逐日记录。')];
  }
  const series = trend.series;
  const width = 392;
  const top = 4;
  const base = 64;
  const slot = width / series.length;
  const barWidth = Math.max(1.5, Math.min(slot * 0.6, 8));
  const max = Math.max(...series.map((point) => point.plays || 0), 1);
  const total = series.reduce((sum, point) => sum + (point.plays || 0), 0);
  const active = series.filter((point) => point.plays > 0).length;
  const lowerBound = series.some((point) => point.lower_bound);
  const span = series.length >= DETAIL_CHART_DAYS ? `近 ${DETAIL_CHART_DAYS} 天` : `${monthDayLabel(series[0].start)}以来`;
  const summary = total
    ? `${span}${lowerBound ? '至少' : ''}听了 ${formatNumber(total)} 次，分布在 ${formatNumber(active)} 天里`
    : `${span}没有记下播放`;

  const svg = makeSvgElement('svg', { viewBox: `0 0 ${width} ${base + 22}`, role: 'img', 'aria-label': summary });
  const hover = makeSvgElement('rect', { x: 0, y: top, width: slot, height: base - top, class: 'dc-hover' });
  svg.append(hover);
  series.forEach((point, index) => {
    if (point.missing) svg.append(makeSvgElement('rect', { x: index * slot, y: top, width: slot, height: base - top, class: 'dc-gap' }));
  });
  svg.append(makeSvgElement('line', { x1: 0, y1: base + 0.5, x2: width, y2: base + 0.5, class: 'dc-base' }));
  series.forEach((point, index) => {
    if (!point.plays) return;
    const height = Math.max(2, (point.plays / max) * (base - top));
    const variant = point.is_current ? ' is-today' : point.estimated ? ' is-uncertain' : '';
    // --at：柱子在时间轴上的位置（0–1），从左到右依次长出来。
    svg.append(makeSvgElement('rect', {
      x: index * slot + (slot - barWidth) / 2, y: base - height, width: barWidth, height, class: `dc-bar${variant}`,
      style: `--at: ${(index / series.length).toFixed(3)}`,
    }));
  });
  const endLabel = series.at(-1).is_current ? '今天' : monthDayLabel(series.at(-1).start);
  const labels = series
    .map((point, index) => ({ point, index }))
    .filter(({ point, index }) => point.start.endsWith('-01') && index * slot < width - 48);
  if (!labels.length) labels.push({ point: series[0], index: 0, text: monthDayLabel(series[0].start) });
  for (const { point, index, text } of labels) {
    const label = makeSvgElement('text', { x: index * slot, y: base + 18, class: 'trend-axis-label' });
    label.textContent = text || `${Number(point.start.slice(5, 7))}月`;
    svg.append(label);
  }
  const last = makeSvgElement('text', { x: width, y: base + 18, 'text-anchor': 'end', class: 'trend-axis-label' });
  last.textContent = endLabel;
  svg.append(last);

  const detail = document.createElement('p');
  detail.className = 'detail-line';
  detail.textContent = summary;
  svg.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    const index = Math.min(series.length - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * series.length)));
    const point = series[index];
    hover.setAttribute('x', index * slot);
    hover.classList.add('is-on');
    const count = `${point.lower_bound ? '至少 ' : ''}${formatNumber(point.plays)} 次`;
    const reading = point.missing ? '数据未知'
      : point.is_current ? `今天，已记下 ${count}`
        : point.estimated ? `${count}，具体日期不确定` : count;
    detail.textContent = `${dayTitle(point.start)}：${reading}`;
  });
  svg.addEventListener('pointerleave', () => {
    hover.classList.remove('is-on');
    detail.textContent = summary;
  });

  const figure = document.createElement('div');
  figure.className = 'drawer-chart';
  figure.append(svg);
  const caption = document.createElement('div');
  caption.className = 'trend-caption';
  for (const [show, className, label] of [
    [true, 'legend-bar', '每天播放'],
    [series.some((point) => point.estimated && point.plays), 'legend-uncertain', '日期不确定'],
    [series.some((point) => point.missing), 'legend-gap', '数据未知'],
  ]) {
    if (!show) continue;
    const item = document.createElement('span');
    const marker = document.createElement('i');
    marker.className = className;
    item.append(marker, document.createTextNode(label));
    caption.append(item);
  }
  return [figure, detail, caption];
}

function detailHourlyChart(hourly) {
  const buckets = hourly?.buckets || [];
  const max = Math.max(...buckets.map((bucket) => bucket.plays), 0);
  if (buckets.length !== 24 || !max) return { content: detailEmpty('近 30 天没有能对应到小时的播放。'), meta: '近 30 天' };
  const peaks = buckets.filter((bucket) => bucket.plays && bucket.plays / max >= 0.8).map((bucket) => bucket.hour);
  const width = 392;
  const base = 40;
  const slot = width / 24;
  const meta = `近 30 天，高峰 ${peaks.map((hour) => String(hour).padStart(2, '0')).join('、')} 时`;
  const svg = makeSvgElement('svg', { viewBox: `0 0 ${width} ${base + 20}`, role: 'img', 'aria-label': `按小时的播放分布，${meta}` });
  for (const bucket of buckets) {
    const height = bucket.plays ? Math.max(2, (bucket.plays / max) * base) : 1;
    const variant = bucket.plays ? (peaks.includes(bucket.hour) ? ' is-peak' : '') : ' is-empty';
    const bar = makeSvgElement('rect', {
      x: bucket.hour * slot + slot * 0.15, y: base - height, width: slot * 0.7, height, rx: 1, class: `dh-bar${variant}`,
      style: `--at: ${(bucket.hour / 24).toFixed(3)}`,
    });
    const tooltip = makeSvgElement('title');
    tooltip.textContent = `${String(bucket.hour).padStart(2, '0')} 时：${formatNumber(bucket.plays)} 次`;
    bar.append(tooltip);
    svg.append(bar);
  }
  for (const hour of [0, 6, 12, 18, 23]) {
    const label = makeSvgElement('text', { x: hour * slot + slot / 2, y: base + 16, 'text-anchor': 'middle', class: 'trend-axis-label' });
    label.textContent = String(hour).padStart(2, '0');
    svg.append(label);
  }
  const figure = document.createElement('div');
  figure.className = 'drawer-chart';
  figure.append(svg);
  return { content: figure, meta };
}

function recentPlayLabel(value) {
  const date = toLocalDate(value);
  if (!date) return ['未知时间', ''];
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const iso = date.toLocaleDateString('en-CA');
  const offset = isoDayDiff(new Date().toLocaleDateString('en-CA'), iso);
  const when = offset === 0 ? '今天' : offset === 1 ? '昨天' : dayTitle(iso);
  return [when, time];
}

function detailList(rows) {
  const list = document.createElement('ol');
  list.className = 'drawer-list';
  for (const [text, aside, className = 'when'] of rows) {
    const item = document.createElement('li');
    const main = document.createElement('span');
    main.className = className;
    main.textContent = text;
    const side = document.createElement('span');
    side.className = 'aside';
    side.textContent = aside;
    item.append(main, side);
    list.append(item);
  }
  return list;
}

function renderDetail(detail, trend, windowKey) {
  if (!detail || detail.error) {
    const notFound = /^404\b/.test(detail?.error || '');
    const failure = emptyState(
      notFound ? '本地还没有这条记录' : '详情读取失败',
      notFound ? '采集器下一次抓取后就能看到。' : detail?.error || '请稍后重试',
      { kind: notFound ? 'insufficient' : 'error' },
    );
    failure.querySelector('strong').id = 'drawerTitle';
    nodes.drawerBody.replaceChildren(failure);
    applyDetailTone(null);
    return;
  }
  const { entity, meta, window: windowTotals, all } = detail;
  const dimension = meta.dimension;
  const windowLabel = WINDOW_LABEL[windowKey] || WINDOW_LABEL.month;
  const allLowerBound = Boolean(meta.all_data_quality?.lower_bound);

  const head = document.createElement('header');
  head.className = 'drawer__head';
  const cover = document.createElement('span');
  cover.className = 'drawer__cover';
  const pic = dimension === 'song' ? entity.album?.picUrl : entity.picUrl;
  cover.append(pic ? createCoverMedia(pic, '') : icon(dimension === 'artist' ? 'mic2' : 'music'));
  toneFromCover(cover, currentDetail);
  const titleBlock = document.createElement('div');
  titleBlock.className = 'drawer__title';
  const title = document.createElement('h2');
  title.id = 'drawerTitle';
  title.textContent = entity.name || '未命名';
  titleBlock.append(title);
  if (entity.artists?.length) titleBlock.append(joinedLinks('drawer__artists', entity.artists, 'artist'));
  if (dimension === 'song' && entity.album?.id) {
    const album = document.createElement('p');
    album.className = 'drawer__album';
    album.append(drawerLink(entity.album.name, 'album', entity.album.id));
    titleBlock.append(album);
  }
  if (windowTotals.rank) {
    const rank = document.createElement('p');
    rank.className = 'drawer__album';
    rank.textContent = `${windowLabel}排第 ${formatNumber(windowTotals.rank)}`;
    titleBlock.append(rank);
  }
  head.append(cover, titleBlock);

  const facts = document.createElement('dl');
  facts.className = 'drawer-facts';
  if (windowKey !== 'all') {
    facts.append(detailFact(windowLabel, formatNumber(windowTotals.plays), '次', {
      lowerBound: Boolean(meta.data_quality?.lower_bound), accent: true,
    }));
  }
  facts.append(
    detailFact('全部记录', formatNumber(all.plays), '次', { lowerBound: allLowerBound, accent: windowKey === 'all' }),
    detailFact('累计时长', hoursLabel(all.est_minutes), '小时', { lowerBound: allLowerBound }),
    detailFact('第一次记录', all.first_date ? monthDayLabel(all.first_date) : '--', ''),
  );
  if (windowKey === 'all') facts.append(detailFact('最近一次', all.last_date ? monthDayLabel(all.last_date) : '--', ''));

  const daily = document.createElement('section');
  daily.className = 'drawer-section';
  daily.append(detailSectionHead('每天听了几次', `近 ${DETAIL_CHART_DAYS} 天`), ...detailDailyChart(trend));

  const hourly = document.createElement('section');
  hourly.className = 'drawer-section';
  const hourlyChart = detailHourlyChart(detail.hourly);
  hourly.append(detailSectionHead('一天里什么时候听', hourlyChart.meta), hourlyChart.content);

  const sections = [head, facts, daily, hourly];
  if (dimension === 'song') {
    const recent = document.createElement('section');
    recent.className = 'drawer-section';
    recent.append(detailSectionHead('最近几次'), detail.recent_plays?.length
      ? detailList(detail.recent_plays.map(recentPlayLabel))
      : detailEmpty('最近播放里还没出现过这首歌。'));
    const lists = document.createElement('section');
    lists.className = 'drawer-section';
    lists.append(
      detailSectionHead('收在这些歌单里', detail.playlists?.length ? `${formatNumber(detail.playlists.length)} 个` : ''),
      detail.playlists?.length
        ? detailList(detail.playlists.map((item) => [item.name || '未命名歌单', `${formatNumber(item.trackCount)} 首`, 'name']))
        : detailEmpty('还没收进任何歌单。'),
    );
    sections.push(recent, lists);
  } else {
    const songs = document.createElement('section');
    songs.className = 'drawer-section';
    const songList = document.createElement('ol');
    songList.append(...(detail.top_songs || []).map((song) => makeSongRow(song, `${formatNumber(song.plays)} 次`)));
    songs.append(
      detailSectionHead(windowKey === 'all' ? '最常听的歌' : `${windowLabel}最常听的歌`),
      songList.childElementCount ? songList : detailEmpty(`${windowLabel}没有播放。`),
    );
    sections.push(songs);
  }

  const notes = [];
  if (allLowerBound) notes.push('≥ 表示已记录到的最低次数，部分时段的播放没有完整记下。');
  if (all.first_date && meta.data_first_date && isoDayDiff(all.first_date, meta.data_first_date) < 7) {
    notes.push(`记录从 ${monthDayLabel(meta.data_first_date)}开始，在那之前听过多少无从得知。`);
  }
  if (detail.hourly?.unlocated_plays) {
    notes.push(`近 30 天另有 ${formatNumber(detail.hourly.unlocated_plays)} 次只记到了天，没有算进小时分布。`);
  }
  if (notes.length) {
    const note = document.createElement('p');
    note.className = 'drawer__note';
    note.textContent = notes.join('');
    sections.push(note);
  }
  nodes.drawerBody.replaceChildren(...sections);
}

// 封面取色：只取一个色相给抽屉用（底色淡淡染一层、强调色换成同色相）。
// 图片走本站 /api/cover，同源才能读像素；灰白或读不到的封面不取色，保持默认配色。
const coverToneCache = new Map();
let toneCanvas = null;

function rgbToHsl(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === r ? (g - b) / delta + (g < b ? 6 : 0) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue / 6, saturation, lightness];
}

function sampleCoverTone(image) {
  const key = image.currentSrc || image.src;
  if (coverToneCache.has(key)) return coverToneCache.get(key);
  const size = 24;
  toneCanvas ||= Object.assign(document.createElement('canvas'), { width: size, height: size });
  let tone = null;
  try {
    const context = toneCanvas.getContext('2d', { willReadFrequently: true });
    context.clearRect(0, 0, size, size);
    context.drawImage(image, 0, 0, size, size);
    const { data } = context.getImageData(0, 0, size, size);
    let x = 0;
    let y = 0;
    let weights = 0;
    let saturationSum = 0;
    for (let index = 0; index < data.length; index += 4) {
      const [hue, saturation, lightness] = rgbToHsl(data[index], data[index + 1], data[index + 2]);
      // 越鲜艳、越接近中间亮度的像素越算数，大片白底、黑底和灰色几乎不参与。
      const weight = saturation * (1 - Math.abs(lightness - 0.5) * 2) * (data[index + 3] / 255);
      if (weight <= 0) continue;
      x += Math.cos(hue * 2 * Math.PI) * weight;
      y += Math.sin(hue * 2 * Math.PI) * weight;
      weights += weight;
      saturationSum += saturation * weight;
    }
    if (weights / (size * size) > 0.06) {
      tone = {
        hue: Math.round(((Math.atan2(y, x) / (2 * Math.PI)) + 1) % 1 * 360),
        saturation: Math.round(Math.min(60, Math.max(28, (saturationSum / weights) * 100))),
      };
    }
  } catch {
    tone = null;
  }
  coverToneCache.set(key, tone);
  return tone;
}

function applyDetailTone(tone) {
  nodes.drawer.classList.toggle('has-tone', Boolean(tone));
  if (!tone) return;
  nodes.drawer.style.setProperty('--tone-h', String(tone.hue));
  nodes.drawer.style.setProperty('--tone-s', `${tone.saturation}%`);
}

// 封面加载完再取色；期间已经换到别的详情就不再套用。
function toneFromCover(cover, detailKey) {
  const image = cover.querySelector('img');
  if (!image) {
    applyDetailTone(null);
    return;
  }
  const apply = () => {
    if (currentDetail === detailKey) applyDetailTone(image.naturalWidth ? sampleCoverTone(image) : null);
  };
  if (image.complete) apply();
  else image.addEventListener('load', apply, { once: true });
}

function renderDetailSkeleton() {
  const head = document.createElement('div');
  head.className = 'drawer__head';
  const titleBlock = document.createElement('div');
  titleBlock.className = 'drawer__title';
  const title = document.createElement('h2');
  title.id = 'drawerTitle';
  title.setAttribute('aria-label', '正在读取');
  title.append(skeleton('skeleton--line', { w: '70%' }));
  titleBlock.append(title, skeleton('skeleton--line is-sub', { w: '70%' }));
  head.append(skeleton('drawer__cover'), titleBlock);
  nodes.drawerBody.replaceChildren(head, skeleton('skeleton--chart'));
}

async function openDetail(dimension, id, { remember = true } = {}) {
  const requestId = ++detailRequestId;
  // 打开那一刻的统计窗口；抽屉开着时窗口按钮被遮罩挡住，不会中途变化。
  const windowKey = state.window;
  const navigating = nodes.drawer.open;
  if (navigating && remember && currentDetail) detailHistory.push(currentDetail);
  currentDetail = { dimension, id };
  nodes.drawerBack.hidden = !detailHistory.length;
  nodes.drawerExternal.href = `https://music.163.com/#/${dimension}?id=${encodeURIComponent(id)}`;
  nodes.drawerBody.setAttribute('aria-busy', 'true');
  renderDetailSkeleton();
  if (!navigating) nodes.drawer.showModal();
  nodes.drawer.scrollTop = 0;
  // 抽屉里点到别的歌手/专辑时新内容从右边推进来，「返回」时从左边推回来，看得出往哪走。
  // 动的是 drawerBody 本身，骨架中途换成内容也接着滑完。
  if (navigating) {
    playMotion(nodes.drawerBody, [
      { opacity: 0, transform: `translateX(${remember ? 32 : -32}px)` },
      { opacity: 1, transform: 'none' },
    ], { duration: 500 });
  }
  const [detail, trend] = await Promise.all([
    getJson(`/api/detail/${dimension}/${encodeURIComponent(id)}`, { period: windowKey }).catch((error) => ({ error: error.message })),
    getJson('/api/trend', { granularity: 'day', last: DETAIL_CHART_DAYS, [`${dimension}_id`]: id }).catch((error) => ({ error: error.message })),
  ]);
  if (requestId !== detailRequestId) return;
  renderDetail(detail, trend, windowKey);
  nodes.drawerBody.removeAttribute('aria-busy');
  // 骨架换成内容时各段淡入，不硬切；淡的是子元素，不和上面 drawerBody 的推入抢同一个属性。
  for (const section of nodes.drawerBody.children) playMotion(section, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
  // 抽屉内换内容时，原先聚焦的按钮已被移除；把焦点交给新标题，读屏会念出换到了谁。
  if (navigating) {
    const title = document.getElementById('drawerTitle');
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }
}

// 统计窗口同时决定概览与排行，不触发趋势、封面、最近播放或歌单请求。
async function loadWindowData() {
  setActiveButtons();
  const currentOverviewRequest = ++overviewRequestId;
  const currentRankingRequest = ++rankingRequestId;
  nodes.rankingList.setAttribute('aria-busy', 'true');
  const [overview, ranking] = await Promise.all([
    getJson('/api/overview', { period: state.window }).catch((error) => ({ error: error.message })),
    getJson('/api/ranking', { dimension: state.dimension, metric: 'plays', period: state.window, limit: 10 }).catch((error) => ({ error: error.message })),
  ]);
  withViewTransition(() => {
    if (currentOverviewRequest === overviewRequestId) renderOverview(overview, latestHealth);
    if (currentRankingRequest !== rankingRequestId) return;
    renderRanking(ranking, latestHealth);
    nodes.rankingList.removeAttribute('aria-busy');
  });
}

// 排行维度只改变当前统计窗口下的本地排行查询。
async function loadRanking() {
  setActiveButtons();
  const requestId = ++rankingRequestId;
  nodes.rankingList.setAttribute('aria-busy', 'true');
  const ranking = await getJson('/api/ranking', {
    dimension: state.dimension,
    metric: 'plays',
    period: state.window,
    limit: 10,
  }).catch((error) => ({ error: error.message }));
  withViewTransition(() => {
    if (requestId !== rankingRequestId) return;
    renderRanking(ranking, latestHealth);
    nodes.rankingList.removeAttribute('aria-busy');
  });
}

// 趋势查询固定的 30 日 / 12 周 / 12 月序列，只影响趋势图本身；换周期时折线重新描出，不再整块淡入淡出。
async function loadTrend() {
  setActiveButtons();
  const requestId = ++trendRequestId;
  nodes.trendChart.setAttribute('aria-busy', 'true');
  const trend = await getJson('/api/trend', {
    granularity: state.granularity,
    last: state.granularity === 'day' ? 30 : 12,
  }).catch((error) => ({ error: error.message }));
  if (requestId !== trendRequestId) return;
  renderTrend(trend, latestHealth, { animate: true });
  nodes.trendChart.removeAttribute('aria-busy');
}

async function loadDashboard() {
  setActiveButtons();
  const dashboardOverviewRequest = ++overviewRequestId;
  const dashboardRankingRequest = ++rankingRequestId;
  const dashboardTrendRequest = ++trendRequestId;
  nodes.refreshButton.disabled = true;
  nodes.refreshButton.setAttribute('aria-busy', 'true');
  nodes.refreshButton.classList.remove('is-spinning');
  void nodes.refreshButton.offsetWidth;
  nodes.refreshButton.classList.add('is-spinning');

  try {
    const health = await getJson('/api/health');
    latestHealth = health;
    renderHealth(health);
    const playlistPromise = loadPlaylists();
    const calendarPromise = loadCalendar();
    const recentPromise = getJson('/api/netease/record/recent/song', { limit: 30 })
      .catch((error) => ({ error: error.message }));
    const [overview, ranking, trend, dailyTops, hourly] = await Promise.all([
      getJson('/api/overview', { period: state.window }).catch((error) => ({ error: error.message })),
      getJson('/api/ranking', { dimension: state.dimension, metric: 'plays', period: state.window, limit: 10 }).catch((error) => ({ error: error.message })),
      getJson('/api/trend', { granularity: state.granularity, last: state.granularity === 'day' ? 30 : 12 }).catch((error) => ({ error: error.message })),
      getJson('/api/daily-top-songs', { days: MOSAIC_DAYS, limit: MOSAIC_COLUMNS }).catch((error) => ({ error: error.message })),
      getJson('/api/hourly-activity').catch((error) => ({ error: error.message })),
    ]);
    if (dashboardOverviewRequest === overviewRequestId) renderOverview(overview, health);
    if (dashboardRankingRequest === rankingRequestId) renderRanking(ranking, health);
    if (dashboardTrendRequest === trendRequestId) renderTrend(trend, health, { animate: true });
    renderMosaic(dailyTops);
    renderHourlyActivity(hourly);
    renderRecent(await recentPromise);
    await playlistPromise;
    await loadPlaylistTracks();
    await calendarPromise;
  } catch (error) {
    nodes.serviceStatus.dataset.state = 'error';
    nodes.serviceStatusText.textContent = '服务不可用';
    nodes.heroSubtitle.textContent = '';
    // 首屏骨架必须全部换掉，否则服务不可用时会一直停在加载态。
    for (const node of [nodes.metricPlays, nodes.metricHours, nodes.metricSongs, nodes.metricDays]) setMetricValue(node, '--');
    renderPlaylists({ error: error.message });
    nodes.rankingList.replaceChildren(emptyState('读取失败', error.message, { kind: 'error', tag: 'li' }));
    nodes.recentList.replaceChildren(emptyState('读取失败', error.message, { kind: 'error', tag: 'li' }));
    nodes.trendChart.replaceChildren(emptyState('读取失败', error.message, { kind: 'error' }));
    nodes.hourlyHeatmap.replaceChildren(emptyState('读取失败', error.message, { kind: 'error' }));
    renderMosaic({ error: error.message });
    renderCalendar({ error: error.message });
  } finally {
    nodes.refreshButton.disabled = false;
    nodes.refreshButton.removeAttribute('aria-busy');
  }
}

document.addEventListener('click', (event) => {
  const windowButton = event.target.closest('[data-window]');
  if (windowButton) {
    state.window = windowButton.dataset.window;
    loadWindowData();
    return;
  }

  const dimension = event.target.closest('[data-dimension]');
  if (dimension) {
    state.dimension = dimension.dataset.dimension;
    loadRanking();
    return;
  }

  const granularity = event.target.closest('[data-granularity]');
  if (granularity) {
    state.granularity = granularity.dataset.granularity;
    loadTrend();
    return;
  }

  const pager = event.target.closest('[data-pager]');
  if (pager && !pager.disabled) {
    const step = pager.dataset.dir === 'next' ? 1 : -1;
    if (pager.dataset.pager === 'playlist') {
      state.playlistOffset = Math.max(0, state.playlistOffset + step * PLAYLIST_PAGE_SIZE);
      loadPlaylists();
    } else {
      state.trackOffset = Math.max(0, state.trackOffset + step * TRACK_PAGE_SIZE);
      loadPlaylistTracks();
    }
    return;
  }

  const playlist = event.target.closest('[data-playlist-id]');
  if (playlist) {
    state.playlistId = playlist.dataset.playlistId;
    state.trackOffset = 0;
    document.querySelectorAll('[data-playlist-id]').forEach((button) => {
      const selected = button.dataset.playlistId === state.playlistId;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    loadPlaylistTracks();
    return;
  }

  const entity = event.target.closest('[data-entity]');
  if (entity) {
    // 封面墙的格子带当天次数，先写到区块下方，关掉抽屉后仍看得到点的是哪一格。
    if (entity.dataset.detail) setDetail(entity.dataset.detailTarget, entity.dataset.detail, entity);
    openDetail(entity.dataset.entity, entity.dataset.entityId);
    return;
  }

  const calendarMetric = event.target.closest('[data-cal-metric]');
  if (calendarMetric) {
    state.calendarMetric = calendarMetric.dataset.calMetric;
    // 指标只换格子深浅与文案，不重新请求。
    if (lastCalendar) withViewTransition(() => renderCalendar(lastCalendar));
    return;
  }

  const calendarYear = event.target.closest('[data-cal-year]');
  if (calendarYear && !calendarYear.disabled) {
    state.calendarYear += Number(calendarYear.dataset.calYear);
    state.calendarDay = null;
    loadCalendar({ animate: true });
    return;
  }

  const calendarDay = event.target.closest('button.cal-cell');
  if (calendarDay) {
    selectCalendarDay(calendarDay.dataset.date);
    return;
  }

  const detail = event.target.closest('[data-detail]');
  if (detail) setDetail(detail.dataset.detailTarget, detail.dataset.detail, detail);
});

// 日历方向键：左右一周、上下一天（与格子排列一致），只移动焦点；回车或空格再选中。
nodes.calHeatmap.addEventListener('keydown', (event) => {
  const cell = event.target.closest('button.cal-cell');
  const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
  if (!cell || !step) return;
  const next = nodes.calHeatmap.querySelector(`button.cal-cell[data-date="${isoAddDays(cell.dataset.date, step)}"]`);
  if (!next) return;
  event.preventDefault();
  cell.tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
});

nodes.mosaic.addEventListener('pointerover', (event) => {
  linkMosaicSong(event.target.closest('.mosaic-cover')?.dataset.songId);
});
nodes.mosaic.addEventListener('pointerleave', () => linkMosaicSong(null));
nodes.mosaic.addEventListener('focusin', (event) => {
  linkMosaicSong(event.target.closest('.mosaic-cover')?.dataset.songId);
});
nodes.mosaic.addEventListener('focusout', (event) => {
  if (!nodes.mosaic.contains(event.relatedTarget)) linkMosaicSong(null);
});

nodes.drawerClose.addEventListener('click', () => nodes.drawer.close());
nodes.drawerBack.addEventListener('click', () => {
  const previous = detailHistory.pop();
  if (previous) openDetail(previous.dimension, previous.id, { remember: false });
});
nodes.drawer.addEventListener('close', () => {
  detailHistory.length = 0;
  currentDetail = null;
  applyDetailTone(null);
});
// 点遮罩关闭：只认落在抽屉矩形之外的点击，内容较短时点到抽屉空白处不算。
nodes.drawer.addEventListener('click', (event) => {
  if (event.target !== nodes.drawer) return;
  const rect = nodes.drawer.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside) nodes.drawer.close();
});

compactChart.addEventListener('change', () => {
  if (lastTrend) renderTrend(lastTrend.payload, lastTrend.health);
});

nodes.refreshButton.addEventListener('click', loadDashboard);

// 顶栏高亮当前所在区块；排行与最近播放归入「今天」。键的顺序即页面顺序。
const NAV_SECTIONS = { overview: 'overview', ranking: 'overview', live: 'overview', trend: 'trend', calendar: 'calendar', covers: 'covers', playlists: 'playlists' };
const navLinks = [...document.querySelectorAll('.nav-links a')];
const sectionsInView = new Set();

function setCurrentNav(id) {
  for (const link of navLinks) {
    if (link.hash === `#${id}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

// 判定带取顶栏下方到视口 40% 处；区块间隙里没有命中时保持上一次高亮。
const navObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) sectionsInView.add(entry.target.id);
    else sectionsInView.delete(entry.target.id);
  }
  const current = Object.keys(NAV_SECTIONS).filter((id) => sectionsInView.has(id)).at(-1);
  if (current) setCurrentNav(NAV_SECTIONS[current]);
}, { rootMargin: '-80px 0px -60% 0px' });
Object.keys(NAV_SECTIONS).forEach((id) => navObserver.observe(document.getElementById(id)));
setCurrentNav('overview');

const revealObserver = new IntersectionObserver((entries, observer) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add('is-revealed');
    observer.unobserve(entry.target);
  }
}, { rootMargin: '0px 0px -10% 0px' });
document.querySelectorAll('.page-shell > .block, .split > .block').forEach((block) => {
  block.classList.add('reveal');
  revealObserver.observe(block);
});

// 主题：默认跟随系统；手动切到与系统相同的一侧时清掉记录，之后继续跟随系统。
function storedTheme() {
  try {
    const theme = localStorage.getItem(THEME_KEY);
    return theme === 'dark' || theme === 'light' ? theme : null;
  } catch {
    return null;
  }
}

function currentTheme() {
  return document.documentElement.dataset.theme || (darkScheme.matches ? 'dark' : 'light');
}

function syncThemeControls() {
  const dark = currentTheme() === 'dark';
  const label = dark ? '切换到浅色' : '切换到深色';
  nodes.themeToggle.setAttribute('aria-label', label);
  nodes.themeToggle.title = label;
  nodes.themeToggle.querySelector('use').setAttribute('href', dark ? '#icon-sun' : '#icon-moon');
  const pageColor = getComputedStyle(document.documentElement).getPropertyValue('--n-1').trim();
  nodes.themeColors.forEach((meta) => { meta.content = pageColor; });
}

nodes.themeToggle.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  const system = darkScheme.matches ? 'dark' : 'light';
  withViewTransition(() => {
    if (next === system) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    syncThemeControls();
  }, 'theme');
  try {
    if (next === system) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    // 无痕模式等场景写不进去时只在本次打开里生效。
  }
});
darkScheme.addEventListener('change', syncThemeControls);
// 别的标签页改了主题：这里立刻跟上，下次切换才不会拿过时的状态去算、覆盖掉新的偏好。
// key 为 null 表示整个存储被清空，也按「跟随系统」处理。
window.addEventListener('storage', (event) => {
  if (event.key !== THEME_KEY && event.key !== null) return;
  const theme = storedTheme();
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  syncThemeControls();
});
syncThemeControls();

// 字体加载、窗口变宽变窄都会改变按钮尺寸，滑块跟着重新定位。
const indicatorObserver = new ResizeObserver(() => syncSwitchIndicators());
document.querySelectorAll('.segmented, .tabs').forEach((group) => indicatorObserver.observe(group));

const now = new Date();
nodes.heroDate.dateTime = now.toLocaleDateString('en-CA');
nodes.heroDate.textContent = `${chineseNumber(now.getMonth() + 1)}月${chineseNumber(now.getDate())}日`;
renderSkeletons();
loadDashboard();
