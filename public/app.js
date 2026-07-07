const state = {
  period: 'day',
  dimension: 'song',
  granularity: 'day',
  playlistId: null,
  playlistOffset: 0,
  trackOffset: 0,
};

const PLAYLIST_PAGE_SIZE = 10; // 歌单列表每页条数
const TRACK_PAGE_SIZE = 10; // 曲目每页条数

const numberFormat = new Intl.NumberFormat('zh-CN');
const MOSAIC_DAYS = 7;
const MOSAIC_COLUMNS = 8;
const MOSAIC_TILE_OFFSETS = [
  { x: -3, y: -1, rotate: -2.2 },
  { x: 1, y: 2, rotate: 1.1 },
  { x: -1, y: -3, rotate: -0.8 },
  { x: 2, y: 0, rotate: 1.8 },
  { x: -2, y: 1, rotate: -1.4 },
  { x: 1, y: -2, rotate: 0.7 },
  { x: -1, y: 2, rotate: -1.8 },
  { x: 3, y: -1, rotate: 2.3 },
];
const MOSAIC_ROW_OFFSETS = [-7, 2, -4, 5, -2, 7, 0];
const PERIOD_BY_GRANULARITY = { day: 'day', week: 'week', month: 'month' };
const GRANULARITY_BY_PERIOD = { day: 'day', week: 'week', month: 'month' };

const nodes = {
  stripStatus: document.querySelector('#stripStatus'),
  heroSubtitle: document.querySelector('#heroSubtitle'),
  lastSnapshot: document.querySelector('#lastSnapshot'),
  healthPill: document.querySelector('#healthPill'),
  refreshButton: document.querySelector('#refreshButton'),
  metricPlays: document.querySelector('#metricPlays'),
  metricPlaysHint: document.querySelector('#metricPlaysHint'),
  metricHours: document.querySelector('#metricHours'),
  metricSongs: document.querySelector('#metricSongs'),
  metricDays: document.querySelector('#metricDays'),
  rankingList: document.querySelector('#rankingList'),
  recentList: document.querySelector('#recentList'),
  todayList: document.querySelector('#todayList'),
  playlistList: document.querySelector('#playlistList'),
  playlistPager: document.querySelector('#playlistPager'),
  playlistTracks: document.querySelector('#playlistTracks'),
  playlistTracksPager: document.querySelector('#playlistTracksPager'),
  playlistTrackTitle: document.querySelector('#playlistTrackTitle'),
  trendChart: document.querySelector('#trendChart'),
  mosaic: document.querySelector('#mosaic'),
};

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
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function getJson(path, params = {}) {
  const query = new URLSearchParams(params);
  const search = query.toString();
  const url = search ? `${path}?${search}` : path;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function setActiveButtons() {
  document.querySelectorAll('[data-period]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.period === state.period);
  });
  document.querySelectorAll('[data-dimension]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.dimension === state.dimension);
  });
  document.querySelectorAll('[data-granularity]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.granularity === state.granularity);
  });
}

function emptyState(title, message) {
  const root = document.createElement('div');
  root.className = 'empty-state';

  const inner = document.createElement('div');
  const heading = document.createElement('strong');
  heading.textContent = title;
  const copy = document.createElement('span');
  copy.textContent = message;

  inner.append(heading, copy);
  root.append(inner);
  return root;
}

function getInsufficientText(payload, fallbackHave = 0) {
  const have = payload?.haveDays ?? fallbackHave ?? 0;
  const need = payload?.needDays ?? 1;
  return `需要 ${need} 天，当前 ${have} 天`;
}

function missingDailyTopText(reason) {
  if (reason === 'loading') return '等待最近七天数据';
  if (reason === 'error') return '接口不可用';
  if (reason === 'gap') return '快照缺口';
  return '暂无播放增量';
}

function expandDailyCoverTiles(item, maxTiles = MOSAIC_COLUMNS) {
  const tiles = [];
  for (const entry of item.songs || []) {
    const repeat = Math.max(1, Math.min(Number(entry.plays || 0), maxTiles - tiles.length));
    for (let count = 0; count < repeat && tiles.length < maxTiles; count += 1) {
      tiles.push(entry);
    }
    if (tiles.length >= maxTiles) break;
  }
  return tiles;
}

