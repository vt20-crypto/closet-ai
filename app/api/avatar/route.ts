import { NextResponse } from "next/server";

import {
  deleteCandidates,
  deleteOldPointers,
  pointerPath,
  readAvatarPointer,
  writeAvatarPointer,
  type AvatarPointer,
} from "@/lib/avatarPointer";
import { logBlobUsage } from "@/lib/blobStore";
import { getBlobStore } from "@/lib/cache";
import { isStorageUnavailable, storageUnavailableResponse } from "@/lib/storage";
import { editImage } from "@/lib/meta/image";
import {
  createRetryBudget,
  isOutageError,
  META_HICCUP_MESSAGE,
  META_UNAVAILABLE_CODE,
} from "@/lib/meta/retry";
import { describeAppearance } from "@/lib/meta/spark";
import {
  avatarLimitMessage,
  checkAvatarAllowance,
  recordAvatarGeneration,
} from "@/lib/limits";
import { buildAvatarPrompt, detectImageFormat, type Vibe } from "@/lib/render";

export const maxDuration = 300;

const MAX_DATA_URL = 4 * 1024 * 1024;

const VIBES = ["playful", "minimal", "edgy", "classic"] as const;

/** Current avatar (newest versioned pointer), or null when none yet. */
export async function GET() {
  const store = getBlobStore();
  try {
    // Leaving a redo without choosing = Cancel: orphans die on the next load.
    await deleteCandidates(store).catch(() => undefined);
    const pointer = await readAvatarPointer(store);
    logBlobUsage("avatar");
    if (!pointer) return NextResponse.json({ avatar: null });
    return NextResponse.json({ avatar: { url: pointer.url, version: pointer.version } });
  } catch (err) {
    logBlobUsage("avatar");
    if (isStorageUnavailable(err)) return storageUnavailableResponse();
    throw err;
  }
}

function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/") && value.length < MAX_DATA_URL;
}

/**
 * Create (or redo) the avatar. Selfies travel inline and are NEVER stored —
 * only the generated avatar lands in Blob (format sniffed, usually WEBP),
 * under an unguessable path, with the current pointer in a small JSON.
 * Redo deletes the old avatar blob. Logs counts + timings only, never images.
 */
export async function POST(req: Request) {
  const started = Date.now();
  const routeMs = () => Date.now() - started;
  // ~55s retry budget inside the 60s route ceiling.
  const budget = createRetryBudget(started + 290_000);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    console.log(`avatar error=bad-json route_ms=${routeMs()}`);
    return NextResponse.json({ error: "Send JSON: selfie (photo data URL)." }, { status: 400 });
  }
  const { selfie, fullBody, height, build, hairNote, vibe } = (body ?? {}) as {
    selfie?: unknown;
    fullBody?: unknown;
    height?: unknown;
    build?: unknown;
    hairNote?: unknown;
    vibe?: unknown;
  };
  if (!isDataUrl(selfie)) {
    console.log(`avatar error=bad-selfie route_ms=${routeMs()}`);
    return NextResponse.json({ error: "A front selfie photo is required." }, { status: 400 });
  }
  if (fullBody !== undefined && !isDataUrl(fullBody)) {
    console.log(`avatar error=bad-fullbody route_ms=${routeMs()}`);
    return NextResponse.json({ error: "The full-body photo must be an image data URL." }, { status: 400 });
  }

  const store = getBlobStore();
  const allowance = await checkAvatarAllowance(store, Date.now());
  if (!allowance.allowed) {
    return NextResponse.json(
      { error: avatarLimitMessage(allowance.resetAt), code: "avatar-limit", resetAt: allowance.resetAt },
      { status: 429 },
    );
  }

  const images = isDataUrl(fullBody) ? [selfie, fullBody] : [selfie];

  const previous = await readAvatarPointer(store);
  let uploadedPath: string | null = null;
  let pointerWritten = false;
  try {
    // Likeness brief from the selfie: prompt-only, never stored or logged.
    const appearance = await describeAppearance(selfie, budget);
    const prompt = buildAvatarPrompt({
      height: typeof height === "string" ? height : null,
      build: typeof build === "string" ? build : null,
      hairNote: typeof hairNote === "string" ? hairNote : null,
      vibe: (VIBES as readonly string[]).includes(vibe as string) ? (vibe as Vibe) : null,
      appearance,
    });
    const bytes = images.reduce((sum, image) => sum + Buffer.byteLength(image), 0);
    console.log(`avatar start images=${images.length} bytes=${bytes}`);
    const raw = await editImage({ images, prompt, budget });
    const format = detectImageFormat(raw);
    const path = `avatar/${crypto.randomUUID()}.${format.ext}`;
    const url = await store.putBlob(path, raw, format.contentType, {
      cacheControlMaxAge: 31536000,
    });
    uploadedPath = path;
    const pointer: AvatarPointer = {
      url,
      path,
      version: `v${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    // Strict: throws on failure, so nothing below runs on a missed write.
    await writeAvatarPointer(store, pointer);
    pointerWritten = true;
    // The new pointer is confirmed: the old avatar file is now unreferenced.
    if (previous && previous.path !== path) {
      await store.delBlobs([previous.path]).catch(() => undefined);
    }
    await deleteOldPointers(store, pointerPath(pointer.version));
    // One weekly generation consumed; a missed write keeps the count.
    await recordAvatarGeneration(store, Date.now()).catch(() => undefined);
    console.log(`avatar ms=${routeMs()} version=${pointer.version} format=${format.ext}`);
    return NextResponse.json({ url: pointer.url, version: pointer.version });
  } catch (err) {
    // The new file is orphaned only when the pointer write failed; the
    // previous avatar the pointer uses is never touched here.
    if (uploadedPath && !pointerWritten) {
      await store.delBlobs([uploadedPath]).catch(() => undefined);
    }
    const message = err instanceof Error ? err.message : "Avatar creation failed.";
    if (/content_policy_violation/i.test(message)) {
      console.log(`avatar error=content-policy route_ms=${routeMs()}`);
      return NextResponse.json(
        { error: "That photo didn't work. Try a different selfie." },
        { status: 400 },
      );
    }
    if (isOutageError(err)) {
      console.log(`avatar error=outage detail=${JSON.stringify(message.slice(0, 200))} route_ms=${routeMs()}`);
      return NextResponse.json(
        { error: META_HICCUP_MESSAGE, code: META_UNAVAILABLE_CODE },
        { status: 500 },
      );
    }
    console.log(`avatar error=${JSON.stringify(message.slice(0, 200))} route_ms=${routeMs()}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
