import { NextResponse } from "next/server";
import { put } from "@vercel/blob";

import { readAvatarPointer } from "@/lib/avatarPointer";
import { logBlobUsage } from "@/lib/blobStore";
import { getBlobStore, readCache, writeCache } from "@/lib/cache";
import { isStorageUnavailable, storageUnavailableResponse } from "@/lib/storage";
import { closetStamp } from "@/lib/closet";
import { editImage } from "@/lib/meta/image";
import {
  createRetryBudget,
  isOutageError,
  META_HICCUP_MESSAGE,
  META_UNAVAILABLE_CODE,
} from "@/lib/meta/retry";
import { buildRenderPrompt, detectImageFormat, renderCacheKey, type RenderRecord } from "@/lib/render";
import { loadRenderInputs } from "@/lib/renderInputs";

export const maxDuration = 300;

/**
 * Render an outfit onto the user's avatar and return the FIRST image as
 * soon as it exists (cached as unverified). Verification runs separately in
 * /api/render/verify so the user never waits on it. Cache key = avatar
 * version + sorted item ids (Blob). Logs counts, byte sizes and verdicts
 * only, never images.
 */
export async function POST(req: Request) {
  const started = Date.now();
  const routeMs = () => Date.now() - started;
  const budget = createRetryBudget(started + 290_000);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send JSON: itemIds." }, { status: 400 });
  }
  const itemIds = (body as { itemIds?: unknown }).itemIds;
  if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > 10 || itemIds.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "itemIds must be 1–10 closet item ids." }, { status: 400 });
  }

  try {
    const pointer = await readAvatarPointer(getBlobStore());
    if (!pointer) {
      console.log(`render error=no-avatar route_ms=${routeMs()}`);
      return NextResponse.json({ error: "No avatar yet.", code: "no-avatar" }, { status: 404 });
    }
    const version = pointer.version;
    const key = renderCacheKey(version, itemIds as string[], await closetStamp(itemIds as string[]));
    const cached = await readCache<RenderRecord>(key, Number.POSITIVE_INFINITY);
    if (cached.hit && cached.data) {
      console.log(`render ms=${routeMs()} cached=1 verified=${cached.data.verified ? 1 : 0} avatar=${version}`);
      logBlobUsage("render");
      return NextResponse.json({
        url: cached.data.url,
        cached: true,
        verified: cached.data.verified,
        invented: [],
      });
    }

    const inputs = await loadRenderInputs(itemIds as string[], pointer.url);
    const avatarDataUrl =
      `data:${inputs.avatarFormat.contentType};base64,${inputs.avatarBytes.toString("base64")}`;
    console.log(
      `render start images=${1 + inputs.cutoutDataUrls.length} ` +
        `input_bytes=${inputs.inputBytes} avatar=${version}`,
    );

    const raw = await editImage({
      images: [avatarDataUrl, ...inputs.cutoutDataUrls],
      prompt: buildRenderPrompt(inputs.garments),
      budget,
    });
    const format = detectImageFormat(raw);
    const path = `renders/${crypto.randomUUID()}.${format.ext}`;
    const uploaded = await put(path, raw, {
      access: "public",
      contentType: format.contentType,
      addRandomSuffix: false,
    });
    const record: RenderRecord = { url: uploaded.url, verified: false, invented: [] };
    await writeCache(key, record);
    console.log(
      `render ms=${routeMs()} cached=0 verified=0 format=${format.ext} avatar=${version}`,
    );
    logBlobUsage("render");
    return NextResponse.json({ url: uploaded.url, cached: false, verified: false, invented: [] });
  } catch (err) {
    logBlobUsage("render");
    if (isStorageUnavailable(err)) return storageUnavailableResponse();
    const message = err instanceof Error ? err.message : "Render failed.";
    if (/content_policy_violation/i.test(message)) {
      console.log(`render error=content-policy route_ms=${routeMs()}`);
      return NextResponse.json(
        {
          url: null,
          cached: false,
          verified: false,
          invented: [],
          fallback: true,
          note: "Couldn't put this look on your avatar right now - here are the pieces.",
        },
        { status: 200 },
      );
    }
    if (isOutageError(err)) {
      console.log(`render error=outage detail=${JSON.stringify(message.slice(0, 200))} route_ms=${routeMs()}`);
      return NextResponse.json(
        { error: META_HICCUP_MESSAGE, code: META_UNAVAILABLE_CODE },
        { status: 500 },
      );
    }
    console.log(`render error=${JSON.stringify(message.slice(0, 200))} route_ms=${routeMs()}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