function renderMosaic(payload = {}) {
  const fallback = Array.from({ length: MOSAIC_DAYS }, () => ({
    date: '',
    missing: true,
    reason: 'loading',
    songs: [],
    plays: 0,
  }));
  const errorFallback = Array.from({ length: MOSAIC_DAYS }, () => ({
    date: '',
    missing: true,
    reason: 'error',
    songs: [],
    plays: 0,
  }));
  const items = payload?.error ? errorFallback : (Array.isArray(payload) ? payload : payload?.items) || fallback;
  const dailyItems = Array.from({ length: MOSAIC_DAYS }, (_, index) => items[index] || fallback[index]);

  const rows = dailyItems.map((item, index) => {
    const row = document.createElement('div');
    row.className = 'mosaic-row';
    const coverTiles = expandDailyCoverTiles(item);
    row.classList.toggle('is-missing', Boolean(item.missing || coverTiles.length === 0));
    row.style.setProperty('--row-index', String(index));
    row.style.setProperty('--row-drift', `${MOSAIC_ROW_OFFSETS[index % MOSAIC_ROW_OFFSETS.length]}px`);
    row.title = coverTiles.length
      ? `${item.date}: ${formatNumber(item.plays)} 次 · ${formatNumber((item.songs || []).length)} 首`
      : `${item.date || '--'}: ${missingDailyTopText(item.reason)}`;

    const tiles = (coverTiles.length ? coverTiles : Array.from({ length: MOSAIC_COLUMNS }, () => null)).map((entry, tileIndex) => {
      const tile = document.createElement('span');
      tile.className = 'mosaic-cover';
      tile.style.setProperty('--cover-index', String(tileIndex));
      const offset = MOSAIC_TILE_OFFSETS[(tileIndex + index * 3) % MOSAIC_TILE_OFFSETS.length];
      tile.style.setProperty('--tile-x', `${offset.x}px`);
      tile.style.setProperty('--tile-y', `${offset.y}px`);
      tile.style.setProperty('--tile-tilt', `${offset.rotate}deg`);
      tile.style.setProperty('--tile-delay', `${0.08 + index * 0.045 + tileIndex * 0.018}s`);
      if (!entry) {
        tile.classList.add('mosaic-placeholder');
        tile.title = missingDailyTopText(item.reason);
        return tile;
      }
      const pic = entry.song?.album?.picUrl || entry.song?.picUrl;
      if (pic) {
        tile.style.backgroundImage = `linear-gradient(135deg, rgba(255,255,255,.22), rgba(255,255,255,0)), url("${pic}")`;
      }
      tile.title = `${entry.song?.name || '未命名'} · ${formatNumber(entry.plays)} 次`;
      return tile;
    });

    row.replaceChildren(...tiles);
    return row;
  });

  nodes.mosaic.replaceChildren(...rows);
}

function renderHealth(health) {
  nodes.lastSnapshot.textContent = health.last_snapshot || '--';
  nodes.healthPill.textContent = health.can_day ? '可读日榜' : '攒取中';
  nodes.stripStatus.textContent = `快照 ${formatNumber(health.snapshot_count)} 张 · 差分 ${formatNumber(health.have_days)} 天 · ${health.last_fetch_status || 'unknown'}`;
  nodes.heroSubtitle.textContent = health.last_snapshot
    ? `最新快照 ${health.last_snapshot}，当前差分天数 ${health.have_days}。`
    : '还没有可用快照。';
}

function renderOverview(overview, health) {
  if (!overview || overview.insufficientData) {
    nodes.metricPlays.textContent = '--';
    nodes.metricHours.textContent = '--';
    nodes.metricSongs.textContent = '--';
    nodes.metricDays.textContent = formatNumber(health.have_days);
    nodes.metricPlaysHint.textContent = getInsufficientText(overview, health.have_days);
    return;
  }

  nodes.metricPlays.textContent = formatNumber(overview.totals.plays);
  nodes.metricHours.textContent = formatHours(overview.totals.est_hours);
  nodes.metricSongs.textContent = formatNumber(overview.totals.distinct_songs);
  nodes.metricDays.textContent = formatNumber(overview.totals.days_tracked);
  nodes.metricPlaysHint.textContent = `${overview.range.start} 至 ${overview.range.end}`;
}

