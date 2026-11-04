import { NextResponse } from "next/server";
import { head } from "@vercel/blob";
import sharp from "sharp";

import { newId, putCandidatePng, saveCandidate } from "@/lib/closet";
import { isPhotoPathname, recordScan } from "@/lib/photos";
import {
  buildUnionRaster,
  fillEnclosedHoles,
  filledAreaFraction,
  flattenForTag,
  makeCutout,
} from "@/lib/cutout";
import {
  MIN_AREA_FRACTION,
  MIN_CONFIDENCE,
  dedupeDetections,
  mergeFootwearPairs,
  selectRescueDetections,
  type FilterBox,
} from "@/lib/filters";
import {
  createRetryBudget,
  isMetaApiError,
  META_HICCUP_MESSAGE,
  META_UNAVAILABLE_CODE,
} from "@/lib/meta/retry";
import { decodeRaster, fetchPhoto, segmentGarments } from "@/lib/meta/sam";
import { tagGarment, type GarmentTags } from "@/lib/meta/spark";

// Spike 01 saw a ~42s cold SAM call; 14 parallel nouns need headroom.
export const maxDuration = 120;
export const dynamic = "force-dynamic";

interface KeptUnit {
  nouns: string[];
  box: FilterBox;
  confidence: number;
  raster: Uint8Array;
  maskWidth: number;
  maskHeight: number;
  isPair: boolean;
}

