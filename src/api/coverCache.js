import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const COVER_SIZE = 160;
const BROWSER_CACHE_SECONDS = 7 * 24 * 60 * 60;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);

function normalizeImageType(value) {
  const type = (value || '').split(';')[0].trim().toLowerCase();
  // 网易云 CDN 实际返回非标准的 image/jpg，统一成标准 MIME 后再下发。
  return type === 'image/jpg' ? 'image/jpeg' : type;
}

export class CoverCacheError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoverCacheError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isAllowedHost(hostname) {
  const value = hostname.toLowerCase();
  return value === 'music.126.net' || value.endsWith('.music.126.net');
}

export function normalizeCoverSource(value, size = COVER_SIZE) {
  let source;
  try {
    source = new URL(value);
  } catch {
    throw new CoverCacheError('invalid_cover_url', '封面地址无效');
  }
  if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || source.port) {
    throw new CoverCacheError('invalid_cover_url', '封面地址无效');
  }
  if (!isAllowedHost(source.hostname)) {
    throw new CoverCacheError('unsupported_cover_host', '只允许缓存网易云图片域名');
  }

  source.protocol = 'https:';
  source.hash = '';
  // 页面最大封面不足 60px，统一取 160px 兼顾高 DPI 与缓存复用率。
  // 丢弃上游其余查询参数，避免相同图片被任意参数制造成无限缓存副本。
  source.search = '';
  source.searchParams.set('param', `${size}y${size}`);
  return source;
}

async function fetchWithAllowedRedirects(fetchImpl, initialUrl, redirectsLeft = 3) {
  let current = initialUrl;
  for (let attempt = 0; attempt <= redirectsLeft; attempt += 1) {
    const response = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
        'user-agent': 'music-record-cover-cache/1.0',
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get('location');
    if (!location || attempt === redirectsLeft) {
      throw new CoverCacheError('cover_redirect_failed', '封面重定向无效或次数过多');
    }
    current = normalizeCoverSource(new URL(location, current).href);
  }
  throw new CoverCacheError('cover_redirect_failed', '封面重定向次数过多');
}

export function createCoverCache({
  cacheDir = config.coverCache.dir,
  ttlMs = config.coverCache.ttlMs,
  maxBytes = config.coverCache.maxBytes,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const inflight = new Map();

  async function readEntry(key) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(cacheDir, `${key}.json`), 'utf8'));
      if (!metadata.contentHash || !metadata.contentType || !metadata.cachedAt) return null;
      const body = await fs.readFile(path.join(cacheDir, `${metadata.contentHash}.body`));
      return { ...metadata, body };
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async function writeEntry(key, source, body, contentType) {
    await fs.mkdir(cacheDir, { recursive: true });
    const contentHash = sha256(body);
    const metadata = {
      source: source.href,
      contentHash,
      contentType,
      etag: `"${contentHash}"`,
      cachedAt: now(),
    };
    const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
    const bodyTemp = path.join(cacheDir, `${contentHash}.${suffix}`);
    const bodyPath = path.join(cacheDir, `${contentHash}.body`);
    const metadataTemp = path.join(cacheDir, `${key}.${suffix}`);
    const metadataPath = path.join(cacheDir, `${key}.json`);

    await fs.writeFile(bodyTemp, body);
    await fs.rename(bodyTemp, bodyPath);
    await fs.writeFile(metadataTemp, JSON.stringify(metadata));
    await fs.rename(metadataTemp, metadataPath);
    return { ...metadata, body, cacheStatus: 'MISS' };
  }

  async function fetchAndCache(key, source, stale) {
    try {
      const response = await fetchWithAllowedRedirects(fetchImpl, source);
      if (!response.ok) {
        throw new CoverCacheError('cover_fetch_failed', `网易云封面返回 HTTP ${response.status}`);
      }
      const contentType = normalizeImageType(response.headers.get('content-type'));
      if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
        throw new CoverCacheError('cover_not_image', '上游返回的不是支持的位图格式');
      }
      const declaredSize = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        throw new CoverCacheError('cover_too_large', '封面文件过大');
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (!body.length || body.length > maxBytes) {
        throw new CoverCacheError('cover_too_large', '封面为空或文件过大');
      }
      return writeEntry(key, source, body, contentType);
    } catch (error) {
      // 过期缓存刷新失败时继续提供旧图，短暂网络抖动不会让页面封面消失。
      if (stale) return { ...stale, cacheStatus: 'STALE' };
      throw error;
    }
  }

  async function get(value) {
    const source = normalizeCoverSource(value);
    const key = sha256(source.href);
    const existing = await readEntry(key);
    if (existing && now() - existing.cachedAt < ttlMs) {
      return { ...existing, cacheStatus: 'HIT' };
    }

    if (!inflight.has(key)) {
      const request = fetchAndCache(key, source, existing).finally(() => inflight.delete(key));
      inflight.set(key, request);
    }
    return inflight.get(key);
  }

  return { get };
}

const defaultCache = createCoverCache();

export async function getCachedCover(value) {
  return defaultCache.get(value);
}

export const coverBrowserCacheControl = `public, max-age=${BROWSER_CACHE_SECONDS}, stale-while-revalidate=${BROWSER_CACHE_SECONDS * 4}`;
