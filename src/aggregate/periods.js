// 全项目唯一的日期/时区/ISO 周逻辑（DRY）。SQL 只接收这里算好的日期串。
import { DateTime } from 'luxon';
import { config } from '../config.js';

const TZ = config.tz;

export function nowLocalDate() {
  return DateTime.now().setZone(TZ).toISODate();
}

export function previousDay(isoDate) {
  return DateTime.fromISO(isoDate, { zone: TZ }).minus({ days: 1 }).toISODate();
}

// 'YYYY-MM-DD' 减 n 天。
export function isoMinusDays(isoDate, n) {
  return DateTime.fromISO(isoDate, { zone: TZ }).minus({ days: n }).toISODate();
}

// 两个 'YYYY-MM-DD' 的天数差（a - b），用 UTC 避免 DST 干扰
export function dayDiff(a, b) {
  const da = DateTime.fromISO(a, { zone: 'utc' });
  const db = DateTime.fromISO(b, { zone: 'utc' });
  return Math.round(da.diff(db, 'days').days);
}

// 1=Mon .. 7=Sun
export function isoWeekday(isoDate) {
  return DateTime.fromISO(isoDate, { zone: TZ }).weekday;
}

// period + 锚点日期 → { period, start, end, label }
// 日/周/月/年统一为以 anchor 为结尾的滚动 1/7/30/365 天。
export function resolvePeriod(period, anchor, { firstDate, lastDate } = {}) {
  const d = anchor ? DateTime.fromISO(anchor, { zone: TZ }) : DateTime.now().setZone(TZ);
  if (!d.isValid) throw new Error(`非法日期: ${anchor}`);
  switch (period) {
    case 'day':
      return { period, start: d.toISODate(), end: d.toISODate(), label: d.toISODate() };
    case 'week':
      return rollingPeriod(period, d, 7);
    case 'month':
      return rollingPeriod(period, d, 30);
    case 'year':
      return rollingPeriod(period, d, 365);
    case 'all':
      return {
        period,
        start: firstDate || '0000-01-01',
        end: lastDate || '9999-12-31',
        label: 'all',
      };
    default:
      throw new Error(`未知 period: ${period}`);
  }
}

function rollingPeriod(period, end, days) {
  const start = end.minus({ days: days - 1 });
  return {
    period,
    start: start.toISODate(),
    end: end.toISODate(),
    label: `${start.toISODate()}..${end.toISODate()}`,
  };
}

// 把 [from,to] 按 granularity 切成桶 [{ bucket, start, end }]
export function buckets(granularity, from, to) {
  const unit = { day: 'day', week: 'week', month: 'month', year: 'year' }[granularity];
  if (!unit) throw new Error(`未知 granularity: ${granularity}`);
  let cur = DateTime.fromISO(from, { zone: TZ }).startOf(unit);
  const end = DateTime.fromISO(to, { zone: TZ }).endOf(unit);
  const out = [];
  while (cur <= end) {
    out.push({
      bucket: bucketLabel(granularity, cur),
      start: cur.startOf(unit).toISODate(),
      end: cur.endOf(unit).toISODate(),
    });
    cur = cur.plus({ [unit]: 1 });
  }
  return out;
}

function bucketLabel(granularity, dt) {
  switch (granularity) {
    case 'day':
      return dt.toISODate();
    case 'week':
      return `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, '0')}`;
    case 'month':
      return dt.toFormat('yyyy-LL');
    case 'year':
      return dt.toFormat('yyyy');
  }
}

// 给定升序的快照日期数组，求 [first,last] 区间内缺失的日期（gap）
export function gapDates(snapshotDates) {
  if (snapshotDates.length < 2) return [];
  const set = new Set(snapshotDates);
  const first = DateTime.fromISO(snapshotDates[0], { zone: TZ });
  const last = DateTime.fromISO(snapshotDates[snapshotDates.length - 1], { zone: TZ });
  const gaps = [];
  for (let c = first; c <= last; c = c.plus({ days: 1 })) {
    const iso = c.toISODate();
    if (!set.has(iso)) gaps.push(iso);
  }
  return gaps;
}
