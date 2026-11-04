import "server-only";

import { del, head, list, put } from "@vercel/blob";

import {
  blobOpCounts,
  readJsonFromStore,
  writeJsonToStore,
  type BlobEntry,
  type BlobStore,
} from "./blobStore.ts";
import { StorageUnavailableError } from "./storage.ts";

/**
 * Tiny JSON cache on Vercel Blob (small values only: dress notes, outfit
 * responses). Reads check the blob's uploadedAt against the TTL; stale or
 * missing entries are a miss. Keys are caller-built `type/hash` paths.
 * Writes overwrite (the old put threw on existing keys and the catch hid
 * it, so redoing an avatar never updated its pointer).
 */

export { hashKey } from "./hash.ts";

function blobPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.slice(-80);
  }
}

/** The production Vercel Blob adapter for pointer/cache helpers. */
export function getBlobStore(): BlobStore {
  return {
    async listBlobs(prefix: string) {
      blobOpCounts.list += 1;
      try {
        const page = await list({ prefix, limit: 1000 });
        return page.blobs.map((blob) => ({
          url: blob.url,
          pathname: blob.pathname,
          uploadedAt: blob.uploadedAt,
        }));
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? 0;
        console.log(`blob_list status=${status || "network-fail"} prefix=${prefix}`);
        throw new StorageUnavailableError(status, `prefix:${prefix}`);
      }
    },
    async headBlob(pathname: string): Promise<BlobEntry | null> {
      blobOpCounts.head += 1;
      try {
        const blob = await head(pathname);
        return { url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt };
      } catch {
        return null;
      }
    },
    async putBlob(pathname, body, contentType, opts) {
      blobOpCounts.put += 1;
      const uploaded = await put(pathname, body, {
        access: "public",
        contentType,
        addRandomSuffix: false,
        allowOverwrite: opts?.allowOverwrite,
        cacheControlMaxAge: opts?.cacheControlMaxAge,
      });
      return uploaded.url;
    },
    async delBlobs(pathnames: string[]) {
      blobOpCounts.del += 1;
      await del(pathnames);
    },
    async fetchJson<T>(url: string) {
      const path = blobPath(url);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        blobOpCounts.get += 1;
        let res: Response | null = null;
        try {
          res = await fetch(url, { cache: "no-store" });
        } catch {
          res = null;
        }
        if (res?.ok) {
          try {
            return (await res.json()) as T;
          } catch {
            return null;
          }
        }
        const status = res?.status ?? 0;
        if (status === 404) return null;
        console.log(`blob_get status=${status || "network-fail"} path=${path} attempt=${attempt}`);
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        } else {
          throw new StorageUnavailableError(status, path);
        }
      }
      return null;
    },
  };
}

export async function readCache<T>(path: string, ttlMs: number): Promise<{ hit: boolean; data?: T }> {
  return readJsonFromStore<T>(getBlobStore(), `cache/${path}.json`, ttlMs);
}

export async function writeCache(path: string, data: unknown): Promise<void> {
  try {
    const full = `cache/${path}.json`;
    const store = getBlobStore();
    // Don't rewrite an unchanged entry (put is an expensive advanced op).
    try {
      const existing = await store.headBlob(full);
      if (existing) {
        const current = await store.fetchJson<unknown>(existing.url);
        if (JSON.stringify(current) === JSON.stringify(data)) return;
      }
    } catch {
      // Fall through to the write.
    }
    await writeJsonToStore(store, full, data);
  } catch {
    // Cache writes are best-effort; the request already has its answer.
  }
}
