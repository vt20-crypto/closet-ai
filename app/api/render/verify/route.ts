import { NextResponse } from "next/server";
import { put } from "@vercel/blob";

import { readAvatarPointer } from "@/lib/avatarPointer";
import { getBlobStore, readCache, writeCache } from "@/lib/cache";
import { closetStamp } from "@/lib/closet";
import { editImage } from "@/lib/meta/image";
import {
  createRetryBudget,
  isOutageError,
  META_HICCUP_MESSAGE,
  META_UNAVAILABLE_CODE,
} from "@/lib/meta/retry";
import { verifyRender } from "@/lib/meta/spark";
import {
  decideVerification,
  detectImageFormat,
  RENDER_PROMPT,
  renderCacheKey,
  type RenderRecord,
} from "@/lib/render";
import { loadRenderInputs } from "@/lib/renderInputs";

export const maxDuration = 300;

/** Item names only, truncated — never images. */
function inventedNames(invented: { item: string }[]): string {
  return invented.map((entry) => entry.item).join("|").slice(0, 200);
}

/**
 * Background verification for one look: verify the cached first image;
 * only on a real failure (mismatch or a major invented garment) re-render
 * once naming the major items, then accept. The client fires this after
 * /api/render returns and crossfades to the new URL when one arrives.
 * Logs verdicts and invented names only, never images.
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
      console.log(`render-verify error=no-avatar route_ms=${routeMs()}`);
      return NextResponse.json({ error: "No avatar yet.", code: "no-avatar" }, { status: 404 });
    }
    const version = pointer.version;
    const key = renderCacheKey(version, itemIds as string[], await closetStamp(itemIds as string[]));

    const inputs = await loadRenderInputs(itemIds as string[], pointer.url);
    const avatarDataUrl =
      `data:${inputs.avatarFormat.contentType};base64,${inputs.avatarBytes.toString("base64")}`;
    console.log(
      `render-verify start images=${1 + inputs.cutoutDataUrls.length} ` +
        `input_bytes=${inputs.inputBytes} avatar=${version}`,
    );

    // The first image: verify the cached render, rendering now on a miss.
    let firstUrl: string | null = null;
    const cached = await readCache<RenderRecord>(key, Number.POSITIVE_INFINITY);
    if (cached.hit && cached.data) firstUrl = cached.data.url;
    if (!firstUrl) {
      const raw = await editImage({
        images: [avatarDataUrl, ...inputs.cutoutDataUrls],
        prompt: RENDER_PROMPT,
        budget,
      });
      const format = detectImageFormat(raw);
      const uploaded = await put(`renders/${crypto.randomUUID()}.${format.ext}`, raw, {
        access: "public",
        contentType: format.contentType,
        addRandomSuffix: false,
      });
      firstUrl = uploaded.url;
      await writeCache(key, { url: firstUrl, verified: false, invented: [] } satisfies RenderRecord);
      console.log(`render-verify render-miss rendered=1 route_ms=${routeMs()}`);
    }

    const firstRes = await fetch(firstUrl, { cache: "no-store" });
    if (!firstRes.ok) throw new Error("Could not load the first render.");
    const firstBytes = Buffer.from(await firstRes.arrayBuffer());
    const firstFormat = detectImageFormat(firstBytes);
    const firstDataUrl = `data:${firstFormat.contentType};base64,${firstBytes.toString("base64")}`;

    const verdict = await verifyRender({
      renderDataUrl: firstDataUrl,
      referenceUrls: inputs.cutoutDataUrls,
      budget,
    });
    const decision = decideVerification(verdict.garments_match, verdict.invented_items, 0);
    console.log(
      `render-verify attempt=0 garments_match=${verdict.garments_match ? 1 : 0} ` +
        `invented_names=[${inventedNames(verdict.invented_items)}] avatar=${version} decision=${decision}`,
    );

    let finalUrl = firstUrl;
    let finalVerified = decision === "pass";
    let invented = verdict.invented_items;
    if (decision === "rerender") {
      const majorNames = invented.filter((entry) => entry.major).map((entry) => entry.item);
      const prompt =
        majorNames.length > 0
          ? `${RENDER_PROMPT} Remove these invented items: ${majorNames.join(", ")}.`
          : `${RENDER_PROMPT} Match the reference garments exactly.`;
      const raw = await editImage({
        images: [avatarDataUrl, ...inputs.cutoutDataUrls],
        prompt,
        budget,
      });
      const format = detectImageFormat(raw);
      const uploaded = await put(`renders/${crypto.randomUUID()}.${format.ext}`, raw, {
        access: "public",
        contentType: format.contentType,
        addRandomSuffix: false,
      });
      const secondDataUrl = `data:${format.contentType};base64,${raw.toString("base64")}`;
      const second = await verifyRender({
        renderDataUrl: secondDataUrl,
        referenceUrls: inputs.cutoutDataUrls,
        budget,
      });
      const secondDecision = decideVerification(second.garments_match, second.invented_items, 1);
      console.log(
        `render-verify attempt=1 garments_match=${second.garments_match ? 1 : 0} ` +
          `invented_names=[${inventedNames(second.invented_items)}] avatar=${version} decision=${secondDecision}`,
      );
      finalUrl = uploaded.url;
      finalVerified = secondDecision === "pass";
      invented = second.invented_items;
    }

    const record: RenderRecord = { url: finalUrl, verified: finalVerified, invented };
    await writeCache(key, record);
    console.log(`render-verify ms=${routeMs()} verified=${finalVerified ? 1 : 0} avatar=${version}`);
    return NextResponse.json({ url: finalUrl, cached: false, verified: finalVerified, invented });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verify failed.";
    if (/content_policy_violation/i.test(message)) {
      console.log(`render-verify error=content-policy route_ms=${routeMs()}`);
      return NextResponse.json({ url: null, verified: false, invented: [] }, { status: 200 });
    }
    if (isOutageError(err)) {
      console.log(`render-verify error=outage detail=${JSON.stringify(message.slice(0, 200))} route_ms=${routeMs()}`);
      return NextResponse.json(
        { error: META_HICCUP_MESSAGE, code: META_UNAVAILABLE_CODE },
        { status: 500 },
      );
    }
    console.log(`render-verify error=${JSON.stringify(message.slice(0, 200))} route_ms=${routeMs()}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