function renderRanking(payload, health) {
  nodes.rankingList.replaceChildren();
  if (!payload || payload.insufficientData) {
    nodes.rankingList.append(emptyState('排行未形成', getInsufficientText(payload, health.have_days)));
    return;
  }

  const items = payload.items || [];
  if (items.length === 0) {
    nodes.rankingList.append(emptyState('暂无播放增量', '当前周期没有可展示的播放记录。'));
    return;
  }

  const max = Math.max(...items.map((item) => item.plays || 0), 1);
  const rows = items.map((item) => {
    const row = document.createElement('div');
    row.className = 'rank-row';

    const index = document.createElement('span');
    index.className = 'rank-index';
    index.textContent = `#${String(item.rank).padStart(2, '0')}`;

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
    value.textContent = `${formatNumber(item.plays)} 次`;

    const bar = document.createElement('span');
    bar.className = 'rank-bar';
    const fill = document.createElement('span');
    fill.style.setProperty('--bar-width', `${Math.max(4, Math.round(((item.plays || 0) / max) * 100))}%`);
    bar.append(fill);

    row.append(index, main, value, bar);
    return row;
  });

  nodes.rankingList.replaceChildren(...rows);
}

function subtitleFor(item) {
  if (state.dimension === 'song') {
    const artists = (item.artists || []).map((artist) => artist.name).join(' / ');
    return artists || item.album?.name || '歌曲';
  }
  if (state.dimension === 'album') {
    return `${formatNumber(item.est_minutes)} 分钟`;
  }
  return `${formatNumber(item.est_minutes)} 分钟`;
}

function songSubtitle(song) {
  const artists = (song.artists || []).map((artist) => artist.name).filter(Boolean).join(' / ');
  return artists || song.album?.name || '歌曲';
}

function makeSongRow(item, { valueText = '', metaText = '' } = {}) {
  const row = document.createElement('div');
  row.className = 'song-row';

  const art = document.createElement('span');
  art.className = 'song-row__art';
  const pic = item.song?.album?.picUrl || item.song?.picUrl;
  if (pic) art.style.backgroundImage = `url("${pic}")`;

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
    nodes.recentList.replaceChildren(emptyState('最近播放不可用', payload?.error || '接口读取失败'));
    return;
  }
  const items = payload.items || [];
  if (!items.length) {
    nodes.recentList.replaceChildren(emptyState('暂无最近播放', '接口可用，但没有返回近期歌曲。'));
    return;
  }
  const rows = items.slice(0, 10).map((item) =>
    makeSongRow(item, {
      valueText: formatPlayTime(item.playTime),
      metaText: songSubtitle(item.song),
    })
  );
  nodes.recentList.replaceChildren(...rows);
}

function renderToday(payload) {
  if (!payload || payload.error) {
    nodes.todayList.replaceChildren(emptyState('今日足迹不可用', payload?.error || '接口读取失败'));
    return;
  }
  const items = payload.items || [];
  if (!items.length) {
    nodes.todayList.replaceChildren(emptyState('今日暂无足迹', '接口已连通，当前没有今日排行项目。'));
    return;
  }
  const rows = items.slice(0, 10).map((item) =>
    makeSongRow(item, {
      valueText: item.playCount == null ? '' : `${formatNumber(item.playCount)} 次`,
      metaText: songSubtitle(item.song),
    })
  );
  nodes.todayList.replaceChildren(...rows);
}

