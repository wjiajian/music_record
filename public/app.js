const state = {
  window: 'day',
  rankingPeriod: 'day',
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
let mobilePlaylists = [];

const PLAYLIST_PAGE_SIZE = 10;
const TRACK_PAGE_SIZE = 10;
const MOSAIC_DAYS = 7;
const MOSAIC_COLUMNS = 8;
const SVG_NS = 'http://www.w3.org/2000/svg';
const numberFormat = new Intl.NumberFormat('zh-CN');
const percentFormat = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const nodes = {
  topbar: document.querySelector('.topbar'),
  dateWatermark: document.querySelector('#dateWatermark'),
  chapterWatermark: document.querySelector('#chapterWatermark'),
  heroSubtitle: document.querySelector('#heroSubtitle'),
  lastSnapshot: document.querySelector('#lastSnapshot'),
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
  trendRange: document.querySelector('#trendRange'),
  rankingList: document.querySelector('#rankingList'),
  recentList: document.querySelector('#recentList'),
  todayList: document.querySelector('#todayList'),
  playlistList: document.querySelector('#playlistList'),
  playlistSelect: document.querySelector('#playlistSelect'),
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
  footerTimezone: document.querySelector('#footerTimezone'),
};

const TOPBAR_REVEAL_ZONE = 24;
const TOPBAR_HIDE_AFTER = 80;
const TOPBAR_SCROLL_TRIGGER = 18;
let lastTopbarScrollY = Math.max(0, window.scrollY);
let topbarScrollDistance = 0;
let topbarScrollScheduled = false;

function revealTopbar() {
  nodes.topbar.classList.remove('is-hidden');
}

function updateTopbarOnScroll() {
  const currentY = Math.max(0, window.scrollY);
  const delta = currentY - lastTopbarScrollY;

  if (delta && Math.sign(delta) !== Math.sign(topbarScrollDistance)) topbarScrollDistance = 0;
  topbarScrollDistance += delta;

  if (currentY <= TOPBAR_HIDE_AFTER || topbarScrollDistance <= -TOPBAR_SCROLL_TRIGGER || nodes.topbar.matches(':focus-within')) {
    revealTopbar();
    topbarScrollDistance = 0;
  } else if (topbarScrollDistance >= TOPBAR_SCROLL_TRIGGER) {
    nodes.topbar.classList.add('is-hidden');
    topbarScrollDistance = 0;
  }

  lastTopbarScrollY = currentY;
  topbarScrollScheduled = false;
}

function scheduleTopbarUpdate() {
  if (topbarScrollScheduled) return;
  topbarScrollScheduled = true;
  window.requestAnimationFrame(updateTopbarOnScroll);
}

window.addEventListener('scroll', scheduleTopbarUpdate, { passive: true });
window.addEventListener('pointermove', (event) => {
  if (event.clientY <= TOPBAR_REVEAL_ZONE) revealTopbar();
}, { passive: true });
nodes.topbar.addEventListener('focusin', revealTopbar);

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

function formatHours(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return `${numberFormat.format(value)}h`;
}

function formatPlayTime(value) {
  if (!value) return '未知时间';
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return '未知时间';
  const date = new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatRange(range) {
  if (!range?.start || !range?.end) return '统计范围尚未形成';
  return range.start === range.end ? range.start : `${range.start} — ${range.end}`;
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
  digitNode.className = 'metric-digits';
  digitNode.textContent = digits;
  node.replaceChildren(prefixNode, digitNode);
  node.dataset.raw = raw;
  if (previous && previous !== raw && !reducedMotion.matches && digitNode.animate) {
    digitNode.animate(
      [
        { opacity: 0, transform: 'translateY(45%)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 360, easing: 'cubic-bezier(.2,.8,.2,1)' }
    );
  }
}

function emptyState(title, text, { kind = 'empty', iconName = 'compass' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `empty-state is-${kind}`;
  const inner = document.createElement('div');
  inner.className = 'empty-state__inner';
  const iconWrap = document.createElement('span');
  iconWrap.className = 'empty-state__icon';
  iconWrap.append(icon(iconName));
  const strong = document.createElement('strong');
  strong.textContent = title;
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  inner.append(iconWrap, strong, paragraph);
  wrap.append(inner);
  return wrap;
}

function scheduleCoverGlow(image, target) {
  const extract = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 10;
      canvas.height = 10;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;
      context.drawImage(image, 0, 0, 10, 10);
      const pixels = context.getImageData(0, 0, 10, 10).data;
      let red = 0;
      let green = 0;
      let blue = 0;
      let weight = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const r = pixels[index];
        const g = pixels[index + 1];
        const b = pixels[index + 2];
        const saturation = Math.max(r, g, b) - Math.min(r, g, b);
        const brightness = (r + g + b) / 3;
        if (pixels[index + 3] < 160 || brightness < 24 || brightness > 238) continue;
        const pixelWeight = 1 + saturation / 80;
        red += r * pixelWeight;
        green += g * pixelWeight;
        blue += b * pixelWeight;
        weight += pixelWeight;
      }
      if (weight) {
        target.style.setProperty(
          '--cover-glow',
          `rgba(${Math.round(red / weight)}, ${Math.round(green / weight)}, ${Math.round(blue / weight)}, .28)`
        );
      }
    } catch {
      // 封面环境色只是渐进增强；像素不可读时保留钴蓝回退。
    }
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(extract, { timeout: 700 });
  else window.setTimeout(extract, 0);
}

function createCoverMedia(source, alt, glowTarget) {
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
  image.addEventListener('load', () => {
    media.classList.add('is-loaded');
    if (glowTarget) scheduleCoverGlow(image, glowTarget);
  }, { once: true });
  image.addEventListener('error', () => media.classList.add('is-loaded', 'is-error'), { once: true });
  image.src = cached;
  media.append(image);
  return media;
}

function getInsufficientText(payload, haveDays) {
  if (payload?.error) return `读取失败：${payload.error}`;
  const have = payload?.haveDays ?? haveDays ?? 0;
  const need = payload?.needDays ?? 1;
  return `目前只有 ${formatNumber(have)} 个有效日期，至少需要 ${formatNumber(need)} 个。`;
}

function missingDailyTopText(reason) {
  if (reason === 'gap') return '数据缺口：这一天没有被完整观察。';
  if (reason === 'insufficient') return '数据不足：尚未形成可用的日级统计。';
  return '无播放：这一天已完整观察，播放次数为零。';
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

  const rows = items.map((item) => {
    const row = document.createElement('div');
    row.className = 'mosaic-row';
    if (item.reason === 'gap') row.classList.add('is-gap');
    if (item.reason === 'insufficient') row.classList.add('is-insufficient');

    const meta = document.createElement('span');
    meta.className = 'mosaic-row__meta';
    const date = document.createElement('strong');
    date.textContent = item.date ? item.date.slice(5).replace('-', '.') : '--.--';
    const count = document.createElement('span');
    const lowerBound = item.lower_bound ? '≥' : '';
    count.textContent = item.songs?.length
      ? `${lowerBound}${formatNumber(item.plays)} 次 / ${formatNumber(item.distinct_songs)} 首`
      : item.reason === 'gap' ? '沟槽断开' : item.reason === 'insufficient' ? '尚未形成' : '空沟槽';
    meta.append(date, count);

    const groove = document.createElement('div');
    groove.className = 'mosaic-groove';
    groove.setAttribute('aria-label', `${item.date || '未知日期'}：${item.songs?.length ? count.textContent : missingDailyTopText(item.reason)}`);
    const covers = Array.from({ length: MOSAIC_COLUMNS }, (_, coverIndex) => {
      const entry = item.songs?.[coverIndex];
      if (!entry) {
        const slot = document.createElement('span');
        slot.className = 'mosaic-slot';
        slot.setAttribute('aria-hidden', 'true');
        return slot;
      }
      const button = document.createElement('button');
      button.className = 'mosaic-cover';
      button.type = 'button';
      const title = entry.song?.name || '未命名歌曲';
      const artists = songSubtitle(entry.song);
      const label = `${item.date}，${title}，${artists}，${formatNumber(entry.plays)} 次播放`;
      button.setAttribute('aria-label', label);
      button.title = label;
      const vinyl = document.createElement('span');
      vinyl.className = 'vinyl-disc';
      vinyl.setAttribute('aria-hidden', 'true');
      const pic = entry.song?.album?.picUrl || entry.song?.picUrl;
      button.append(vinyl, createCoverMedia(pic, '', button));
      return button;
    });
    groove.append(...covers);
    row.append(meta, groove);
    return row;
  });
  nodes.mosaic.replaceChildren(...rows);

  if (payload?.error) {
    nodes.mosaicSummary.textContent = `七日封面读取失败：${payload.error}`;
  } else if (payload?.meta?.data_quality?.lower_bound) {
    nodes.mosaicSummary.textContent = '七日范围存在历史覆盖不足或采集缺口；可见次数均按下界理解。';
  } else {
    nodes.mosaicSummary.textContent = '每天最多展示八张真实封面；空沟槽不会补造数据。';
  }
}

function renderHealth(health) {
  const hasService = Boolean(health?.last_recent_poll_at || health?.last_snapshot);
  const warning = health?.counter_stale || health?.last_fetch_status === 'fail';
  const stateName = !hasService ? 'loading' : warning ? 'warning' : 'healthy';
  nodes.serviceStatus.dataset.state = stateName;
  nodes.serviceStatusText.textContent = warning ? '采集需注意' : hasService ? '数据监听中' : '等待数据';
  nodes.lastSnapshot.textContent = health?.last_snapshot || '--';
  nodes.heroSubtitle.textContent = health?.last_snapshot
    ? `账本更新至 ${health.last_snapshot}；最近事件于 ${health.last_recent_poll_at ? formatPlayTime(Date.parse(health.last_recent_poll_at)) : '尚未捕获'} 观察。`
    : '还没有可用快照；页面会保留数据不足状态，不把未知解释为零。';
}

function renderOverview(overview, health) {
  if (!overview || overview.error || overview.insufficientData) {
    setMetricValue(nodes.metricPlays, '--');
    setMetricValue(nodes.metricHours, '--');
    setMetricValue(nodes.metricSongs, '--');
    setMetricValue(nodes.metricDays, formatNumber(health.have_days));
    nodes.metricRange.textContent = '统计范围尚未形成';
    nodes.metricPlaysHint.textContent = overview?.error ? `读取失败：${overview.error}` : getInsufficientText(overview, health.have_days);
    return;
  }

  const lowerBound = Boolean(overview.meta?.data_quality?.lower_bound);
  const prefix = lowerBound ? '≥' : '';
  setMetricValue(nodes.metricPlays, `${prefix}${formatNumber(overview.totals.plays)}`);
  setMetricValue(nodes.metricHours, `${prefix}${formatHours(overview.totals.est_hours)}`);
  setMetricValue(nodes.metricSongs, `${prefix}${formatNumber(overview.totals.distinct_songs)}`);
  setMetricValue(nodes.metricDays, `${prefix}${formatNumber(overview.totals.days_tracked)}`);
  nodes.metricRange.textContent = formatRange(overview.range);
  nodes.metricPlaysHint.textContent = lowerBound ? '下界统计 · 范围内存在未完整观察的数据' : '精确统计 · 当前范围观察完整';
}

function rankingPic(item) {
  if (state.dimension === 'song') return item.album?.picUrl || item.picUrl;
  if (state.dimension === 'album') return item.picUrl;
  return '';
}

function renderRanking(payload, health) {
  nodes.rankingList.replaceChildren();
  if (!payload || payload.error) {
    nodes.rankingList.append(emptyState('排行读取失败', payload?.error || '本地排行接口没有返回结果。', { kind: 'error', iconName: 'triangle-alert' }));
    return;
  }
  if (payload.insufficientData) {
    nodes.rankingList.append(emptyState('数据不足', getInsufficientText(payload, health.have_days), { kind: 'insufficient' }));
    return;
  }
  nodes.rankingRange.textContent = formatRange(payload.meta?.period_resolved);
  const items = payload.items || [];
  if (!items.length) {
    nodes.rankingList.append(emptyState('无播放', '当前统计窗口已读取，但没有可展示的播放增量。'));
    return;
  }

  const max = Math.max(...items.map((item) => item.plays || 0), 1);
  const lowerBound = Boolean(payload.meta?.data_quality?.lower_bound);
  const rows = items.map((item) => {
    const row = document.createElement('div');
    row.className = 'rank-row';
    row.classList.toggle('is-podium', item.rank <= 3);

    const index = document.createElement('span');
    index.className = 'rank-index';
    index.textContent = String(item.rank).padStart(2, '0');

    const cover = document.createElement('span');
    cover.className = 'rank-cover';
    const pic = rankingPic(item);
    if (pic) cover.append(createCoverMedia(pic, '', cover));
    else cover.append(icon(state.dimension === 'artist' ? 'mic2' : 'music'));

    const main = document.createElement('div');
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

    const energy = document.createElement('span');
    energy.className = 'rank-energy';
    energy.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.style.setProperty('--bar-width', `${Math.max(4, Math.round(((item.plays || 0) / max) * 100))}%`);
    energy.append(fill);
    row.append(index, cover, main, value, energy);
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

function makeSongRow(item, { valueText = '', metaText = '' } = {}) {
  const row = document.createElement('div');
  row.className = 'song-row';
  const art = document.createElement('span');
  art.className = 'song-row__art';
  const pic = item.song?.album?.picUrl || item.song?.picUrl || item.album?.picUrl || item.picUrl;
  art.append(createCoverMedia(pic, '', art));
  const main = document.createElement('div');
  main.className = 'song-row__main';
  const title = document.createElement('span');
  title.className = 'rank-title';
  title.textContent = item.song?.name || item.name || '未命名';
  const subtitle = document.createElement('span');
  subtitle.className = 'rank-subtitle';
  subtitle.textContent = metaText || songSubtitle(item.song || item);
  main.append(title, subtitle);
  const value = document.createElement('span');
  value.className = 'song-row__value';
  value.textContent = valueText;
  row.append(art, main, value);
  return row;
}

function renderRecent(payload) {
  if (!payload || payload.error) {
    nodes.recentList.replaceChildren(emptyState('读取失败', payload?.error || '最近播放接口未返回结果。', { kind: 'error', iconName: 'triangle-alert' }));
    return;
  }
  const items = payload.items || [];
  if (!items.length) {
    nodes.recentList.replaceChildren(emptyState('无播放', '近期接口已连通，目前没有捕获到播放事件。'));
    return;
  }
  nodes.recentList.replaceChildren(...items.slice(0, 10).map((item) => makeSongRow(item, {
    valueText: formatPlayTime(item.playTime),
    metaText: songSubtitle(item.song),
  })));
}

function renderToday(payload) {
  if (!payload || payload.error) {
    nodes.todayList.replaceChildren(emptyState('读取失败', payload?.error || '今日足迹接口未返回结果。', { kind: 'error', iconName: 'triangle-alert' }));
    return;
  }
  const items = payload.items || [];
  if (!items.length) {
    nodes.todayList.replaceChildren(emptyState('无播放', '今日视图已读取，目前没有歌曲记录。'));
    return;
  }
  nodes.todayList.replaceChildren(...items.slice(0, 10).map((item) => makeSongRow(item, {
    valueText: item.playCount == null ? '' : `${formatNumber(item.playCount)} 次`,
    metaText: songSubtitle(item.song),
  })));
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
    if (point.has_gap) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function renderTrend(payload, health) {
  nodes.trendChart.replaceChildren();
  if (!payload || payload.error) {
    nodes.trendChart.append(emptyState('趋势读取失败', payload?.error || '本地趋势接口没有返回结果。', { kind: 'error', iconName: 'triangle-alert' }));
    return;
  }
  if (payload.insufficientData) {
    nodes.trendChart.append(emptyState('数据不足', getInsufficientText(payload, health.have_days), { kind: 'insufficient' }));
    return;
  }
  const series = payload.series || [];
  if (!series.length) {
    nodes.trendChart.append(emptyState('数据不足', '当前粒度还没有形成任何时间桶。', { kind: 'insufficient' }));
    return;
  }
  if (series.every((point) => !point.plays) && !series.some((point) => point.has_gap)) {
    nodes.trendChart.append(emptyState('无播放', '当前趋势范围观察完整，但没有播放增量。'));
    return;
  }

  nodes.trendRange.textContent = formatRange(payload.meta?.range);
  const width = 900;
  const height = 300;
  const left = 54;
  const right = 18;
  const top = 18;
  const baseline = 248;
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
  desc.textContent = '每个点对应真实日、ISO 周或自然月；斜纹处是采集缺口，虚线标记尚未结束的当前周期。';
  const defs = makeSvgElement('defs');
  const gradient = makeSvgElement('linearGradient', { id: 'trend-area-gradient', x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.append(makeSvgElement('stop', { offset: '0%', 'stop-color': '#1f40ed', 'stop-opacity': '.24' }), makeSvgElement('stop', { offset: '100%', 'stop-color': '#1f40ed', 'stop-opacity': '.015' }));
  const pattern = makeSvgElement('pattern', { id: 'trend-gap-pattern', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pattern.append(makeSvgElement('rect', { width: 2, height: 8, fill: '#b5473c', opacity: '.18' }));
  defs.append(gradient, pattern);
  svg.append(title, desc, defs);

  for (let gridIndex = 0; gridIndex <= 4; gridIndex += 1) {
    const y = top + ((baseline - top) / 4) * gridIndex;
    svg.append(makeSvgElement('line', { x1: left, y1: y, x2: width - right, y2: y, class: 'trend-grid-line' }));
    const label = makeSvgElement('text', { x: left - 10, y, 'text-anchor': 'end', 'dominant-baseline': 'middle', class: 'trend-axis-label' });
    label.textContent = formatNumber(Math.round(max * (1 - gridIndex / 4)));
    svg.append(label);
  }

  for (const point of points.filter((entry) => entry.has_gap)) {
    const gapWidth = Math.max(10, Math.min(step * 0.72, 54));
    svg.append(makeSvgElement('rect', { x: point.x - gapWidth / 2, y: top, width: gapWidth, height: baseline - top, class: 'trend-gap' }));
  }

  for (const segment of splitTrendSegments(points)) {
    const line = segment.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
    const area = `M ${segment[0].x} ${baseline} ${line.replace(/^M/, 'L')} L ${segment.at(-1).x} ${baseline} Z`;
    svg.append(makeSvgElement('path', { d: area, class: 'trend-area' }));
    svg.append(makeSvgElement('path', { d: line, class: 'trend-line' }));
  }

  const labelStride = Math.max(1, Math.ceil(series.length / 7));
  points.forEach((point, index) => {
    if (point.is_current) {
      svg.append(makeSvgElement('line', { x1: point.x, y1: top, x2: point.x, y2: baseline, class: 'trend-current-line' }));
    }
    if (!point.has_gap) {
      const circle = makeSvgElement('circle', {
        cx: point.x,
        cy: point.y,
        r: point.is_current ? 5 : 3.5,
        class: `trend-point${point.is_current ? ' is-current' : ''}`,
        tabindex: 0,
        role: 'img',
        'aria-label': `${point.bucket}：${point.lower_bound ? '至少 ' : ''}${formatNumber(point.plays)} 次${point.is_current ? '，进行中' : ''}`,
      });
      const tooltip = makeSvgElement('title');
      tooltip.textContent = circle.getAttribute('aria-label');
      circle.append(tooltip);
      svg.append(circle);
    }
    if (index % labelStride === 0 || index === points.length - 1) {
      const label = makeSvgElement('text', { x: point.x, y: baseline + 27, 'text-anchor': 'middle', class: 'trend-axis-label' });
      label.textContent = shortBucket(point.bucket);
      svg.append(label);
    }
  });
  figure.append(svg);

  const caption = document.createElement('figcaption');
  caption.className = 'trend-caption';
  for (const [className, label] of [['legend-line', '真实离散桶'], ['legend-current', '进行中'], ['legend-gap', '采集缺口']]) {
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
    item.classList.toggle('is-gap', Boolean(point.has_gap));
    item.textContent = point.has_gap
      ? `${point.bucket} · 数据缺口 · ≥${formatNumber(point.plays)}`
      : `${point.bucket} · ${point.lower_bound ? '≥' : ''}${formatNumber(point.plays)}${point.is_current ? ' · 进行中' : ''}`;
    textData.append(item);
  }
  nodes.trendChart.append(figure, textData);
}

function renderHourlyActivity(payload) {
  nodes.hourlyHeatmap.replaceChildren();
  if (!payload || payload.error) {
    nodes.hourlyHeatmap.append(emptyState('小时分布读取失败', payload?.error || '小时活跃度接口没有返回结果。', { kind: 'error', iconName: 'triangle-alert' }));
    nodes.hourlyMeta.textContent = '读取失败；不将未知显示为零';
    return;
  }
  const buckets = payload.buckets || [];
  if (buckets.length !== 24) {
    nodes.hourlyHeatmap.append(emptyState('数据不足', '接口未返回完整的 24 个小时桶。', { kind: 'insufficient' }));
    return;
  }
  const max = Math.max(...buckets.map((bucket) => bucket.plays || 0), 1);
  const lowerBound = Boolean(payload.meta?.lower_bound);
  const cells = buckets.map((bucket) => {
    const cell = document.createElement('button');
    cell.className = 'hour-cell';
    cell.type = 'button';
    const intensity = (bucket.plays || 0) / max;
    cell.style.setProperty('--intensity', intensity.toFixed(3));
    cell.dataset.level = String(bucket.plays ? Math.max(1, Math.ceil(intensity * 5)) : 0);
    const label = `${String(bucket.hour).padStart(2, '0')} 时：${lowerBound ? '至少 ' : ''}${formatNumber(bucket.plays)} 次，${formatNumber(bucket.distinct_songs)} 首不同歌曲，占可定位播放 ${percentFormat.format(bucket.share || 0)}`;
    cell.setAttribute('aria-label', label);
    cell.title = label;
    const bar = document.createElement('i');
    bar.className = 'hour-cell__bar';
    bar.setAttribute('aria-hidden', 'true');
    const hour = document.createElement('strong');
    hour.textContent = String(bucket.hour).padStart(2, '0');
    const value = document.createElement('span');
    value.textContent = `${lowerBound ? '≥' : ''}${formatNumber(bucket.plays)}`;
    cell.append(bar, hour, value);
    return cell;
  });
  nodes.hourlyHeatmap.replaceChildren(...cells);
  const meta = payload.meta || {};
  const qualityLabel = meta.data_quality?.historical && !meta.located_plays ? '数据不足 · ' : lowerBound ? '下界视图 · ' : '';
  const unlocated = meta.unlocated_plays
    ? `；另有 ${formatNumber(meta.unlocated_plays)} 次日级补量无法定位到小时`
    : '';
  const gap = meta.collection_gaps?.length ? `；存在 ${formatNumber(meta.collection_gaps.length)} 段采集缺口` : '';
  nodes.hourlyMeta.textContent = `${qualityLabel}${formatRange(meta.range)} · ${formatNumber(meta.located_plays)} 次可定位事件${unlocated}${gap}`;
  nodes.footerTimezone.textContent = `${meta.timezone || 'LOCAL TIME'} / EXCLUDES TODAY`;
}

function renderPlaylistSelect(items) {
  const options = items.map((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.name || '未命名歌单'} · ${formatNumber(item.trackCount)} 首`;
    option.selected = String(item.id) === String(state.playlistId);
    return option;
  });
  if (!options.length) {
    const option = document.createElement('option');
    option.textContent = '没有可用歌单';
    option.disabled = true;
    options.push(option);
  }
  nodes.playlistSelect.replaceChildren(...options);
}

function renderPlaylists(payload, allPayload = null) {
  if (!payload || payload.error) {
    nodes.playlistList.replaceChildren(emptyState('歌单读取失败', payload?.error || '本地歌单接口没有返回结果。', { kind: 'error', iconName: 'triangle-alert' }));
    nodes.playlistTracks.replaceChildren(emptyState('未选择歌单', '歌单读取成功后会显示曲目。', { kind: 'insufficient' }));
    nodes.playlistCount.textContent = '--';
    return;
  }
  const items = payload.items || [];
  const allItems = allPayload?.items?.length ? allPayload.items : mobilePlaylists.length ? mobilePlaylists : items;
  mobilePlaylists = allItems;
  nodes.playlistCount.textContent = `${formatNumber(payload.total || items.length)} 份`;
  if (!items.length) {
    nodes.playlistList.replaceChildren(emptyState('没有歌单', '本地账本中尚未保存任何歌单。'));
    nodes.playlistTracks.replaceChildren(emptyState('未选择歌单', '没有可读取的曲目。', { kind: 'insufficient' }));
    renderPlaylistSelect([]);
    return;
  }
  if (!state.playlistId) state.playlistId = (allItems[0] || items[0]).id;
  const rows = items.map((item) => {
    const row = document.createElement('button');
    row.className = 'playlist-row';
    row.type = 'button';
    row.dataset.playlistId = item.id;
    row.classList.toggle('is-active', String(item.id) === String(state.playlistId));
    row.setAttribute('aria-pressed', String(item.id) === String(state.playlistId));
    const cover = document.createElement('span');
    cover.className = 'playlist-row__cover';
    cover.append(createCoverMedia(item.coverImgUrl, '', cover));
    const main = document.createElement('span');
    main.className = 'playlist-row__main';
    const title = document.createElement('span');
    title.className = 'rank-title';
    title.textContent = item.name || '未命名歌单';
    const subtitle = document.createElement('span');
    subtitle.className = 'rank-subtitle';
    subtitle.textContent = `${formatNumber(item.trackCount)} 首 · ${formatNumber(item.playCount)} 次播放`;
    main.append(title, subtitle);
    row.append(cover, main);
    return row;
  });
  nodes.playlistList.replaceChildren(...rows);
  renderPlaylistSelect(allItems);
}

function renderPlaylistTracks(payload) {
  if (!payload || payload.error) {
    nodes.playlistTrackTitle.textContent = '曲目';
    nodes.trackCount.textContent = '--';
    nodes.playlistTracks.replaceChildren(emptyState('曲目读取失败', payload?.error || '曲目接口没有返回结果。', { kind: 'error', iconName: 'triangle-alert' }));
    return;
  }
  nodes.playlistTrackTitle.textContent = payload.playlist?.name || '曲目';
  nodes.trackCount.textContent = `${formatNumber(payload.total || 0)} 首`;
  const rows = (payload.items || []).map((song, index) => makeSongRow({ song }, {
    valueText: String(state.trackOffset + index + 1).padStart(2, '0'),
    metaText: songSubtitle(song),
  }));
  nodes.playlistTracks.replaceChildren(...(rows.length ? rows : [emptyState('没有曲目', '这个歌单没有返回歌曲详情。')]));
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
  info.textContent = `第 ${current} / ${pageCount} 页 · 共 ${formatNumber(total)}`;
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
  const [payload, allPayload] = await Promise.all([
    getJson('/api/playlists', { limit: PLAYLIST_PAGE_SIZE, offset: state.playlistOffset }).catch((error) => ({ error: error.message })),
    mobilePlaylists.length
      ? Promise.resolve({ items: mobilePlaylists })
      : getJson('/api/playlists', { limit: 100, offset: 0 }).catch(() => null),
  ]);
  renderPlaylists(payload, allPayload);
  renderPager(nodes.playlistPager, {
    offset: state.playlistOffset,
    pageSize: PLAYLIST_PAGE_SIZE,
    total: payload && !payload.error ? payload.total : 0,
    kind: 'playlist',
  });
}

async function loadPlaylistTracks() {
  if (!state.playlistId) {
    nodes.playlistTracks.replaceChildren(emptyState('未选择歌单', '先从歌单索引中选择一项。', { kind: 'insufficient' }));
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

// 统计窗口会同时重置概览与排行周期，不触发趋势、封面墙、实时流或歌单请求。
async function loadWindowData() {
  setActiveButtons();
  const currentOverviewRequest = ++overviewRequestId;
  const currentRankingRequest = ++rankingRequestId;
  nodes.rankingList.setAttribute('aria-busy', 'true');
  const [overview, ranking] = await Promise.all([
    getJson('/api/overview', { period: state.window }).catch((error) => ({ error: error.message })),
    getJson('/api/ranking', { dimension: state.dimension, metric: 'plays', period: state.rankingPeriod, limit: 10 }).catch((error) => ({ error: error.message })),
  ]);
  if (currentOverviewRequest === overviewRequestId) renderOverview(overview, latestHealth);
  if (currentRankingRequest === rankingRequestId) renderRanking(ranking, latestHealth);
  nodes.rankingList.removeAttribute('aria-busy');
}

// 排行维度只改变当前排行周期下的本地排行查询。
async function loadRanking() {
  setActiveButtons();
  const requestId = ++rankingRequestId;
  nodes.rankingList.setAttribute('aria-busy', 'true');
  const ranking = await getJson('/api/ranking', {
    dimension: state.dimension,
    metric: 'plays',
    period: state.rankingPeriod,
    limit: 10,
  }).catch((error) => ({ error: error.message }));
  if (requestId === rankingRequestId) renderRanking(ranking, latestHealth);
  nodes.rankingList.removeAttribute('aria-busy');
}

// 趋势查询固定的 30 日 / 12 周 / 12 月序列；趋势按钮另行同步排行周期。
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
    const todayPromise = getJson('/api/netease/listen/data/today/song')
      .catch((error) => ({ error: error.message }));
    const [overview, ranking, trend, dailyTops, hourly] = await Promise.all([
      getJson('/api/overview', { period: state.window }).catch((error) => ({ error: error.message })),
      getJson('/api/ranking', { dimension: state.dimension, metric: 'plays', period: state.rankingPeriod, limit: 10 }).catch((error) => ({ error: error.message })),
      getJson('/api/trend', { granularity: state.granularity, last: state.granularity === 'day' ? 30 : 12 }).catch((error) => ({ error: error.message })),
      getJson('/api/daily-top-songs', { days: MOSAIC_DAYS, limit: MOSAIC_COLUMNS }).catch((error) => ({ error: error.message })),
      getJson('/api/hourly-activity').catch((error) => ({ error: error.message })),
    ]);
    if (dashboardOverviewRequest === overviewRequestId) renderOverview(overview, health);
    if (dashboardRankingRequest === rankingRequestId) renderRanking(ranking, health);
    if (dashboardTrendRequest === trendRequestId) renderTrend(trend, health);
    renderMosaic(dailyTops);
    renderHourlyActivity(hourly);
    await playlistPromise;
    await loadPlaylistTracks();
    const [recent, today] = await Promise.all([recentPromise, todayPromise]);
    renderRecent(recent);
    renderToday(today);
  } catch (error) {
    nodes.serviceStatus.dataset.state = 'error';
    nodes.serviceStatusText.textContent = '服务不可用';
    nodes.heroSubtitle.textContent = `读取失败：${error.message}`;
    const failure = () => emptyState('读取失败', error.message, { kind: 'error', iconName: 'triangle-alert' });
    nodes.rankingList.replaceChildren(failure());
    nodes.trendChart.replaceChildren(failure());
    nodes.recentList.replaceChildren(failure());
    nodes.todayList.replaceChildren(failure());
    nodes.hourlyHeatmap.replaceChildren(failure());
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
    state.rankingPeriod = state.window;
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
    state.rankingPeriod = state.granularity;
    loadTrend();
    loadRanking();
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
    nodes.playlistSelect.value = state.playlistId;
    loadPlaylistTracks();
  }
});

nodes.playlistSelect.addEventListener('change', () => {
  state.playlistId = nodes.playlistSelect.value;
  state.trackOffset = 0;
  loadPlaylistTracks();
});

nodes.refreshButton.addEventListener('click', loadDashboard);

const now = new Date();
const localDate = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
nodes.dateWatermark.textContent = localDate;
nodes.chapterWatermark.textContent = `CHRONO.${String(now.getMonth() + 1).padStart(2, '0')}`;
renderMosaic();
loadDashboard();
