/**
 * Injectable Vercel Blob seam. `lib/cache.ts` builds the real adapter (it
 * is server-only); these helpers take any store, so unit tests can use an
 * in-memory fake that enforces Blob's real contract (put on an existing
 * key throws unless allowOverwrite is true).
 */
import { isStorageUnavailable } from "./storage.ts";

export interface BlobEntry {
  url: string;
  pathname: string;
  uploadedAt: string | Date;
}

export interface PutBlobOpts {
  allowOverwrite?: boolean;
  cacheControlMaxAge?: number;
}

export interface BlobStore {
  listBlobs(prefix: string): Promise<BlobEntry[]>;
  /** Exact-pathname metadata read (cheaper than list for cache lookups). */
  headBlob(pathname: string): Promise<BlobEntry | null>;
  putBlob(
    pathname: string,
    body: string | Buffer,
    contentType: string,
    opts?: PutBlobOpts,
  ): Promise<string>;
  delBlobs(pathnames: string[]): Promise<void>;
  /**
   * JSON GET. Returns null on 404; logs status+path, retries once, and
   * throws StorageUnavailableError when storage itself fails (403/5xx).
   */
  fetchJson<T>(url: string): Promise<T | null>;
}

/** Cumulative per-instance Blob op counts; routes log them per request. */
export const blobOpCounts = { list: 0, head: 0, get: 0, put: 0, del: 0 };

export function blobUsageLine(): string {
  return (
    `blob_list=${blobOpCounts.list} blob_head=${blobOpCounts.head} ` +
    `blob_get=${blobOpCounts.get} blob_put=${blobOpCounts.put} blob_del=${blobOpCounts.del}`
  );
}

/** One log line per request: route name + cumulative op counts. */
export function logBlobUsage(route: string): void {
  console.log(`blob_usage route=${route} ${blobUsageLine()}`);
}

/** Short CDN cache so overwritten JSON (pointers, caches) refreshes fast. */
export const BLOB_CACHE_MAX_AGE = 60;

/** Strict JSON write: throws on failure. Overwrites existing keys. */
export async function writeJsonToStore(
  store: BlobStore,
  path: string,
  data: unknown,
): Promise<string> {
  return store.putBlob(path, JSON.stringify(data), "application/json", {
    allowOverwrite: true,
    cacheControlMaxAge: BLOB_CACHE_MAX_AGE,
  });
}

export interface CacheRead<T> {
  hit: boolean;
  data?: T;
}

/**
 * Strict JSON read by exact pathname: miss on stale, missing or bad data.
 * Storage outages propagate (the caller maps them to a 503), never a miss.
 */
export async function readJsonFromStore<T>(
  store: BlobStore,
  path: string,
  ttlMs: number,
): Promise<CacheRead<T>> {
  try {
    const blob = await store.headBlob(path);
    if (!blob) return { hit: false };
    if (Date.now() - new Date(blob.uploadedAt).getTime() > ttlMs) return { hit: false };
    const data = await store.fetchJson<T>(blob.url);
    if (data === null || data === undefined) return { hit: false };
    return { hit: true, data };
  } catch (err) {
    if (isStorageUnavailable(err)) throw err;
    return { hit: false };
  }
}
