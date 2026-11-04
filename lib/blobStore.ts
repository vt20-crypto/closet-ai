/**
 * Injectable Vercel Blob seam. `lib/cache.ts` builds the real adapter (it
 * is server-only); these helpers take any store, so unit tests can use an
 * in-memory fake that enforces Blob's real contract (put on an existing
 * key throws unless allowOverwrite is true).
 */

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
  putBlob(
    pathname: string,
    body: string | Buffer,
    contentType: string,
    opts?: PutBlobOpts,
  ): Promise<string>;
  delBlobs(pathnames: string[]): Promise<void>;
  fetchJson<T>(url: string): Promise<T | null>;
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

/** Strict JSON read by exact pathname: miss on stale, missing or bad data. */
export async function readJsonFromStore<T>(
  store: BlobStore,
  path: string,
  ttlMs: number,
): Promise<CacheRead<T>> {
  try {
    const entries = await store.listBlobs(path);
    const blob = entries.find((entry) => entry.pathname === path);
    if (!blob) return { hit: false };
    if (Date.now() - new Date(blob.uploadedAt).getTime() > ttlMs) return { hit: false };
    const data = await store.fetchJson<T>(blob.url);
    if (data === null || data === undefined) return { hit: false };
    return { hit: true, data };
  } catch {
    return { hit: false };
  }
}
