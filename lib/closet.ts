import "server-only";

import { del, head, list, put } from "@vercel/blob";

import { BLOB_CACHE_MAX_AGE, blobOpCounts } from "./blobStore.ts";
import { getBlobStore } from "./cache.ts";
import type { GarmentTags } from "./meta/spark";
import { isStorageUnavailable, StorageUnavailableError } from "./storage.ts";

export interface ClosetBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One garment item. Candidates and confirmed items share this shape. */
export interface ClosetItem {
  id: string;
  cutoutUrl: string;
  nouns: string[];
  confidence: number;
  box: ClosetBox;
  tags: GarmentTags;
  photoUrl: string;
  /** Blob pathname of the source photo (absent on pre-scan-pipeline items). */
  photoPathname?: string;
  createdAt: string;
  /** Last tag merge (e.g. the fit backfill); absent when never re-tagged. */
  updatedAt?: string;
  /** True while the piece is in the laundry: hidden from outfit picks. */
  laundry?: boolean;
}

export function newId(): string {
  return crypto.randomUUID();
}

/**
 * A not-yet-confirmed candidate. Tags are null when the tag call itself
 * errored (retried once); the user then judges the raw cutout. Rejected
 * candidates keep their tags (is_single_garment=false + reason) so the UI
 * can show them for a final human call.
 */
export type CandidateItem = Omit<ClosetItem, "tags"> & { tags: GarmentTags | null };

const candidatePng = (id: string) => `candidates/${id}.png`;
const candidateJson = (id: string) => `candidates/${id}.json`;
const itemPng = (id: string) => `items/${id}.png`;
const itemJson = (id: string) => `items/${id}.json`;

/**
 * Failure-visible listing: every failed read logs status+path and retries
 * once (inside fetchJson). Partial results return with a log line; when
 * NOTHING reads, the outage throws instead of an empty list.
 */
