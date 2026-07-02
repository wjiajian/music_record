// 抓取一次快照（allData + weekData）、落库、算 allData 增量。整体单事务、幂等。
import { fetchUserRecord } from '../netease/client.js';
import { upsertDimensions, saveSnapshot, saveWeekSnapshot } from './persist.js';
import { computeDailyIncrements } from './diff.js';
import { tx } from '../db/index.js';
import { nowLocalDate } from '../aggregate/periods.js';
import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchSnapshot(
  db,
  { uid = config.uid, snapDate = nowLocalDate(), attribution = config.attribution } = {}
) {
  // 先抓 allData（必须成功），再抓 weekData（最近 7 天滚动，仅作原始留存/审计）
  const all = await fetchUserRecord(uid, 0);
  await sleep(1500); // 两次调用间稍隔开，温和对待接口
  let week = null;
  try {
    week = await fetchUserRecord(uid, 1);
  } catch (e) {
    // 本周可能无播放或临时失败——尽力而为，不阻断 allData 采集
    console.warn('[collect] weekData 抓取失败（跳过，不影响 allData）：', e?.message || e);
  }

  const fetchedAt = new Date().toISOString();
  const rawJson = JSON.stringify(all.allData);
  const weekItems = week?.items?.length ? week.items : [];

  // 校验通过后再开事务，杜绝半成品快照
  return tx(db, () => {
    upsertDimensions(db, snapDate, all.items);
    if (weekItems.length) upsertDimensions(db, snapDate, weekItems); // weekData-only 歌也要入维度表，便于审计
    saveSnapshot(db, snapDate, fetchedAt, all.items, rawJson);
    if (weekItems.length) saveWeekSnapshot(db, snapDate, weekItems);
    const diff = computeDailyIncrements(db, snapDate, { attribution });
    return { snapDate, fetchedAt, itemCount: all.items.length, weekCount: weekItems.length, diff };
  });
}
