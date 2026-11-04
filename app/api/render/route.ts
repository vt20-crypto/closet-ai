import { NextResponse } from "next/server";
import { put } from "@vercel/blob";

import { readCache, writeCache } from "@/lib/cache";
import { listItems } from "@/lib/closet";
import { editImage } from "@/lib/meta/image";
import {
  createRetryBudget,
  isOutageError,
  META_HICCUP_MESSAGE,
  META_UNAVAILABLE_CODE,
} from "@/lib/meta/retry";
import { verifyRender } from "@/lib/meta/spark";
import { decideVerification, RENDER_PROMPT, renderCacheKey } from "@/lib/render";

export const maxDuration = 60;

interface AvatarPointer {
  url: string;
  path: string;
  version: string;
  createdAt: string;
}

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
      return NextResponse.json({ error: "Unknown closet item." }, { status: 400 });
    }
    const pointer = await readCache<AvatarPointer>("avatar/current", Number.POSITIVE_INFINITY);
    if (!pointer.hit || !pointer.data) {
      return NextResponse.json({ error: "No avatar yet.", code: "no-avatar" }, { status: 404 });
    }
    const version = pointer.data.version;
    const key = renderCacheKey(version, itemIds as string[]);
    const cached = await readCache<RenderRecord>(key, Number.POSITIVE_INFINITY);
    if (cached.hit && cached.data) {
      console.log(`render ms=${Date.now() - started} cached=1 verified=1`);
      return NextResponse.json({ url: cached.data.url, cached: true, verified: true, invented: [] });
    }

    const refs = (itemIds as string[]).map((id) => byId.get(id)!);
    const avatarRes = await fetch(pointer.data.url, { cache: "no-store" });
    if (!avatarRes.ok) throw new Error("Could not load the avatar.");
    const avatarDataUrl = `data:image/png;base64,${Buffer.from(await avatarRes.arrayBuffer()).toString("base64")}`;
    const referenceUrls = refs.map((item) => item.cutoutUrl);

    let invented: string[] = [];
    let renderDataUrl: string | null = null;
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const prompt =
        attempt === 0
          ? RENDER_PROMPT
          : `${RENDER_PROMPT} Remove these invented items: ${invented.join(", ")}.`;
      const png = await editImage({ images: [avatarDataUrl, ...referenceUrls], prompt, budget });
      renderDataUrl = `data:image/png;base64,${png.toString("base64")}`;
      const verdict = await verifyRender({ renderDataUrl, referenceUrls, budget });
      invented = verdict.invented_items;
      const decision = decideVerification(verdict.garments_match, attempt);
      console.log(`render verify attempt=${attempt} garments_match=${verdict.garments_match ? 1 : 0} invented=${invented.length} decision=${decision}`);
      if (decision !== "rerender") {
        if (decision === "fallback") renderDataUrl = null;
        break;
      }
    }
    if (!renderDataUrl) {
      return NextResponse.json({ url: null, cached: false, verified: false, invented, fallback: true });
    }
    const path = `renders/${crypto.randomUUID()}.png`;
    const uploaded = await put(path, Buffer.from(renderDataUrl.split(",")[1], "base64"), {
      access: "public",
      contentType: "image/png",
      addRandomSuffix: false,
    });
    await writeCache(key, { url: uploaded.url } satisfies RenderRecord);
    console.log(`render ms=${Date.now() - started} cached=0 verified=1 invented=${invented.length}`);
    return NextResponse.json({ url: uploaded.url, cached: false, verified: true, invented });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Render failed.";
    if (/content_policy_violation/i.test(message)) {
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
      return NextResponse.json(
        { error: META_HICCUP_MESSAGE, code: META_UNAVAILABLE_CODE },
        { status: 500 },
      );
    }
    console.log(`render error=${JSON.stringify(message.slice(0, 200))} route_ms=${Date.now() - started}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
