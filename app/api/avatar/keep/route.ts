import { NextResponse } from "next/server";

import {
  deleteCandidates,
  deleteOldPointers,
  isCandidatePath,
  pointerPath,
  readAvatarPointer,
  writeAvatarPointer,
  type AvatarPointer,
} from "@/lib/avatarPointer";
import { getBlobStore } from "@/lib/cache";

export const maxDuration = 60;

/**
 * Keep a redo candidate: swap the versioned pointer to it, then delete the
 * old avatar file only after the write succeeds. Anything else pending is
 * cleaned up; the kept blob becomes the avatar (its name is just a name).
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send JSON: path and url." }, { status: 400 });
  }
  const { path, url } = (body ?? {}) as { path?: unknown; url?: unknown };
  if (typeof path !== "string" || !isCandidatePath(path)) {
    return NextResponse.json({ error: "Unknown candidate." }, { status: 400 });
  }
  if (typeof url !== "string" || !url.startsWith("https://")) {
    return NextResponse.json({ error: "Unknown candidate URL." }, { status: 400 });
  }
  const store = getBlobStore();
  const previous = await readAvatarPointer(store);
  const pointer: AvatarPointer = {
    url,
    path,
    version: `v${Date.now()}`,
    createdAt: new Date().toISOString(),
  };
  try {
    await writeAvatarPointer(store, pointer);
  } catch {
    return NextResponse.json({ error: "Couldn't save the new avatar. Try again." }, { status: 500 });
  }
  if (previous && previous.path !== path) {
    await store.delBlobs([previous.path]).catch(() => undefined);
  }
  await deleteOldPointers(store, pointerPath(pointer.version));
  await deleteCandidates(store, path).catch(() => undefined);
  return NextResponse.json({ url: pointer.url, version: pointer.version });
}
