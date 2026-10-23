const state = {
  window: 'day',
  dimension: 'song',
  granularity: 'day',
  playlistId: null,
  playlistOffset: 0,
  trackOffset: 0,
};

let latestHealth = { have_days: 0 };
let overviewRequestId = 0;
let rankingRequestId = 0;
let trendRequestId = 0;
let lastTrend = null;

const PLAYLIST_PAGE_SIZE = 10;
const TRACK_PAGE_SIZE = 10;
const MOSAIC_DAYS = 7;
const MOSAIC_COLUMNS = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';
const numberFormat = new Intl.NumberFormat('zh-CN');
const percentFormat = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const compactChart = window.matchMedia('(max-width: 640px)');

const WINDOW_PHRASE = { day: '今天', week: '最近 7 天', month: '最近 30 天', year: '最近一年', all: '有记录以来' };
const TREND_PHRASE = { day: ['近 30 天里', '天'], week: ['近 12 周里', '周'], month: ['近 12 个月里', '个月'] };
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

const nodes = {
  heroDate: document.querySelector('#heroDate'),
  heroSubtitle: document.querySelector('#heroSubtitle'),
  heroSummary: document.querySelector('#heroSummary'),
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
  trendSummary: document.querySelector('#trendSummary'),
  hourlyHeatmap: document.querySelector('#hourlyHeatmap'),
  hourlyMeta: document.querySelector('#hourlyMeta'),
  mosaic: document.querySelector('#mosaic'),
  mosaicSummary: document.querySelector('#mosaicSummary'),
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

function formatBucket(bucket) {
  if (!bucket) return '';
  if (bucket.includes('-W')) return `第 ${Number(bucket.split('-W').at(-1))} 周`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) return `${Number(bucket.slice(5, 7))} 月 ${Number(bucket.slice(8))} 日`;
  if (/^\d{4}-\d{2}$/.test(bucket)) return `${bucket.slice(0, 4)} 年 ${Number(bucket.slice(5))} 月`;
  return bucket;
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
  if (previous && previous !== raw && !reducedMotion.matches && digitNode.animate) {
    digitNode.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease' });
  }
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
      const label = `${item.date}，${entry.song?.name || '未命名歌曲'}，${songSubtitle(entry.song)}，${formatNumber(entry.plays)} 次播放`;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.dataset.detail = label;
      button.dataset.detailTarget = 'mosaicDetail';
      button.append(createCoverMedia(entry.song?.album?.picUrl || entry.song?.picUrl, ''));
      return button;
    }));
    row.append(meta, covers);
    return row;
  });
  nodes.mosaic.replaceChildren(...rows);
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
  const phrase = WINDOW_PHRASE[state.window] || '';
  if (!overview || overview.error || overview.insufficientData) {
    setMetricValue(nodes.metricPlays, '--');
    setMetricValue(nodes.metricHours, '--');
    setMetricValue(nodes.metricSongs, '--');
    setMetricValue(nodes.metricDays, formatNumber(health.have_days));
    nodes.metricRange.textContent = '天';
    nodes.metricPlaysHint.textContent = '次';
    nodes.heroSummary.textContent = overview?.error ? `读取失败：${overview.error}` : getInsufficientText(overview, health.have_days);
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

  if (!plays) {
    nodes.heroSummary.textContent = `${phrase}还没有播放记录。`;
    return;
  }
  const least = lowerBound ? '至少' : '';
  const daysText = state.window === 'day' ? '' : `，其中 ${formatNumber(days)} 天有播放`;
  const gapText = lowerBound ? '部分时段采集中断，数字是已记录的最低值。' : '';
  nodes.heroSummary.textContent = `${phrase}听了${least} ${formatNumber(plays)} 次、${formatNumber(songs)} 首不同的歌，约 ${formatNumber(hours)} 小时${daysText}。${gapText}`;
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
    const title = document.createElement('span');
    title.className = 'rank-title';
    title.textContent = item.name || '未命名';
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
  const title = document.createElement('span');
  title.className = 'rank-title';
  title.textContent = song?.name || '未命名';
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
  row.append(time, songTitleBlock(item.song));
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

function describeTrend(series) {
  const [lead, unit] = TREND_PHRASE[state.granularity] || TREND_PHRASE.day;
  const known = series.filter((point) => !point.missing);
  const peak = known.reduce((best, point) => ((point.plays || 0) > (best?.plays || 0) ? point : best), null);
  const missing = series.length - known.length;
  const peakText = peak?.plays ? `${lead}，${formatBucket(peak.bucket)}最多，${peak.lower_bound ? '至少 ' : ''}${formatNumber(peak.plays)} 次。` : `${lead}还没有播放记录。`;
  const gapText = missing ? `有 ${formatNumber(missing)} ${unit}采集中断，图中留作浅色空白，不按零次计。` : '';
  return peakText + gapText;
}

function renderTrend(payload, health) {
  lastTrend = { payload, health };
  nodes.trendChart.replaceChildren();
  nodes.trendSummary.textContent = '';
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

  nodes.trendSummary.textContent = describeTrend(series);
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

  for (const segment of splitTrendSegments(points)) {
    // 每段只画一块面积，进行中的桶不填充。
    const settled = segment.filter((point) => !point.is_current);
    if (settled.length > 1) {
      const outline = settled.map((point) => `L ${point.x} ${point.y}`).join(' ');
      const area = `M ${settled[0].x} ${baseline} ${outline} L ${settled.at(-1).x} ${baseline} Z`;
      svg.append(makeSvgElement('path', { d: area, class: 'trend-area' }));
    }
    for (let index = 1; index < segment.length; index += 1) {
      const previous = segment[index - 1];
      const point = segment[index];
      const inProgress = previous.is_current || point.is_current;
      const line = `M ${previous.x} ${previous.y} L ${point.x} ${point.y}`;
      svg.append(makeSvgElement('path', { d: line, class: `trend-line${inProgress ? ' is-current' : ''}` }));
    }
  }

  const labelStride = Math.max(1, Math.ceil(series.length / (compact ? 4 : 7)));
  points.forEach((point, index) => {
    if (point.is_current) {
      svg.append(makeSvgElement('line', { x1: point.x, y1: top, x2: point.x, y2: baseline, class: 'trend-current-line' }));
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
      svg.append(circle);
    }
    if (index % labelStride === 0 || index === points.length - 1) {
      const label = makeSvgElement('text', { x: point.x, y: baseline + 26, 'text-anchor': 'middle', class: 'trend-axis-label' });
      label.textContent = shortBucket(point.bucket);
      svg.append(label);
    }
  });
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
  if (currentOverviewRequest === overviewRequestId) renderOverview(overview, latestHealth);
  if (currentRankingRequest === rankingRequestId) renderRanking(ranking, latestHealth);
  nodes.rankingList.removeAttribute('aria-busy');
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
  if (requestId === rankingRequestId) renderRanking(ranking, latestHealth);
  nodes.rankingList.removeAttribute('aria-busy');
}

// 趋势查询固定的 30 日 / 12 周 / 12 月序列，只影响趋势图本身。
async function loadTrend() {
  setActiveButtons();
  const requestId = ++trendRequestId;
  nodes.trendChart.setAttribute('aria-busy', 'true');
  const trend = await getJson('/api/trend', {
    granularity: state.granularity,
    last: state.granularity === 'day' ? 30 : 12,
  }).catch((error) => ({ error: error.message }));
  if (requestId === trendRequestId) renderTrend(trend, latestHealth);
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
    if (dashboardTrendRequest === trendRequestId) renderTrend(trend, health);
    renderMosaic(dailyTops);
    renderHourlyActivity(hourly);
    renderRecent(await recentPromise);
    await playlistPromise;
    await loadPlaylistTracks();
  } catch (error) {
    nodes.serviceStatus.dataset.state = 'error';
    nodes.serviceStatusText.textContent = '服务不可用';
    nodes.heroSubtitle.textContent = '';
    nodes.heroSummary.textContent = `读取失败：${error.message}`;
    nodes.rankingList.replaceChildren(emptyState('读取失败', error.message, { kind: 'error', tag: 'li' }));
    nodes.recentList.replaceChildren(emptyState('读取失败', error.message, { kind: 'error', tag: 'li' }));
    nodes.trendChart.replaceChildren(emptyState('读取失败', error.message, { kind: 'error' }));
    nodes.hourlyHeatmap.replaceChildren(emptyState('读取失败', error.message, { kind: 'error' }));
    renderMosaic({ error: error.message });
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

  const detail = event.target.closest('[data-detail]');
  if (detail) setDetail(detail.dataset.detailTarget, detail.dataset.detail, detail);
});

compactChart.addEventListener('change', () => {
  if (lastTrend) renderTrend(lastTrend.payload, lastTrend.health);
});

nodes.refreshButton.addEventListener('click', loadDashboard);

const now = new Date();
nodes.heroDate.dateTime = now.toLocaleDateString('en-CA');
nodes.heroDate.textContent = `${chineseNumber(now.getMonth() + 1)}月${chineseNumber(now.getDate())}日`;
renderMosaic();
loadDashboard();
