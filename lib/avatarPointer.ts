import { writeJsonToStore, type BlobStore } from "./blobStore.ts";

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
export async function readAvatarPointer(store: BlobStore): Promise<AvatarPointer | null> {
  try {
    const entries = await store.listBlobs(POINTER_PREFIX);
    const pointers = entries.filter((entry) => isPointerPath(entry.pathname));
    if (pointers.length === 0) return null;
    pointers.sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    );
    const newest = pointers[0];
    if (!newest) return null;
    const data = await store.fetchJson<unknown>(newest.url);
    return isPointer(data) ? data : null;
  } catch {
    return null;
  }
}

/** Strict write: throws on failure, so the caller never deletes on a miss. */
export async function writeAvatarPointer(
  store: BlobStore,
  pointer: AvatarPointer,
): Promise<void> {
  await writeJsonToStore(store, pointerPath(pointer.version), pointer);
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
