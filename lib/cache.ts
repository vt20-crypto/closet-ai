import "server-only";

import { del, list, put } from "@vercel/blob";

import {
  readJsonFromStore,
  writeJsonToStore,
  type BlobStore,
} from "./blobStore.ts";

/**
 * Tiny JSON cache on Vercel Blob (small values only: dress notes, outfit
 * responses). Reads check the blob's uploadedAt against the TTL; stale or
 * missing entries are a miss. Keys are caller-built `type/hash` paths.
 * Writes overwrite (the old put threw on existing keys and the catch hid
 * it, so redoing an avatar never updated its pointer).
 */

export { hashKey } from "./hash.ts";

/** The production Vercel Blob adapter for pointer/cache helpers. */
export function getBlobStore(): BlobStore {
  return {
    async listBlobs(prefix: string) {
      const page = await list({ prefix, limit: 1000 });
      return page.blobs.map((blob) => ({
        url: blob.url,
        pathname: blob.pathname,
        uploadedAt: blob.uploadedAt,
      }));
    },
    async putBlob(pathname, body, contentType, opts) {
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
      await del(pathnames);
    },
    async fetchJson<T>(url: string) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return null;
        return (await res.json()) as T;
      } catch {
        return null;
      }
    },
  };
}

export async function readCache<T>(path: string, ttlMs: number): Promise<{ hit: boolean; data?: T }> {
  return readJsonFromStore<T>(getBlobStore(), `cache/${path}.json`, ttlMs);
}

export async function writeCache(path: string, data: unknown): Promise<void> {
  try {
    await writeJsonToStore(getBlobStore(), `cache/${path}.json`, data);
  } catch {
    // Cache writes are best-effort; the request already has its answer.
  }
}