function renderPlaylists(payload) {
  if (!payload || payload.error) {
    nodes.playlistList.replaceChildren(emptyState('歌单不可用', payload?.error || '接口读取失败'));
    nodes.playlistTracks.replaceChildren(emptyState('未选择歌单', '歌单读取成功后会显示曲目。'));
    return null;
  }
  const items = payload.items || [];
  if (!items.length) {
    nodes.playlistList.replaceChildren(emptyState('暂无歌单', '没有返回可展示的用户歌单。'));
    nodes.playlistTracks.replaceChildren(emptyState('未选择歌单', '没有可读取的曲目。'));
    return null;
  }
  // 只在「尚无选择」时默认选第一个；翻页后选择应保留（选中项可能在别的页）。
  if (!state.playlistId && items.length) {
    state.playlistId = items[0].id;
  }
  const rows = items.map((item) => {
    const row = document.createElement('button');
    row.className = 'playlist-row';
    row.type = 'button';
    row.dataset.playlistId = item.id;
    row.classList.toggle('is-active', String(item.id) === String(state.playlistId));

    const cover = document.createElement('span');
    cover.className = 'playlist-row__cover';
    if (item.coverImgUrl) cover.style.backgroundImage = `url("${item.coverImgUrl}")`;

    const main = document.createElement('span');
    main.className = 'playlist-row__main';
    const title = document.createElement('span');
    title.className = 'rank-title';
    title.textContent = item.name || '未命名歌单';
    const subtitle = document.createElement('span');
    subtitle.className = 'rank-subtitle';
    subtitle.textContent = `${formatNumber(item.trackCount)} 首 · ${formatNumber(item.playCount)} 播放`;
    main.append(title, subtitle);

    row.append(cover, main);
    return row;
  });
  nodes.playlistList.replaceChildren(...rows);
  return items.find((item) => String(item.id) === String(state.playlistId));
}

function renderPlaylistTracks(payload) {
  if (!payload || payload.error) {
    nodes.playlistTrackTitle.textContent = '曲目';
    nodes.playlistTracks.replaceChildren(emptyState('曲目不可用', payload?.error || '接口读取失败'));
    return;
  }
  nodes.playlistTrackTitle.textContent = payload.playlist?.name || '曲目';
  const rows = (payload.items || []).map((song, index) =>
    makeSongRow(
      { song },
      {
        valueText: `#${String(state.trackOffset + index + 1).padStart(2, '0')}`,
        metaText: songSubtitle(song),
      }
    )
  );
  nodes.playlistTracks.replaceChildren(...(rows.length ? rows : [emptyState('暂无曲目', '这个歌单没有返回歌曲详情。')]));
}

function renderTrend(payload, health) {
  nodes.trendChart.replaceChildren();
  if (!payload || payload.insufficientData) {
    nodes.trendChart.style.setProperty('--bar-count', '1');
    nodes.trendChart.append(emptyState('趋势未形成', getInsufficientText(payload, health.have_days)));
    return;
  }

  const series = payload.series || [];
  if (series.length === 0 || series.every((point) => !point.plays)) {
    nodes.trendChart.style.setProperty('--bar-count', '1');
    nodes.trendChart.append(emptyState('暂无趋势', '当前范围没有播放增量。'));
    return;
  }

  const max = Math.max(...series.map((point) => point.plays || 0), 1);
  nodes.trendChart.style.setProperty('--bar-count', String(series.length));
  const bars = series.map((point) => {
    const bar = document.createElement('span');
    bar.className = 'trend-bar';
    bar.classList.toggle('is-gap', Boolean(point.has_gap));
    bar.style.setProperty('--bar-height', `${Math.max(8, Math.round(((point.plays || 0) / max) * 280))}px`);
    bar.dataset.label = shortBucket(point.bucket);
    bar.title = `${point.bucket}: ${formatNumber(point.plays)} 次`;
    return bar;
  });
  nodes.trendChart.replaceChildren(...bars);
}

function shortBucket(bucket) {
  if (!bucket) return '';
  if (bucket.includes('-W')) return bucket.split('-').at(-1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) return bucket.slice(5);
  if (/^\d{4}-\d{2}$/.test(bucket)) return bucket.slice(2);
  return bucket;
}

