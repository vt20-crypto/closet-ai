import { NextResponse } from "next/server";
import { del, put } from "@vercel/blob";

import { readCache, writeCache } from "@/lib/cache";
import { editImage } from "@/lib/meta/image";
import {
  createRetryBudget,
  isOutageError,
  META_HICCUP_MESSAGE,
  META_UNAVAILABLE_CODE,
} from "@/lib/meta/retry";
import { buildAvatarPrompt, detectImageFormat, type Vibe } from "@/lib/render";

export const maxDuration = 60;

const POINTER_KEY = "avatar/current";
const MAX_DATA_URL = 4 * 1024 * 1024;

interface AvatarPointer {
  url: string;
  path: string;
  version: string;
  createdAt: string;
}

const VIBES = ["playful", "minimal", "edgy", "classic"] as const;

/** Current avatar, or null when the user has none yet. */
export async function GET() {
  const cached = await readCache<AvatarPointer>(POINTER_KEY, Number.POSITIVE_INFINITY);
  if (!cached.hit || !cached.data) return NextResponse.json({ avatar: null });
  return NextResponse.json({ avatar: { url: cached.data.url, version: cached.data.version } });
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
  const budget = createRetryBudget(started + 55_000);
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
  const images = isDataUrl(fullBody) ? [selfie, fullBody] : [selfie];
  const prompt = buildAvatarPrompt({
    height: typeof height === "string" ? height : null,
    build: typeof build === "string" ? build : null,
    hairNote: typeof hairNote === "string" ? hairNote : null,
    vibe: (VIBES as readonly string[]).includes(vibe as string) ? (vibe as Vibe) : null,
  });

  try {
    const bytes = images.reduce((sum, image) => sum + Buffer.byteLength(image), 0);
    console.log(`avatar start images=${images.length} bytes=${bytes}`);
    const raw = await editImage({ images, prompt, budget });
    const format = detectImageFormat(raw);
    const path = `avatar/${crypto.randomUUID()}.${format.ext}`;
    const uploaded = await put(path, raw, {
      access: "public",
      contentType: format.contentType,
      addRandomSuffix: false,
    });
    const previous = await readCache<AvatarPointer>(POINTER_KEY, Number.POSITIVE_INFINITY);
    const pointer: AvatarPointer = {
      url: uploaded.url,
      path,
      version: `v${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    await writeCache(POINTER_KEY, pointer);
    if (previous.hit && previous.data && previous.data.path !== path) {
      await del(previous.data.path).catch(() => undefined);
    }
    console.log(`avatar ms=${routeMs()} version=${pointer.version} format=${format.ext}`);
    return NextResponse.json({ url: pointer.url, version: pointer.version });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Avatar creation failed.";
    if (/content_policy_violation/i.test(message)) {
      console.log(`avatar error=content-policy route_ms=${routeMs()}`);
      return NextResponse.json(
        { error: "The image model declined that photo. Try a different selfie." },
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
