import { writeJsonToStore, type BlobStore } from "./blobStore.ts";
import { isStorageUnavailable, type StorageUnavailableError } from "./storage.ts";

export interface AvatarPointer {
  url: string;
  path: string;
  version: string;
  createdAt: string;
}

const POINTER_PREFIX = "avatar/pointer-";

/** One pointer file per avatar version — never overwrite a CDN-cached path. */
export function pointerPath(version: string): string {
  return `${POINTER_PREFIX}${version}.json`;
}

function isPointerPath(pathname: string): boolean {
  return pathname.startsWith(POINTER_PREFIX) && pathname.endsWith(".json");
}

function isPointer(value: unknown): value is AvatarPointer {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.url === "string" && typeof p.path === "string" && typeof p.version === "string"
  );
}

/** Newest pointer by uploadedAt; null when none (or unreadable). */
/** In-memory newest pointer (60s); every write below invalidates it. */
let pointerCache: { at: number; pointer: AvatarPointer | null } | null = null;

/** Test-only reset so fresh fake stores never see another test's cache. */
export function resetAvatarPointerCacheForTests(): void {
  pointerCache = null;
}

/**
 * Newest-first: tries each versioned pointer until one parses. Throws
 * StorageUnavailableError only when storage itself fails on every read —
 * never null for an outage (the UI must not show "no avatar" then).
 */
export async function readAvatarPointer(store: BlobStore): Promise<AvatarPointer | null> {
  if (pointerCache && Date.now() - pointerCache.at < 60_000) return pointerCache.pointer;
  const entries = await store.listBlobs(POINTER_PREFIX);
  const pointers = entries.filter((entry) => isPointerPath(entry.pathname));
  pointers.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  let outage: StorageUnavailableError | null = null;
  for (const candidate of pointers) {
    try {
      const data = await store.fetchJson<unknown>(candidate.url);
      if (isPointer(data)) {
        pointerCache = { at: Date.now(), pointer: data };
        return data;
      }
    } catch (err) {
      if (isStorageUnavailable(err)) outage = err;
    }
  }
  if (outage) throw outage;
  pointerCache = { at: Date.now(), pointer: null };
  return null;
}

/** Strict write: throws on failure, so the caller never deletes on a miss. */
export async function writeAvatarPointer(
  store: BlobStore,
  pointer: AvatarPointer,
): Promise<void> {
  await writeJsonToStore(store, pointerPath(pointer.version), pointer);
  pointerCache = null;
}

const CANDIDATE_PREFIX = "avatar/candidate-";

/** Candidate paths are unguessable (`avatar/candidate-<uuid>.<ext>`). */
export function isCandidatePath(pathname: string): boolean {
  if (!pathname.startsWith(CANDIDATE_PREFIX) || pathname.includes("/", CANDIDATE_PREFIX.length)) {
    return false;
  }
  return /\.(png|webp|jpg)$/.test(pathname);
}

/**
 * Delete unfinished redo candidates (leaving without choosing = Cancel).
 * Keeps one path when it just became the avatar.
 */
export async function deleteCandidates(store: BlobStore, keepPath?: string): Promise<void> {
  const entries = await store.listBlobs(CANDIDATE_PREFIX);
  const stale = entries
    .map((entry) => entry.pathname)
    .filter((pathname) => isCandidatePath(pathname) && pathname !== keepPath);
  if (stale.length > 0) await store.delBlobs(stale);
}

/** Delete every pointer file except the current one. */
export async function deleteOldPointers(store: BlobStore, keepPath: string): Promise<void> {
  const entries = await store.listBlobs(POINTER_PREFIX);
  const stale = entries
    .map((entry) => entry.pathname)
    .filter((pathname) => isPointerPath(pathname) && pathname !== keepPath);
  if (stale.length > 0) await store.delBlobs(stale);
}