// 通用「上一页/下一页」翻页条。total<=pageSize 时隐藏（只有一页无需翻）。
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
  prev.textContent = '‹ 上一页';
  prev.disabled = offset <= 0;

  const info = document.createElement('span');
  info.className = 'pager-info';
  info.textContent = `第 ${current} / ${pageCount} 页 · 共 ${formatNumber(total)}`;

  const next = document.createElement('button');
  next.className = 'pager-btn';
  next.type = 'button';
  next.dataset.pager = kind;
  next.dataset.dir = 'next';
  next.textContent = '下一页 ›';
  next.disabled = offset + pageSize >= total;

  container.replaceChildren(prev, info, next);
}

async function loadPlaylists() {
  const payload = await getJson('/api/playlists', {
    limit: PLAYLIST_PAGE_SIZE,
    offset: state.playlistOffset,
  }).catch((error) => ({ error: error.message }));
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
    nodes.playlistTracks.replaceChildren(emptyState('未选择歌单', '先选择一个歌单。'));
    renderPager(nodes.playlistTracksPager, { total: 0 });
    return;
  }
  nodes.playlistTracks.replaceChildren(emptyState('读取曲目中', '正在请求 /api/playlists/:id/tracks。'));
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
}

async function loadDashboard() {
  setActiveButtons();
  nodes.refreshButton.disabled = true;
  nodes.refreshButton.setAttribute('aria-busy', 'true');

  try {
    const health = await getJson('/api/health');
    renderHealth(health);

    const [overview, ranking, trend, dailyTops, recent, today] = await Promise.all([
      getJson('/api/overview').catch((error) => ({ error: error.message })),
      getJson('/api/ranking', { dimension: state.dimension, metric: 'plays', period: state.period, limit: 10 }),
      getJson('/api/trend', { granularity: state.granularity, last: state.granularity === 'day' ? 30 : 12 }),
      getJson('/api/daily-top-songs', { days: 7 }).catch((error) => ({ error: error.message })),
      getJson('/api/netease/record/recent/song', { limit: 30 }).catch((error) => ({ error: error.message })),
      getJson('/api/netease/listen/data/today/song').catch((error) => ({ error: error.message })),
    ]);

    renderOverview(overview, health);
    renderRanking(ranking, health);
    renderTrend(trend, health);
    renderRecent(recent);
    renderToday(today);
    renderMosaic(dailyTops);

    // 歌单/曲目改读本地库，单独拉（各自带翻页），不再挤进上面的并发块
    await loadPlaylists();
    await loadPlaylistTracks();
  } catch (error) {
    nodes.stripStatus.textContent = `读取失败：${error.message}`;
    nodes.healthPill.textContent = '连接失败';
    nodes.rankingList.replaceChildren(emptyState('API 不可用', error.message));
    nodes.trendChart.replaceChildren(emptyState('API 不可用', error.message));
    nodes.recentList.replaceChildren(emptyState('API 不可用', error.message));
    nodes.todayList.replaceChildren(emptyState('API 不可用', error.message));
    renderMosaic({ items: Array.from({ length: 7 }, () => ({ missing: true, reason: 'gap', songs: [] })) });
  } finally {
    nodes.refreshButton.disabled = false;
    nodes.refreshButton.removeAttribute('aria-busy');
  }
}

document.addEventListener('click', (event) => {
  const period = event.target.closest('[data-period]');
  if (period) {
    state.period = period.dataset.period;
    if (GRANULARITY_BY_PERIOD[state.period]) {
      state.granularity = GRANULARITY_BY_PERIOD[state.period];
    }
    loadDashboard();
    return;
  }

  const dimension = event.target.closest('[data-dimension]');
  if (dimension) {
    state.dimension = dimension.dataset.dimension;
    loadDashboard();
    return;
  }

  const granularity = event.target.closest('[data-granularity]');
  if (granularity) {
    state.granularity = granularity.dataset.granularity;
    state.period = PERIOD_BY_GRANULARITY[state.granularity] || state.period;
    loadDashboard();
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
    state.trackOffset = 0; // 切歌单回到曲目第 1 页
    document.querySelectorAll('[data-playlist-id]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.playlistId === state.playlistId);
    });
    loadPlaylistTracks();
  }
});

nodes.refreshButton.addEventListener('click', loadDashboard);

renderMosaic();
loadDashboard();
