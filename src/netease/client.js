// 网易云取数：封装本项目用到的只读接口。
import crypto from 'node:crypto';
import { eapi, weapi } from './crypto.js';
import { config } from '../config.js';

const WEB_DOMAIN = 'https://music.163.com';
const API_DOMAIN = 'https://interface.music.163.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA =
  'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 组装 Cookie 头：始终带 os=pc；若设了 NETEASE_COOKIE（你的 MUSIC_U）则拼上。
// 实测：无登录 cookie 时网易云只返回排行顺序、playCount 全为 0，且很快被限流成空响应。
function cookieHeader() {
  const extra = process.env.NETEASE_COOKIE;
  if (!extra) return 'os=pc';
  return /(^|;\s*)os=/.test(extra) ? extra : `os=pc; ${extra}`;
}

function parseCookieHeader(raw = cookieHeader()) {
  return Object.fromEntries(
    raw
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const i = part.indexOf('=');
        if (i === -1) return [decodeURIComponent(part), ''];
        return [decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1))];
      })
  );
}

function compactObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function eapiHeaderCookie(header) {
  return Object.entries(header)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('; ');
}

function buildEapiHeader() {
  const cookie = parseCookieHeader();
  return compactObject({
    osver: cookie.osver || 'iOS 16.2',
    deviceId: cookie.deviceId || crypto.randomBytes(16).toString('hex'),
    os: cookie.os || 'iPhone OS',
    appver: cookie.appver || '9.0.90',
    versioncode: cookie.versioncode || '140',
    mobilename: cookie.mobilename || '',
    buildver: cookie.buildver || String(Math.floor(Date.now() / 1000)),
    resolution: cookie.resolution || '1920x1080',
    __csrf: cookie.__csrf || '',
    channel: cookie.channel || 'distribution',
    requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`,
    MUSIC_U: cookie.MUSIC_U,
    MUSIC_A: cookie.MUSIC_A,
  });
}

function weapiUrl(uri) {
  return WEB_DOMAIN + '/weapi/' + uri.replace(/^\/api\//, '');
}

function eapiUrl(uri) {
  return API_DOMAIN + '/eapi/' + uri.replace(/^\/api\//, '');
}

async function postForm(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.code != null && Number(json.code) !== 200) {
    throw new Error(`网易云返回 code=${json.code}${json.message || json.msg ? ' ' + (json.message || json.msg) : ''}`);
  }
  return json;
}

async function requestWeapi(uri, data) {
  const enc = weapi(data);
  return postForm(weapiUrl(uri), enc, {
    'User-Agent': UA,
    Referer: WEB_DOMAIN + '/',
    Cookie: cookieHeader(),
  });
}

async function requestEapi(uri, data = {}) {
  const header = buildEapiHeader();
  const payload = { ...data, header };
  const enc = eapi(uri, payload);
  return postForm(eapiUrl(uri), enc, {
    'User-Agent': MOBILE_UA,
    Cookie: eapiHeaderCookie(header),
  });
}

// 调用一次接口。type: 0=allData(累计) | 1=weekData(最近一周)
async function callRecord(uid, type) {
  return requestWeapi('/api/v1/play/record', { uid: String(uid), type, limit: 1000, offset: 0, total: true });
}

function normalizeArtists(arr = []) {
  return arr
    .map((a) => ({ id: a?.id ?? a?.artistId ?? null, name: a?.name ?? a?.artistName ?? '' }))
    .filter((a) => a.id != null || a.name);
}

export function normalizeSong(raw = {}) {
  const s = raw.song || raw.songData || raw.resourceExtInfo?.songData || raw.resourceExtInfo?.song || raw;
  const album = s.al || s.album || s.albumData || raw.album || null;
  const artists = s.ar || s.artists || s.artist || raw.artists || [];
  return {
    id: s.id ?? s.songId ?? raw.songId ?? raw.resourceId ?? null,
    name: s.name ?? s.songName ?? raw.songName ?? raw.name ?? '',
    durationMs: s.dt ?? s.duration ?? s.durationMs ?? raw.duration ?? raw.durationMs ?? null,
    picUrl: s.picUrl ?? raw.picUrl ?? null,
    album: album
      ? {
          id: album.id ?? album.albumId ?? null,
          name: album.name ?? album.albumName ?? '',
          picUrl: album.picUrl ?? album.coverUrl ?? album.pic ?? album.blurPicUrl ?? null,
        }
      : null,
    artists: Array.isArray(artists) ? normalizeArtists(artists) : normalizeArtists([artists]),
    raw: s,
  };
}

// 把原始记录项规整成内部结构
function normalizeItems(arr = []) {
  return arr.map((it, idx) => {
    const s = normalizeSong(it.song || it);
    return {
      playCount: it.playCount,
      score: it.score,
      rank: idx + 1,
      song: s,
    };
  });
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

function normalizeRecentSongItems(json) {
  const arr = firstArray(json.data?.list, json.data?.items, json.list, json.items, json.songs);
  return arr.map((it, idx) => ({
    rank: idx + 1,
    playTime: it.playTime ?? it.time ?? it.listenTime ?? it.resourceExtInfo?.playTime ?? null,
    playCount: it.playCount ?? it.count ?? null,
    sourceType: it.resourceType ?? it.type ?? null,
    song: normalizeSong(it.song || it.data?.song || it.data || it.resourceExtInfo?.songData || it.resourceExtInfo?.song || it),
  }));
}

function normalizeTodayListenItems(json) {
  const arr = firstArray(
    json.data?.list,
    json.data?.songPlayRank,
    json.data?.songRank,
    json.data?.rank,
    json.data?.songs,
    json.data?.songDTOs,
    json.list,
    json.items
  );
  return arr.map((it, idx) => ({
    rank: it.rank ?? idx + 1,
    playCount: it.playCount ?? it.count ?? it.playCnt ?? it.score ?? null,
    listenTime: it.listenTime ?? it.playTime ?? it.lastPlayTime ?? null,
    song: normalizeSong(it.song || it.songInfo || it),
  }));
}

function normalizePlaylist(item) {
  return {
    id: item.id,
    name: item.name,
    coverImgUrl: item.coverImgUrl ?? item.coverUrl ?? null,
    trackCount: item.trackCount ?? item.trackIds?.length ?? 0,
    playCount: item.playCount ?? 0,
    subscribed: Boolean(item.subscribed),
    privacy: item.privacy ?? 0,
    updateTime: item.updateTime ?? null,
    creator: item.creator ? { id: item.creator.userId, name: item.creator.nickname } : null,
  };
}

// 带校验与指数退避重试地抓取记录（默认 allData）
export async function fetchUserRecord(
  uid = config.uid,
  type = 0,
  { retries = [30000, 120000, 600000] } = {}
) {
  let lastErr;
  for (let attempt = 0; attempt <= retries.length; attempt++) {
    try {
      const json = await callRecord(uid, type);
      const allData = normalizeItems(json.allData);
      const weekData = normalizeItems(json.weekData);
      const items = type === 1 ? weekData : allData;
      // 校验：空数据或缺关键字段视为失败，触发重试
      if (!items.length) throw new Error('返回空数据（排行未公开？）');
      if (items[0].song.durationMs == null) throw new Error('song 缺少 dt 字段，结构异常');
      return { type, items, allData, weekData, raw: json };
    } catch (e) {
      lastErr = e;
      if (attempt < retries.length) await sleep(retries[attempt]);
    }
  }
  throw lastErr;
}

// 探针专用低层通道：无退避、不抛错、保留响应头与双时间戳。把异常/非 200 当数据
// 如实返回，由探针落库——避免生产重试把记录时刻推后数十秒污染延迟测量。
export async function fetchUserRecordRaw(uid = config.uid, type = 0) {
  const enc = weapi({ uid: String(uid), type, limit: 1000, offset: 0, total: true });
  const form = new URLSearchParams({ params: enc.params, encSecKey: enc.encSecKey });
  const reqSentAt = new Date().toISOString();
  const t0 = Date.now();
  let res = null;
  let json = null;
  let err = null;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Referer: 'https://music.163.com/',
        Cookie: cookieHeader(),
      },
      body: form.toString(),
    });
    json = await res.json();
  } catch (e) {
    err = String(e?.message || e);
  }
  const respRecvAt = new Date().toISOString();
  const headers = res
    ? {
        date: res.headers.get('date'),
        age: res.headers.get('age'),
        xCache: res.headers.get('x-cache') || res.headers.get('x-cache-lookup') || null,
        server: res.headers.get('server'),
      }
    : {};
  const allData = json ? normalizeItems(json.allData) : [];
  const weekData = json ? normalizeItems(json.weekData) : [];
  return {
    httpStatus: res?.status ?? null,
    code: json?.code ?? null,
    reqSentAt,
    respRecvAt,
    rttMs: Date.now() - t0,
    headers,
    items: type === 1 ? weekData : allData,
    allData,
    weekData,
    raw: json, // 原始响应，便于调试
    err,
  };
}

export async function fetchRecentSongs({ limit = 30, includeRaw = false } = {}) {
  const json = await requestWeapi('/api/play-record/song/list', { limit: Math.min(Number(limit) || 30, 100) });
  const items = normalizeRecentSongItems(json).filter((item) => item.song.id != null);
  const out = { source: 'record_recent_song', total: items.length, items, rawCode: json.code ?? null };
  if (includeRaw) out.raw = json;
  return out;
}

export async function fetchTodayListenSongs({ includeRaw = false } = {}) {
  const json = await requestEapi('/api/content/activity/listen/data/today/song/play/rank', {});
  const items = normalizeTodayListenItems(json).filter((item) => item.song.id != null);
  const out = { source: 'listen_data_today_song', total: items.length, items, rawCode: json.code ?? null };
  if (includeRaw) out.raw = json;
  return out;
}

export async function fetchSongDetails(ids) {
  const uniqueIds = [...new Set(String(ids || '').split(/\s*,\s*/).filter(Boolean))].slice(0, 1000);
  if (!uniqueIds.length) return { source: 'song_detail', total: 0, items: [] };
  const json = await requestWeapi('/api/v3/song/detail', {
    c: '[' + uniqueIds.map((id) => '{"id":' + Number(id) + '}').join(',') + ']',
  });
  const songs = firstArray(json.songs, json.data?.songs).map((song) => normalizeSong(song)).filter((song) => song.id != null);
  return { source: 'song_detail', total: songs.length, items: songs, rawCode: json.code ?? null };
}

export async function fetchUserPlaylists(uid = config.uid, { limit = 30, offset = 0 } = {}) {
  const json = await requestWeapi('/api/user/playlist', {
    uid: String(uid),
    limit: Math.min(Number(limit) || 30, 100),
    offset: Math.max(Number(offset) || 0, 0),
    includeVideo: true,
  });
  const items = firstArray(json.playlist, json.data?.playlist).map(normalizePlaylist);
  return {
    source: 'user_playlist',
    total: json.more ? null : items.length,
    more: Boolean(json.more),
    items,
    rawCode: json.code ?? null,
  };
}

export async function fetchPlaylistTracks(id, { limit = 100, offset = 0, s = 8 } = {}) {
  if (!id) throw new Error('缺少歌单 id');
  const detail = await requestWeapi('/api/v6/playlist/detail', {
    id: String(id),
    n: 100000,
    s,
  });
  const playlist = detail.playlist ? normalizePlaylist(detail.playlist) : { id: Number(id), name: '', trackCount: 0 };
  const trackIds = firstArray(detail.playlist?.trackIds).map((item) => item.id).filter((songId) => songId != null);
  const start = Math.max(Number(offset) || 0, 0);
  const count = Math.min(Number(limit) || 100, 500);
  const ids = trackIds.slice(start, start + count);
  const songs = ids.length ? (await fetchSongDetails(ids.join(','))).items : [];
  return {
    source: 'playlist_track_all',
    playlist,
    offset: start,
    limit: count,
    total: trackIds.length,
    items: songs,
  };
}