async function listAllJson<T extends ClosetItem | CandidateItem>(prefix: string): Promise<T[]> {
  const store = getBlobStore();
  const items: T[] = [];
  let failures = 0;
  let outage: StorageUnavailableError | null = null;
  let cursor: string | undefined;
  do {
    let page;
    try {
      blobOpCounts.list += 1;
      page = await list({ prefix, cursor });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 0;
      console.log(`blob_list status=${status || "network-fail"} prefix=${prefix}`);
      if (items.length > 0) {
        console.log(`closet partial prefix=${prefix} items=${items.length}`);
        return items;
      }
      throw new StorageUnavailableError(status, `prefix:${prefix}`);
    }
    const metas = await Promise.all(
      page.blobs
        .filter((b) => b.pathname.endsWith(".json"))
        .map(async (b) => {
          try {
            return await store.fetchJson<T>(b.url);
          } catch (err) {
            if (isStorageUnavailable(err)) outage = err;
            return null;
          }
        }),
    );
    for (const m of metas) {
      if (m) items.push(m);
      else failures += 1;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  if (items.length === 0 && (failures > 0 || outage)) {
    throw outage ?? new StorageUnavailableError(0, `prefix:${prefix}`);
  }
  return items;
}

/** In-memory item list (60s); every write below invalidates it. */
let itemsCache: { at: number; items: ClosetItem[] } | null = null;

export async function listItems(): Promise<ClosetItem[]> {
  if (itemsCache && Date.now() - itemsCache.at < 60_000) return itemsCache.items;
  const items = await listAllJson<ClosetItem>("items/");
  itemsCache = { at: Date.now(), items };
  touchVersion(items.length);
  return items;
}

/**
 * Cheap closet fingerprint for the "changed" pill: newest item-blob write
 * plus the item count, from one metadata list call, cached 60s. Writes mark
 * it stale so the next check re-lists once.
 */
let versionCache: { at: number; stamp: string; count: number } | null = null;

function touchVersion(count: number): void {
  versionCache = { at: Date.now(), stamp: new Date().toISOString(), count };
}

function invalidateCaches(): void {
  itemsCache = null;
  versionCache = null;
}

export async function getClosetVersion(): Promise<{ stamp: string; count: number }> {
  if (versionCache && Date.now() - versionCache.at < 60_000) {
    return { stamp: versionCache.stamp, count: versionCache.count };
  }
  let stamp = "";
  let count = 0;
  let cursor: string | undefined;
  do {
    let page;
    try {
      blobOpCounts.list += 1;
      page = await list({ prefix: "items/", cursor });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 0;
      console.log(`blob_list status=${status || "network-fail"} prefix=items/`);
      if (versionCache) return { stamp: versionCache.stamp, count: versionCache.count };
      throw new StorageUnavailableError(status, "prefix:items/");
    }
    for (const blob of page.blobs) {
      if (!blob.pathname.endsWith(".json")) continue;
      count += 1;
      const uploaded = new Date(blob.uploadedAt).toISOString();
      if (uploaded > stamp) stamp = uploaded;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  versionCache = { at: Date.now(), stamp, count };
  return { stamp, count };
}

/** Upload a candidate cutout PNG. Returns its public URL. */
export async function putCandidatePng(id: string, png: Buffer): Promise<string> {
  blobOpCounts.put += 1;
  const blob = await put(candidatePng(id), png, {
    access: "public",
    contentType: "image/png",
    addRandomSuffix: false,
    allowOverwrite: true,
    // Cutout bytes are immutable (new id per scan).
    cacheControlMaxAge: 31536000,
  });
  return blob.url;
}

export async function saveCandidate(item: CandidateItem): Promise<void> {
  blobOpCounts.put += 1;
  await put(candidateJson(item.id), JSON.stringify(item), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: BLOB_CACHE_MAX_AGE,
  });
}

/**
 * Write a confirmed item. Never overwrites silently: ids are unique per
 * keep, so callers rewriting an existing item (the fit backfill) must pass
 * { allowOverwrite: true } explicitly.
 */
export async function saveItem(item: ClosetItem, opts?: { allowOverwrite?: boolean }): Promise<void> {
  blobOpCounts.put += 1;
  await put(itemJson(item.id), JSON.stringify(item), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: opts?.allowOverwrite ?? false,
    cacheControlMaxAge: BLOB_CACHE_MAX_AGE,
  });
  invalidateCaches();
}

export async function listCandidates(): Promise<CandidateItem[]> {
  return listAllJson<CandidateItem>("candidates/");
}

export async function getCandidate(id: string): Promise<CandidateItem | null> {
  const blob = await getBlobStore().headBlob(candidateJson(id));
  if (!blob) return null;
  return getBlobStore().fetchJson<CandidateItem>(blob.url);
}

export async function deleteCandidate(id: string): Promise<void> {
  blobOpCounts.del += 1;
  await del([candidatePng(id), candidateJson(id)]);
}

/**
 * Max item-blob write time over a few ids, via one head() each (no JSON
 * fetch). Overwrites bump uploadedAt, so an edit changes the stamp and
 * stale renders for that look never serve. Unknown ids contribute nothing.
 */
export async function closetStamp(ids: string[]): Promise<string> {
  const stamps = await Promise.all(
    ids.map(async (id) => {
      try {
        blobOpCounts.head += 1;
        const blob = await head(itemJson(id));
        return new Date(blob.uploadedAt).toISOString();
      } catch {
        return "";
      }
    }),
  );
  return stamps.reduce((max, stamp) => (stamp > max ? stamp : max), "");
}

/**
 * Move a candidate to items/: the candidate PNG is immutable, so the item
 * keeps its URL (no copy op) and only the candidate JSON is deleted.
 */
export async function confirmCandidate(id: string): Promise<CandidateItem> {
  const candidate = await getCandidate(id);
  if (!candidate) throw new Error(`Candidate not found: ${id}`);
  const item: CandidateItem = { ...candidate };
  blobOpCounts.put += 1;
  await put(itemJson(id), JSON.stringify(item), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    cacheControlMaxAge: BLOB_CACHE_MAX_AGE,
  });
  blobOpCounts.del += 1;
  await del([candidateJson(id)]);
  invalidateCaches();
  return item;
}

export async function deleteItem(id: string): Promise<void> {
  blobOpCounts.del += 1;
  await del([itemPng(id), itemJson(id)]);
  invalidateCaches();
}
