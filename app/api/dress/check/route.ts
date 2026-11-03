import { NextResponse } from "next/server";
import sharp from "sharp";

import { listItems, type ClosetItem } from "@/lib/closet";
import {
  createRetryBudget,
  isTransientModel404,
  META_HICCUP_MESSAGE,
  META_UNAVAILABLE_CODE,
} from "@/lib/meta/retry";
import { checkSnapshot, type DressCheckCandidate } from "@/lib/meta/spark";
import { slotForType } from "@/lib/outfits";

export const maxDuration = 60;

function candidate(item: ClosetItem): DressCheckCandidate {
  return {
    id: item.id,
    nickname: item.tags.nickname || `${item.tags.primary_color} ${item.tags.type}`,
    primary_color: item.tags.primary_color,
    distinguishing_note: item.tags.distinguishing_note ?? "",
    cutoutUrl: item.cutoutUrl,
  };
}

/**
 * Check one dressed step: multipart { snapshot: JPEG, targetId, outfitIds,
 * finalStep }. Compares the snapshot against the target cutout + up to 3
 * same-type closet items. Logs timings + verdict only, never images.
 */
export async function POST(req: Request) {
  const started = Date.now();
  // 25s retry budget inside the 60s route ceiling, like the other routes.
  const budget = createRetryBudget(started + 25_000);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Send a multipart snapshot upload." }, { status: 400 });
  }
  const file = form.get("snapshot");
  const targetId = form.get("targetId");
  const finalStep = form.get("finalStep") === "1";
  let outfitIds: unknown = [];
  try {
    outfitIds = JSON.parse(typeof form.get("outfitIds") === "string" ? (form.get("outfitIds") as string) : "[]");
  } catch {
    outfitIds = [];
  }
  if (!(file instanceof Blob) || typeof targetId !== "string" || !Array.isArray(outfitIds)) {
    return NextResponse.json({ error: "Fields: snapshot (photo), targetId, outfitIds." }, { status: 400 });
  }
  if (file.size === 0 || file.size > 4 * 1024 * 1024) {
    return NextResponse.json({ error: "Snapshot is empty or over ~4 MB." }, { status: 413 });
  }

  try {
    const items = await listItems();
    const byId = new Map(items.map((item) => [item.id, item]));
    const target = byId.get(targetId);
    if (!target) {
      return NextResponse.json({ error: "Unknown closet item." }, { status: 400 });
    }
    const slot = slotForType(target.tags.type);
    const others = items
      .filter((item) => item.id !== target.id && slotForType(item.tags.type) === slot)
      .sort((a, b) => candidate(a).nickname.localeCompare(candidate(b).nickname))
      .slice(0, 3);
    const bytes = Buffer.from(await file.arrayBuffer());
    let small: Buffer;
    try {
      small = await sharp(bytes)
        .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch {
      return NextResponse.json({ error: "Send a photo (JPEG or PNG)." }, { status: 400 });
    }
    const result = await checkSnapshot({
      snapshotJpeg: small,
      target: candidate(target),
      others: others.map(candidate),
      finalStep,
      budget,
    });
    // The model only ever names ids we sent; anything else becomes unsure.
    const validIds = new Set([target.id, ...others.map((o) => o.id)]);
    const verdict = result.matched_item_id && !validIds.has(result.matched_item_id) ? "unsure" : result.verdict;
    const say =
      verdict === result.verdict
        ? result.say
        : "I couldn't tell which item that is — try a closer or better-lit photo.";
    console.log(`dress check_ms=${Date.now() - started} verdict=${verdict} final=${finalStep ? 1 : 0}`);
    return NextResponse.json({ ...result, verdict, say });
  } catch (err) {
    // Only outage signatures become the friendly hiccup; 400/401 and other
    // failures surface with their real message (same rule as /api/outfits).
    const status = (err as { status?: number })?.status;
    const outage =
      isTransientModel404(err) || status === 429 || (typeof status === "number" && status >= 500);
    if (outage) {
      return NextResponse.json(
        { error: META_HICCUP_MESSAGE, code: META_UNAVAILABLE_CODE },
        { status: 500 },
      );
    }
    const message = err instanceof Error ? err.message : "Check failed.";
    console.log(`dress check error=${JSON.stringify(message.slice(0, 200))} route_ms=${Date.now() - started}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
