import "server-only";

import { list, put } from "@vercel/blob";

/**
 * Tiny JSON cache on Vercel Blob (small values only: dress notes, outfit
 * responses). Reads check the blob's uploadedAt against the TTL; stale or
 * missing entries are a miss. Keys are caller-built `type/hash` paths.
 */

export function hashKey(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function readCache<T>(path: string, ttlMs: number): Promise<{ hit: boolean; data?: T }> {
  try {
    const page = await list({ prefix: `cache/${path}.json`, limit: 1 });
    const blob = page.blobs[0];
    if (!blob) return { hit: false };
    if (Date.now() - new Date(blob.uploadedAt).getTime() > ttlMs) return { hit: false };
    const res = await fetch(blob.url, { cache: "no-store" });
    if (!res.ok) return { hit: false };
    return { hit: true, data: (await res.json()) as T };
  } catch {
    return { hit: false };
  }
}

export async function writeCache(path: string, data: unknown): Promise<void> {
  try {
    await put(`cache/${path}.json`, JSON.stringify(data), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });
  } catch {
    // Cache writes are best-effort; the request already has its answer.
  }
}
