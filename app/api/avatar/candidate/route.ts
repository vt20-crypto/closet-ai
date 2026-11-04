import { NextResponse } from "next/server";

import {
  deleteCandidates,
  isCandidatePath,
} from "@/lib/avatarPointer";
import { getBlobStore } from "@/lib/cache";
import {
  avatarLimitMessage,
  checkAvatarAllowance,
  recordAvatarGeneration,
} from "@/lib/limits";
import { editImage } from "@/lib/meta/image";
import {
  createRetryBudget,
  isOutageError,
  META_HICCUP_MESSAGE,
  META_UNAVAILABLE_CODE,
} from "@/lib/meta/retry";
import { describeAppearance } from "@/lib/meta/spark";
import { buildAvatarPrompt, detectImageFormat, type Vibe } from "@/lib/render";

export const maxDuration = 300;

const MAX_DATA_URL = 4 * 1024 * 1024;

const VIBES = ["playful", "minimal", "edgy", "classic"] as const;

function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/") && value.length < MAX_DATA_URL;
}

/**
 * Generate a redo CANDIDATE (`avatar/candidate-<uuid>`). The current pointer
 * is untouched: the Studio compare screen decides Keep / Try again / Cancel.
 * Each successful generation consumes one of the 3 weekly redos.
 */
export async function POST(req: Request) {
  const started = Date.now();
  const routeMs = () => Date.now() - started;
  const budget = createRetryBudget(started + 290_000);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
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
    return NextResponse.json({ error: "A front selfie photo is required." }, { status: 400 });
  }
  if (fullBody !== undefined && !isDataUrl(fullBody)) {
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
  // A new attempt replaces any unfinished candidate (Try again = new redo).
  await deleteCandidates(store).catch(() => undefined);
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
    const raw = await editImage({ images, prompt, budget });
    const format = detectImageFormat(raw);
    const path = `avatar/candidate-${crypto.randomUUID()}.${format.ext}`;
    const url = await store.putBlob(path, raw, format.contentType, {
      cacheControlMaxAge: 31536000,
    });
    await recordAvatarGeneration(store, Date.now()).catch(() => undefined);
    console.log(`avatar-candidate ms=${routeMs()} format=${format.ext}`);
    return NextResponse.json({ url, path });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Avatar creation failed.";
    if (/content_policy_violation/i.test(message)) {
      console.log(`avatar-candidate error=content-policy route_ms=${routeMs()}`);
      return NextResponse.json(
        { error: "That photo didn't work. Try a different selfie." },
        { status: 400 },
      );
    }
    if (isOutageError(err)) {
      console.log(`avatar-candidate error=outage detail=${JSON.stringify(message.slice(0, 200))} route_ms=${routeMs()}`);
      return NextResponse.json(
        { error: META_HICCUP_MESSAGE, code: META_UNAVAILABLE_CODE },
        { status: 500 },
      );
    }
    console.log(`avatar-candidate error=${JSON.stringify(message.slice(0, 200))} route_ms=${routeMs()}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Cancel a redo: delete the candidate, keep the current avatar. */
export async function DELETE(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send JSON: path." }, { status: 400 });
  }
  const path = (body as { path?: unknown }).path;
  if (typeof path !== "string" || !isCandidatePath(path)) {
    return NextResponse.json({ error: "Unknown candidate." }, { status: 400 });
  }
  await getBlobStore().delBlobs([path]).catch(() => undefined);
  return NextResponse.json({ deleted: true });
}
