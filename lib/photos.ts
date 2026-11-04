import "server-only";

import { del, list, put } from "@vercel/blob";

import { blobOpCounts } from "./blobStore.ts";
import { getBlobStore } from "./cache.ts";
import { isPhotoPathname, photoMetaPath } from "./photoPaths";
import { isStorageUnavailable, StorageUnavailableError } from "./storage.ts";

export { isPhotoPathname, photoMetaPath };

/**
 * Scan bookkeeping for raw photos. One JSON blob per photo at
 * photos-meta/<photo pathname>.json, e.g. photos-meta/photos/123-0.jpg.json:
 * { photoPathname, scannedAt, candidateIds, keptIds }.
 */

export interface PhotoMeta {
  photoPathname: string;
  scannedAt: string;
  candidateIds: string[];
  keptIds: string[];
  /** Pathname of the photo this one was cropped from (crops only). */
  parentPhoto?: string;
}

export async function getPhotoMeta(photoPathname: string): Promise<PhotoMeta | null> {
  const path = photoMetaPath(photoPathname);
  const page = await list({ prefix: path });
  const blob = page.blobs.find((b) => b.pathname === path);
  if (!blob) return null;
  const res = await fetch(blob.url, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as PhotoMeta;
}

export async function listPhotoMeta(): Promise<Record<string, PhotoMeta>> {
  const out: Record<string, PhotoMeta> = {};
  const store = getBlobStore();
  let failures = 0;
  let outage: StorageUnavailableError | null = null;
  let cursor: string | undefined;
  do {
    let page;
    try {
      blobOpCounts.list += 1;
      page = await list({ prefix: "photos-meta/", cursor });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 0;
      console.log(`blob_list status=${status || "network-fail"} prefix=photos-meta/`);
      if (Object.keys(out).length > 0) return out;
      throw new StorageUnavailableError(status, "prefix:photos-meta/");
    }
    const metas = await Promise.all(
      page.blobs
        .filter((b) => b.pathname.endsWith(".json"))
        .map(async (b) => {
          try {
            return await store.fetchJson<PhotoMeta>(b.url);
          } catch (err) {
            if (isStorageUnavailable(err)) outage = err;
            else failures += 1;
            return null;
          }
        }),
    );
    for (const m of metas) {
      if (m && isPhotoPathname(m.photoPathname)) out[m.photoPathname] = m;
      else if (m === null) failures += 1;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  if (Object.keys(out).length === 0 && (outage || failures > 0)) {
    if (outage) throw outage;
  }
  return out;
}

export async function savePhotoMeta(meta: PhotoMeta): Promise<void> {
  await put(photoMetaPath(meta.photoPathname), JSON.stringify(meta), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    // Rescans rewrite the same meta path; items/ is never overwritten.
    allowOverwrite: true,
  });
}

export async function deletePhotoMeta(photoPathname: string): Promise<void> {
  await del(photoMetaPath(photoPathname));
}

/** Record a completed scan. Prior keptIds and parent survive a rescan. */
export async function recordScan(
  photoPathname: string,
  candidateIds: string[],
  parentPhoto?: string,
): Promise<PhotoMeta> {
  const existing = await getPhotoMeta(photoPathname);
  const meta: PhotoMeta = {
    photoPathname,
    scannedAt: new Date().toISOString(),
    candidateIds,
    keptIds: existing?.keptIds ?? [],
  };
  const parent = existing?.parentPhoto ?? (parentPhoto && isPhotoPathname(parentPhoto) ? parentPhoto : undefined);
  if (parent) meta.parentPhoto = parent;
  await savePhotoMeta(meta);
  return meta;
}

/** Append kept item ids (deduplicated). Creates a meta record if missing. */
export async function recordKept(photoPathname: string, keptIds: string[]): Promise<PhotoMeta> {
  const existing = await getPhotoMeta(photoPathname);
  const seen = new Set(existing?.keptIds ?? []);
  for (const id of keptIds) seen.add(id);
  const meta: PhotoMeta = {
    photoPathname,
    scannedAt: existing?.scannedAt ?? new Date().toISOString(),
    candidateIds: existing?.candidateIds ?? [],
    keptIds: [...seen],
  };
  if (existing?.parentPhoto) meta.parentPhoto = existing.parentPhoto;
  await savePhotoMeta(meta);
  return meta;
}

/**
 * Delete a photo AND every crop derived from it (plus all their meta).
 * Kept closet items are never touched: only photos/ and photos-meta/ blobs.
 */
export async function deletePhotoFamily(rootPathname: string): Promise<string[]> {
  const all = await listPhotoMeta();
  const family = [rootPathname];
  for (const [pathname, meta] of Object.entries(all)) {
    if (meta.parentPhoto === rootPathname && !family.includes(pathname)) {
      family.push(pathname);
    }
  }
  const deleted: string[] = [];
  for (const pathname of family) {
    try {
      await del(pathname);
      deleted.push(pathname);
    } catch {
      // Best-effort per blob; the meta sweep below still runs.
    }
    try {
      await deletePhotoMeta(pathname);
    } catch {
      // Missing meta is not a failure.
    }
  }
  return deleted;
}
