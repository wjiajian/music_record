// Fastify 六端点。所有聚合端点回 meta.period_resolved；用 missing/has_gap/estimated
// 区分「真 0」与「缺数据」；数据不足时回 200 + { insufficientData:true }。
import { DateTime } from 'luxon';
import { resolvePeriod, buckets, gapDates, isoWeekday, nowLocalDate } from '../aggregate/periods.js';
import * as Q from '../aggregate/queries.js';
import { config } from '../config.js';
import {
  fetchRecentSongs,
  fetchSongDetails,
  fetchTodayListenSongs,
} from '../netease/client.js';

const WEEKDAY_LABEL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function insufficient(db, needDays, extra = {}) {
  return { insufficientData: true, haveDays: Q.distinctPlayDates(db), needDays, ...extra };
}

function neteaseError(reply, err) {
  return reply.code(502).send({
    error: 'netease_fetch_failed',
    message: err?.message || String(err),
  });
}

function dataWindow(db) {
  const dates = Q.allSnapshotDates(db);
  const playRange = Q.dailyPlayDateRange(db);
  const first = [dates[0], playRange.first].filter(Boolean).sort()[0] || null;
  const last = [dates[dates.length - 1], playRange.last].filter(Boolean).sort().at(-1) || null;
  return { dates, first, last, playRange };
}

function freshness(db) {
  const latest = Q.latestSnapshot(db);
  return {
    last_snapshot_date: latest?.snapshot_date ?? null,
    fetched_at: latest?.fetched_at ?? null,
    today_listen: Q.latestTodayListenSnapshot(db) || null,
    recent_play: Q.latestRecentPlaySnapshot(db) || null,
    counter: Q.counterStatus(db),
  };
}

function localDateFromISO(value) {
  if (!value) return null;
  const dt = DateTime.fromISO(value, { setZone: true }).setZone(config.tz);
  return dt.isValid ? dt.toISODate() : null;
}

function dataQuality(db, start, end) {
  const counter = Q.counterStatus(db);
  const gaps = Q.counterPollGaps(db).filter((gap) => {
    const gapStart = localDateFromISO(gap.started_at);
    const gapEnd = localDateFromISO(gap.ended_at) || nowLocalDate();
    return gapStart && gapStart <= end && gapEnd >= start;
  });
  const lastSuccessMs = counter.last_success_at ? Date.parse(counter.last_success_at) : NaN;
  const stale =
    end >= nowLocalDate() &&
    (!Number.isFinite(lastSuccessMs) || Date.now() - lastSuccessMs > config.realtime.intervalMs * 3);
  const historical = !counter.complete_from || start < counter.complete_from;
  return {
    lower_bound: historical || gaps.length > 0 || stale,
    historical,
    has_gap: gaps.length > 0,
    stale,
    complete_from: counter.complete_from,
  };
}

