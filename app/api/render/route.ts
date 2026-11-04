import { NextResponse } from "next/server";
import { put } from "@vercel/blob";

import { readAvatarPointer } from "@/lib/avatarPointer";
import { getBlobStore, readCache, writeCache } from "@/lib/cache";
import { listItems } from "@/lib/closet";
import { editImage } from "@/lib/meta/image";
import {
  createRetryBudget,
  isOutageError,
  META_HICCUP_MESSAGE,
  META_UNAVAILABLE_CODE,
} from "@/lib/meta/retry";
import { verifyRender } from "@/lib/meta/spark";
import { decideVerification, detectImageFormat, RENDER_PROMPT, renderCacheKey } from "@/lib/render";

export const maxDuration = 60;

interface RenderRecord {
  url: string;
}

/**
 * Render an outfit onto the user's avatar. Cache key = avatar version +
 * sorted item ids (Blob). Verify with Spark; on failure re-render once
 * naming the invented items, else fall back to flat-lay. Logs timings +
 * verification verdicts only, never images.
 */
export async function POST(req: Request) {
  const started = Date.now();
  const routeMs = () => Date.now() - started;
  // ~55s shared budget: render (~9s) + verify (~4s) + one re-render + verify.
  const budget = createRetryBudget(started + 55_000);
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
    const items = await listItems();
    const byId = new Map(items.map((item) => [item.id, item]));
    const missing = (itemIds as string[]).filter((id) => !byId.has(id));
    if (missing.length > 0) {
      console.log(`render error=unknown-item route_ms=${routeMs()}`);
      return NextResponse.json({ error: "Unknown closet item." }, { status: 400 });
    }
    const pointer = await readAvatarPointer(getBlobStore());
    if (!pointer) {
      console.log(`render error=no-avatar route_ms=${routeMs()}`);
      return NextResponse.json({ error: "No avatar yet.", code: "no-avatar" }, { status: 404 });
    }
    const version = pointer.version;
    const key = renderCacheKey(version, itemIds as string[]);
    const cached = await readCache<RenderRecord>(key, Number.POSITIVE_INFINITY);
    if (cached.hit && cached.data) {
      console.log(`render ms=${Date.now() - started} cached=1 verified=1 avatar=${version}`);
      return NextResponse.json({ url: cached.data.url, cached: true, verified: true, invented: [] });
    }

    const refs = (itemIds as string[]).map((id) => byId.get(id)!);
    const avatarRes = await fetch(pointer.url, { cache: "no-store" });
    if (!avatarRes.ok) throw new Error("Could not load the avatar.");
    const avatarBytes = Buffer.from(await avatarRes.arrayBuffer());
    const avatarFormat = detectImageFormat(avatarBytes);
    const avatarDataUrl = `data:${avatarFormat.contentType};base64,${avatarBytes.toString("base64")}`;
    const referenceUrls = refs.map((item) => item.cutoutUrl);
    console.log(`render start images=${1 + referenceUrls.length} bytes=${avatarBytes.length} format=${avatarFormat.ext} avatar=${version}`);

    let invented: string[] = [];
    let renderBytes: Buffer | null = null;
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const prompt =
        attempt === 0
          ? RENDER_PROMPT
          : `${RENDER_PROMPT} Remove these invented items: ${invented.join(", ")}.`;
      const raw = await editImage({ images: [avatarDataUrl, ...referenceUrls], prompt, budget });
      renderBytes = raw;
      const renderFormat = detectImageFormat(raw);
      const renderDataUrl = `data:${renderFormat.contentType};base64,${raw.toString("base64")}`;
      const verdict = await verifyRender({ renderDataUrl, referenceUrls, budget });
      invented = verdict.invented_items;
      const decision = decideVerification(verdict.garments_match, attempt);
      console.log(`render verify attempt=${attempt} garments_match=${verdict.garments_match ? 1 : 0} invented=${invented.length} format=${renderFormat.ext} avatar=${version} decision=${decision}`);
      if (decision !== "rerender") {
        if (decision === "fallback") renderBytes = null;
        break;
      }
    }
    if (!renderBytes) {
      console.log(`render ms=${routeMs()} cached=0 verified=0 fallback=1 invented=${invented.length} avatar=${version}`);
      return NextResponse.json({ url: null, cached: false, verified: false, invented, fallback: true });
    }
    const format = detectImageFormat(renderBytes);
    const path = `renders/${crypto.randomUUID()}.${format.ext}`;
    const uploaded = await put(path, renderBytes, {
      access: "public",
      contentType: format.contentType,
      addRandomSuffix: false,
    });
    await writeCache(key, { url: uploaded.url } satisfies RenderRecord);
    console.log(`render ms=${routeMs()} cached=0 verified=1 invented=${invented.length} format=${format.ext} avatar=${version}`);
    return NextResponse.json({ url: uploaded.url, cached: false, verified: true, invented });
  } catch (err) {
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
          note: "The image model declined this combination. Showing the flat-lay instead.",
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
