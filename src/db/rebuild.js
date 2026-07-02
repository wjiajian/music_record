// 维护命令：从 snapshot/snapshot_item 全量重建 daily_play（差分逻辑变更后用）。
import { getDb, initSchema, tx } from './index.js';
import { computeDailyIncrements } from '../collector/diff.js';
import { applyRecentPlayEvents } from '../collector/persist.js';
import { config } from '../config.js';
import { allSnapshotDates } from '../aggregate/queries.js';

function main() {
  const db = initSchema(getDb());
  const dates = allSnapshotDates(db);
  tx(db, () => {
    db.exec('DELETE FROM daily_play');
    let written = 0;
    for (const d of dates) {
      const s = computeDailyIncrements(db, d, { attribution: config.attribution });
      written += s.written;
    }
    const recent = applyRecentPlayEvents(db);
    console.log(
      `[rebuild] 重放 ${dates.length} 张快照，写入 allData 增量 ${written} 行；` +
        `重放最近播放事件 ${recent.replaced}/${recent.dates} 天，写入 ${recent.written} 行`
    );
  });
}

main();
