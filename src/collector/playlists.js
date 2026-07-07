// 我的歌单采集：抓「歌单列表 + 每单全部曲目」→ 复用 upsertDimensions 落歌曲维度
// → 单事务全量替换 playlist / playlist_track。歌单是「当前状态镜像」，非累计/非审计源，
// 故每次采集清空重插，天然收敛手机端的删歌单/移歌/取消收藏（无幽灵行）。
import { tx } from '../db/index.js';
import { fetchUserPlaylists, fetchPlaylistTracks } from '../netease/client.js';
import { upsertDimensions } from './persist.js';
import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function failResult(error, extra = {}) {
  return { status: 'fail', message: error?.message || String(error), ...extra };
}

// 分页抓完某歌单的全部曲目。以每页有序 trackIds 为脊柱、song detail 左连赋 position，
// detail 缺歌（失效歌）自动跳过（不能给不存在的 song_id 建 playlist_track FK）。
async function fetchAllTracks(fetchPlaylistTracksFn, id, { pageSize = 500, gapMs = 400 } = {}) {
  const tracks = [];
  let offset = 0;
  let total = 0;
  do {
    const page = await fetchPlaylistTracksFn(id, { limit: pageSize, offset });
    total = page.total ?? 0;
    const pageIds = page.trackIds || [];
    const songById = new Map((page.items || []).map((song) => [song.id, song]));
    pageIds.forEach((songId, j) => {
      const song = songById.get(songId);
      if (song) tracks.push({ position: (page.offset ?? offset) + j, songId, song });
    });
    if (!pageIds.length) break; // 防御：意外空页，避免死循环
    offset = (page.offset ?? offset) + pageIds.length;
    if (gapMs) await sleep(gapMs);
  } while (offset < total);
  return tracks;
}

// 采集全部歌单。fetchers 可注入（单测）。串行 + gapMs 间隔，避免采集时自我限流。
export async function collectPlaylists(
  db,
  {
    uid = config.uid,
    collectedAt = new Date().toISOString(),
    fetchers = { fetchUserPlaylists, fetchPlaylistTracks },
    gapMs = 400,
    pageSize = 500,
  } = {}
) {
  // ── 阶段 A：分页抓歌单列表（失败直接返回，绝不碰 DB）──
  let playlists;
  try {
    playlists = [];
    let offset = 0;
    let more = true;
    while (more) {
      const page = await fetchers.fetchUserPlaylists(uid, { limit: 100, offset });
      const items = page.items || [];
      for (const meta of items) playlists.push({ meta, listPosition: playlists.length, tracks: [] });
      more = Boolean(page.more) && items.length > 0;
      offset += items.length;
      if (more && gapMs) await sleep(gapMs);
    }
  } catch (error) {
    return failResult(error, { stage: 'list' });
  }

  // ── 阶段 B：逐单分页抓全部曲目（fail-closed：任一单失败即放弃整次替换）──
  const failedPlaylists = [];
  for (const p of playlists) {
    if (!p.meta.trackCount) continue; // 空歌单不打网络，仍会落一行 playlist
    if (gapMs) await sleep(gapMs);
    try {
      p.tracks = await fetchAllTracks(fetchers.fetchPlaylistTracks, p.meta.id, { pageSize, gapMs });
    } catch (error) {
      failedPlaylists.push({ id: p.meta.id, name: p.meta.name, message: error?.message || String(error) });
      break; // 已知不会写库，提前止损，不再继续 hammer 网易云
    }
  }
  if (failedPlaylists.length) {
    return { status: 'partial', message: '部分歌单曲目抓取失败，已放弃本次全量替换', failedPlaylists, collectedAt };
  }

  // ── 阶段 C：单事务全量替换（同步、无 await；WAL 下只读端不会撞见空窗）──
  return tx(db, () => {
    // 先落歌曲维度（满足 playlist_track.song_id → song(id) 外键）
    for (const p of playlists) {
      if (p.tracks.length) upsertDimensions(db, collectedAt, p.tracks.map((t) => ({ song: t.song })));
    }
    db.exec('DELETE FROM playlist_track'); // 子表先删
    db.exec('DELETE FROM playlist'); // 父表后删

    const insPlaylist = db.prepare(
      `INSERT INTO playlist(id,name,cover_img_url,track_count,play_count,subscribed,
         privacy,update_time,creator_id,creator_name,list_position,collected_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const insTrack = db.prepare(
      'INSERT INTO playlist_track(playlist_id,song_id,position) VALUES(?,?,?)'
    );

    let trackRows = 0;
    for (const p of playlists) {
      const m = p.meta;
      insPlaylist.run(
        m.id,
        m.name ?? null,
        m.coverImgUrl ?? null,
        m.trackCount ?? 0,
        m.playCount ?? 0,
        m.subscribed ? 1 : 0,
        m.privacy ?? 0,
        m.updateTime ?? null,
        m.creator?.id ?? null,
        m.creator?.name ?? null,
        p.listPosition,
        collectedAt
      );
      for (const t of p.tracks) {
        insTrack.run(m.id, t.songId, t.position);
        trackRows++;
      }
    }
    return { status: 'ok', playlistCount: playlists.length, trackRows, collectedAt };
  });
}
