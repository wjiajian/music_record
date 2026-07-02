// 实时接口采集：最近播放事件写入 daily_play，今日足迹作为辅助原始列表留存。
import { nowLocalDate } from '../aggregate/periods.js';
import { tx } from '../db/index.js';
import { fetchRecentSongs, fetchTodayListenSongs } from '../netease/client.js';
import {
  replaceDailyPlayWithRecentEvents,
  saveRecentPlaySnapshot,
  saveTodayListenSnapshot,
  upsertDimensions,
} from './persist.js';

function rawString(payload) {
  return JSON.stringify(payload.raw ?? payload.items ?? []);
}

function failResult(error) {
  return { status: 'fail', message: error?.message || String(error) };
}

export async function collectTodayListen(
  db,
  { listenDate = nowLocalDate(), fetcher = fetchTodayListenSongs } = {}
) {
  const payload = await fetcher({ includeRaw: true });
  const fetchedAt = new Date().toISOString();
  const items = payload.items || [];
  return tx(db, () => {
    upsertDimensions(db, listenDate, items);
    const snapshotId = saveTodayListenSnapshot(db, listenDate, fetchedAt, items, rawString(payload), {
      rawCode: payload.rawCode ?? null,
    });
    return {
      status: 'ok',
      source: payload.source,
      listenDate,
      fetchedAt,
      snapshotId,
      itemCount: items.length,
    };
  });
}

export async function collectRecentPlay(
  db,
  { seenDate = nowLocalDate(), limit = 100, fetcher = fetchRecentSongs } = {}
) {
  const payload = await fetcher({ limit, includeRaw: true });
  const fetchedAt = new Date().toISOString();
  const items = payload.items || [];
  return tx(db, () => {
    upsertDimensions(db, seenDate, items);
    const snapshotId = saveRecentPlaySnapshot(db, fetchedAt, items, rawString(payload), {
      rawCode: payload.rawCode ?? null,
    });
    const daily = replaceDailyPlayWithRecentEvents(db, seenDate);
    return {
      status: 'ok',
      source: payload.source,
      fetchedAt,
      snapshotId,
      itemCount: items.length,
      daily,
    };
  });
}

export async function collectRealtimePlayback(
  db,
  { collectToday = true, collectRecent = true, listenDate = nowLocalDate(), recentLimit = 100 } = {}
) {
  const result = {};
  if (collectToday) {
    try {
      result.today = await collectTodayListen(db, { listenDate });
    } catch (error) {
      result.today = failResult(error);
    }
  }
  if (collectRecent) {
    try {
      result.recent = await collectRecentPlay(db, { seenDate: listenDate, limit: recentLimit });
    } catch (error) {
      result.recent = failResult(error);
    }
  }

  const parts = [result.today, result.recent].filter(Boolean);
  const failures = parts.filter((part) => part.status === 'fail');
  result.status = failures.length ? (failures.length === parts.length ? 'fail' : 'partial') : 'ok';
  return result;
}