export default async function routes(fastify) {
  const db = fastify.db;

  // ---- 采集健康（驱动「攒取中」）----
  fastify.get('/api/health', async () => {
    const { dates, playRange } = dataWindow(db);
    const haveDays = Q.distinctPlayDates(db);
    const latest = Q.latestSnapshot(db);
    const latestToday = Q.latestTodayListenSnapshot(db);
    const counter = Q.counterStatus(db);
    const today = nowLocalDate();
    const completeDays = counter.complete_from
      ? Math.max(0, DateTime.fromISO(today).diff(DateTime.fromISO(counter.complete_from), 'days').days + 1)
      : 0;
    const lastSuccessMs = counter.last_success_at ? Date.parse(counter.last_success_at) : NaN;
    const counterStale = !Number.isFinite(lastSuccessMs) || Date.now() - lastSuccessMs > config.realtime.intervalMs * 3;
    return {
      last_snapshot: latest?.snapshot_date ?? null,
      last_fetch_status: latest?.status ?? null,
      last_play_date: playRange.last ?? null,
      last_today_listen_at: latestToday?.fetched_at ?? null,
      snapshot_count: dates.length,
      have_days: haveDays,
      gap_dates: gapDates(dates),
      last_recent_poll_at: counter.last_success_at,
      counter_complete_from: counter.complete_from,
      counter_stale: counterStale,
      can_day: Boolean(counter.last_success_at) && !counterStale,
      can_week: completeDays >= 7,
      can_month: completeDays >= 30,
      can_year: completeDays >= 365,
    };
  });

  // ---- 概览 ----
  fastify.get('/api/overview', async (req) => {
    const { dates, first, last } = dataWindow(db);
    if (!first || !last) return insufficient(db, 1);
    const period = req.query.period || 'all';
    const anchor = req.query.date || nowLocalDate();
    const resolved = resolvePeriod(period, anchor, { firstDate: first, lastDate: anchor });
    const start = req.query.from || resolved.start;
    const end = req.query.to || resolved.end;

    const t = Q.totals(db, start, end);
    const gaps = gapDates(dates).filter((g) => g >= start && g <= end);

    const thisW = resolvePeriod('week', anchor);
    const lastWAnchor = DateTime.fromISO(thisW.start, { zone: config.tz }).minus({ days: 1 }).toISODate();
    const lastW = resolvePeriod('week', lastWAnchor);
    const tw = Q.totals(db, thisW.start, thisW.end).plays;
    const lw = Q.totals(db, lastW.start, lastW.end).plays;

    return {
      meta: { period_resolved: resolved, data_quality: dataQuality(db, start, end) },
      range: { start, end },
      totals: {
        plays: t.plays,
        est_hours: Math.round(t.est_ms / 360000) / 10, // 上限估算（约）
        distinct_songs: t.songs,
        distinct_artists: Q.countDimension(db, 'artist', start, end),
        distinct_albums: Q.countDimension(db, 'album', start, end),
        days_tracked: Q.distinctPlayDatesInRange(db, start, end),
        gap_days: gaps.length,
      },
      top: {
        song: Q.rankingSongs(db, start, end, 'plays', 1, 0)[0] || null,
        artist: Q.rankingArtists(db, start, end, 'plays', 1, 0)[0] || null,
        album: Q.rankingAlbums(db, start, end, 'plays', 1, 0)[0] || null,
      },
      this_week_vs_last: { this: tw, last: lw, delta_pct: lw ? Math.round(((tw - lw) / lw) * 1000) / 10 : null },
      freshness: freshness(db),
    };
  });

  // ---- 排行 ----
  fastify.get('/api/ranking', async (req) => {
    const { first, last } = dataWindow(db);
    if (!first || !last) return insufficient(db, 1);

    const dimension = req.query.dimension || 'song';
    const metric = req.query.metric || 'plays';
    const period = req.query.period || 'all';
    const limit = Math.min(Number(req.query.limit || 50), 500);
    const offset = Number(req.query.offset || 0);
    const anchor = req.query.date || nowLocalDate();
    const pr = resolvePeriod(period, anchor, { firstDate: first, lastDate: anchor });

    let items;
    if (dimension === 'artist') items = Q.rankingArtists(db, pr.start, pr.end, metric, limit, offset);
    else if (dimension === 'album') items = Q.rankingAlbums(db, pr.start, pr.end, metric, limit, offset);
    else items = Q.rankingSongs(db, pr.start, pr.end, metric, limit, offset);

    return {
      meta: {
        dimension,
        metric,
        period_resolved: pr,
        source: 'daily_play',
        data_quality: dataQuality(db, pr.start, pr.end),
        freshness: freshness(db),
      },
      items,
      total: Q.countDimension(db, dimension, pr.start, pr.end),
    };
  });

  // ---- 趋势时序 ----
  fastify.get('/api/trend', async (req) => {
    const { dates, first, last } = dataWindow(db);
    if (!first || !last) return insufficient(db, 1);

    const granularity = req.query.granularity || 'day';
    const metric = req.query.metric || 'plays';
    const to = req.query.to || nowLocalDate();
    let from = req.query.from;
    if (!from) {
      if (req.query.last) {
        from = DateTime.fromISO(to, { zone: config.tz })
          .minus({ [granularity]: Number(req.query.last) - 1 })
          .startOf(granularity)
          .toISODate();
      } else {
        from = first;
      }
    }

    const filter = {};
    if (req.query.song_id) filter.songId = Number(req.query.song_id);
    if (req.query.artist_id) filter.artistId = Number(req.query.artist_id);
    if (req.query.album_id) filter.albumId = Number(req.query.album_id);

    const daily = Q.dailyTotals(db, from, to, filter);
    const gaps = gapDates(dates);
    const series = buckets(granularity, from, to).map((b) => {
      const inB = daily.filter((d) => d.date >= b.start && d.date <= b.end);
      const plays = inB.reduce((a, d) => a + d.plays, 0);
      const est = inB.reduce((a, d) => a + (d.est_ms || 0), 0);
      return {
        bucket: b.bucket,
        start: b.start,
        end: b.end,
        plays,
        est_minutes: Math.round(est / 60000),
        has_gap: gaps.some((g) => g >= b.start && g <= b.end),
      };
    });

    const entity = filter.songId ? 'song' : filter.artistId ? 'artist' : filter.albumId ? 'album' : 'all';
    return {
      meta: {
        granularity,
        metric,
        entity,
        data_quality: dataQuality(db, from, to),
        freshness: freshness(db),
      },
      series,
    };
  });

  // ---- 最近 N 天每日歌曲封面行（包含今天；每首歌仅占一个封面格）----
  fastify.get('/api/daily-top-songs', async (req) => {
    const days = Math.min(Math.max(Number(req.query.days || 7), 1), 31);
    const limit = Math.min(Math.max(Number(req.query.limit || 8), 1), 64);
    const end = req.query.to || nowLocalDate();
    const start = DateTime.fromISO(end, { zone: config.tz }).minus({ days: days - 1 }).toISODate();
    const totalsByDate = new Map(Q.dailyTotals(db, start, end).map((item) => [item.date, item]));
    const songsByDate = new Map();
    for (const item of Q.dailyTopSongs(db, start, end, limit)) {
      if (!songsByDate.has(item.date)) songsByDate.set(item.date, []);
      songsByDate.get(item.date).push({
        rank: item.rank,
        plays: item.plays,
        est_minutes: item.est_minutes,
        last_play_time: item.last_play_time,
        song: item.song,
      });
    }

    const items = Array.from({ length: days }, (_, index) => {
      const date = DateTime.fromISO(end, { zone: config.tz }).minus({ days: index }).toISODate();
      const songs = songsByDate.get(date) || [];
      const quality = dataQuality(db, date, date);
      const totals = totalsByDate.get(date);
      if (songs.length) {
        return {
          date,
          missing: false,
          lower_bound: quality.lower_bound,
          plays: totals?.plays || 0,
          distinct_songs: totals?.songs || songs.length,
          songs,
        };
      }
      return {
        date,
        missing: quality.has_gap || quality.stale,
        lower_bound: quality.lower_bound,
        reason: quality.has_gap || quality.stale ? 'gap' : 'empty',
        plays: 0,
        distinct_songs: 0,
        est_minutes: 0,
        songs: [],
      };
    });

    return {
      meta: {
        range: { start, end },
        days,
        limit,
        data_quality: dataQuality(db, start, end),
        freshness: freshness(db),
      },
      items,
    };
  });

  // ---- 日历热力（GitHub 贡献图式）----
  fastify.get('/api/calendar', async (req) => {
    const dates = Q.allSnapshotDates(db);
    if (dates.length < 1) return insufficient(db, 1);

    let start;
    let end;
    if (req.query.year) {
      start = `${req.query.year}-01-01`;
      end = `${req.query.year}-12-31`;
    } else {
      start = req.query.from || dates[0];
      end = req.query.to || dates[dates.length - 1];
    }

    const daily = Q.dailyTotals(db, start, end);
    const haveSet = new Set(daily.map((d) => d.date));
    let max = 0;
    const days = daily.map((d) => {
      if (d.plays > max) max = d.plays;
      return { date: d.date, plays: d.plays, est_minutes: Math.round((d.est_ms || 0) / 60000), estimated: !!d.estimated, missing: false };
    });
    // 缺抓日（tracked 区间内、无快照、且无增量数据）
    for (const g of gapDates(dates).filter((x) => x >= start && x <= end && !haveSet.has(x))) {
      days.push({ date: g, plays: 0, est_minutes: 0, estimated: false, missing: true });
    }
    days.sort((a, b) => (a.date < b.date ? -1 : 1));

    return { meta: { year: req.query.year ? Number(req.query.year) : null, metric: req.query.metric || 'plays', max }, days };
  });

  // ---- 周几分布 ----
  fastify.get('/api/weekday', async (req) => {
    const dates = Q.allSnapshotDates(db);
    if (dates.length < 2) return insufficient(db, 1);
    const start = req.query.from || dates[0];
    const end = req.query.to || dates[dates.length - 1];

    // 排除 estimated 行：跨多日/重入的「具体哪天」不可知，计入会污染周几归属
    const daily = Q.dailyTotals(db, start, end, { excludeEstimated: true });
    const wd = Array.from({ length: 7 }, (_, i) => ({ iso_dow: i + 1, label: WEEKDAY_LABEL[i], plays: 0, est_ms: 0, day_count: 0 }));
    for (const d of daily) {
      const b = wd[isoWeekday(d.date) - 1];
      b.plays += d.plays;
      b.est_ms += d.est_ms || 0;
      b.day_count += 1;
    }
    const out = wd.map((b) => ({
      iso_dow: b.iso_dow,
      label: b.label,
      plays: b.plays,
      est_minutes: Math.round(b.est_ms / 60000),
      day_count: b.day_count,
      avg_plays: b.day_count ? Math.round((b.plays / b.day_count) * 10) / 10 : 0,
    }));
    return { meta: { range: { start, end }, excluded_estimated_plays: Q.estimatedPlaysInRange(db, start, end) }, buckets: out };
  });

  // ---- 网易云增强接口代理：近期播放 / 今日足迹 / 我的歌单 ----
  fastify.get('/api/netease/record/recent/song', async (req, reply) => {
    try {
      return await fetchRecentSongs({ limit: req.query.limit || 30 });
    } catch (err) {
      return neteaseError(reply, err);
    }
  });

  fastify.get('/api/netease/listen/data/today/song', async (_req, reply) => {
    try {
      return await fetchTodayListenSongs();
    } catch (err) {
      return neteaseError(reply, err);
    }
  });

  fastify.get('/api/netease/song/detail', async (req, reply) => {
    try {
      return await fetchSongDetails(req.query.ids || req.query.id || '');
    } catch (err) {
      return neteaseError(reply, err);
    }
  });

  // ---- 我的歌单（只读本地库；采集器每日落库，首屏不再打网易云）----
  fastify.get('/api/playlists', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    return Q.userPlaylists(db, { limit, offset });
  });

  fastify.get('/api/playlists/:id/tracks', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send({ error: 'bad_playlist_id' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    return Q.playlistTracks(db, id, { limit, offset });
  });
}