export async function POST(request: Request) {
  const tAll = performance.now();
  let photoPathname = "";
  try {
    const body = (await request.json()) as { photoPathname?: unknown; parentPhoto?: unknown };
    photoPathname = typeof body.photoPathname === "string" ? body.photoPathname : "";
    if (!isPhotoPathname(photoPathname)) {
      return NextResponse.json(
        { error: "photoPathname must be a photo in our own store (photos/...)." },
        { status: 400 },
      );
    }
    const parentPhoto =
      typeof body.parentPhoto === "string" && isPhotoPathname(body.parentPhoto)
        ? body.parentPhoto
        : undefined;

    // Resolve the photo inside our own Blob store; never fetch arbitrary URLs.
    let photoUrl: string;
    try {
      const found = await head(photoPathname);
      photoUrl = found.url;
    } catch {
      return NextResponse.json({ error: "Photo not found in our store." }, { status: 404 });
    }

    const { bytes, mime } = await fetchPhoto(photoUrl);
    const meta = await sharp(bytes).metadata();
    const iw = meta.width ?? 0;
    const ih = meta.height ?? 0;
    if (iw <= 0 || ih <= 0) {
      return NextResponse.json({ error: "Could not read the photo dimensions." }, { status: 400 });
    }

    // One 40s retry budget shared by all nouns and tags in this scan:
    // retries ride out Meta 404 bursts without stalling the user.
    // Date.now-based: sleepWithinBudget compares against Date.now(), so a
    // performance.now() value here would silently disable every retry.
    const retryBudget = createRetryBudget(Date.now() + 40_000);
    const tSam = performance.now();
    const { detections: raw, allErrored, retried } = await segmentGarments(
      bytes, mime, iw, ih, undefined, undefined, retryBudget,
    );
    const samMs = Math.round(performance.now() - tSam);
    if (allErrored) {
      console.log(`segment photo=${photoPathname} sam_ms=${samMs} all_nouns_errored`);
      return NextResponse.json(
        { error: META_HICCUP_MESSAGE, code: META_UNAVAILABLE_CODE },
        { status: 503 },
      );
    }

    // Filter 1+2: confidence >= 0.60 AND mask area >= 2% of the image.
    // Rescue tier: when nothing passes, the Spark gate still judges the
    // best weak detections (>= 0.35, max 3) instead of an empty scan.
    let confident = raw.filter((d) => d.confidence >= MIN_CONFIDENCE);
    let rescued = false;
    if (confident.length === 0) {
      const fallback = selectRescueDetections(raw);
      if (fallback.length > 0) {
        confident = fallback;
        rescued = true;
      }
    }
    const withArea = confident.flatMap((d) => {
      try {
        const filled = fillEnclosedHoles(
          decodeRaster(d.mask),
          d.mask.width,
          d.mask.height,
        );
        const area = filledAreaFraction(filled, iw, ih);
        if (area < MIN_AREA_FRACTION) return [];
        return [{ det: d, filled, area }];
      } catch {
        return [];
      }
    });

    // Filter 3: dedupe overlapping detections across nouns (IoU > 0.6 keeps
    // the highest confidence). Carry the filled raster alongside.
    const deduped = dedupeDetections(
      withArea.map((w) => ({
        noun: w.det.noun,
        box: w.det.box,
        confidence: w.det.confidence,
        filled: w.filled,
        mw: w.det.mask.width,
        mh: w.det.mask.height,
      })),
    );
    // Filter 4: merge side-by-side footwear pairs into one item.
    const { merged, singles } = mergeFootwearPairs(deduped);
    const units: KeptUnit[] = [
      ...singles.map((s) => ({
        nouns: [s.noun],
        box: s.box,
        confidence: s.confidence,
        raster: s.filled,
        maskWidth: s.mw,
        maskHeight: s.mh,
        isPair: false,
      })),
      ...merged.map((m) => {
        const unionRaster = buildUnionRaster(
          m.sources.map((s) => ({ box: s.box, raster: s.filled, maskWidth: s.mw, maskHeight: s.mh })),
          m.box,
        );
        const uw = m.box.right - m.box.left;
        const uh = m.box.bottom - m.box.top;
        return {
          nouns: m.nouns,
          box: m.box,
          confidence: m.confidence,
          raster: fillEnclosedHoles(unionRaster, uw, uh),
          maskWidth: uw,
          maskHeight: uh,
          isPair: true,
        };
      }),
    ];

    // Progressive NDJSON stream: each cutout is sent the moment its PNG
    // is ready (the card shows "Tagging…"), then its tag event fills in
    // type/color. Rejections and untagged errors are kept for the user.
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        };
        try {
          // SAM already recovered from a hiccup mid-scan: tell the UI so it
          // can say so instead of leaving a bare spinner.
          if (retried) send({ event: "status", status: "retrying" });
          const saved: {
            id: string;
            cutoutUrl: string;
            nouns: string[];
            confidence: number;
            box: FilterBox;
            tags: GarmentTags | null;
          }[] = [];
          await Promise.all(
            units.map(async (u) => {
              let cutout: { id: string; cutoutUrl: string; png: Buffer } | null = null;
              try {
                const { png } = await makeCutout(bytes, iw, ih, u.box, u.raster, u.maskWidth, u.maskHeight);
                const id = newId();
                const cutoutUrl = await putCandidatePng(id, png);
                cutout = { id, cutoutUrl, png };
                send({
                  event: "cutout",
                  candidate: { id, cutoutUrl, nouns: u.nouns, confidence: u.confidence, photoPathname },
                });
              } catch {
                return;
              }
              // Filter 5: Spark gate on the small flattened JPEG. A tag-call
              // ERROR is retried once, then kept untagged — never a rejection.
              const t0 = performance.now();
              let errored = true;
              let tags: GarmentTags | null = null;
              try {
                const flat = await flattenForTag(cutout.png);
                const dataUrl = `data:image/jpeg;base64,${flat.toString("base64")}`;
                let result = await tagGarment(dataUrl, { isPair: u.isPair, budget: retryBudget });
                if (result.errored) {
                  result = await tagGarment(dataUrl, { isPair: u.isPair, budget: retryBudget });
                }
                tags = result.errored ? null : result.tags;
                errored = result.errored;
              } catch {
                errored = true;
              }
              const ms = Math.round(performance.now() - t0);
              const single = tags ? String(tags.is_single_garment) : "untagged";
              const reason = tags?.rejection_reason?.replace(/\s+/g, " ") ?? "-";
              console.log(`tag id=${cutout.id} single=${single} reason=${reason} errored=${errored} tag_ms=${ms}`);
              saved.push({
                id: cutout.id,
                cutoutUrl: cutout.cutoutUrl,
                nouns: u.nouns,
                confidence: u.confidence,
                box: u.box,
                tags,
              });
              send({ event: "tag", id: cutout.id, tags });
            }),
          );
          const createdAt = new Date().toISOString();
          for (const c of saved) {
            await saveCandidate({ ...c, photoUrl, photoPathname, createdAt });
          }
          const scanMeta = await recordScan(
            photoPathname,
            saved.map((c) => c.id),
            parentPhoto,
          );
          const totalMs = Math.round(performance.now() - tAll);
          console.log(
            `segment photo=${photoPathname} sam_ms=${samMs} total_ms=${totalMs} raw=${raw.length} ` +
              `confident=${confident.length} area=${withArea.length} units=${units.length} ` +
              `candidates=${saved.length} rescue=${rescued ? 1 : 0}` +
              (rescued ? ` rescue_conf=[${confident.map((d) => d.confidence.toFixed(2)).join(",")}]` : ""),
          );
          send({
            event: "done",
            photo: {
              pathname: photoPathname,
              scannedAt: scanMeta.scannedAt,
              candidateCount: scanMeta.candidateIds.length,
              keptCount: scanMeta.keptIds.length,
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Segmentation failed.";
          console.log(`segment photo=${photoPathname} ERROR ${message.slice(0, 160)}`);
          send({ event: "error", error: "Scan incomplete." });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Segmentation failed.";
    console.log(`segment photo=${photoPathname || "?"} ERROR ${message.slice(0, 160)}`);
    if (isMetaApiError(err)) {
      return NextResponse.json(
        { error: META_HICCUP_MESSAGE, code: META_UNAVAILABLE_CODE },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
