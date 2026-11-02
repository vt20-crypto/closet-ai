import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import sharp from "sharp";

import { newId, putCandidatePng, saveCandidate } from "@/lib/closet";
import {
  buildUnionRaster,
  fillEnclosedHoles,
  filledAreaFraction,
  makeCutout,
} from "@/lib/cutout";
import {
  MIN_AREA_FRACTION,
  MIN_CONFIDENCE,
  dedupeDetections,
  mergeFootwearPairs,
  type FilterBox,
} from "@/lib/filters";
import { decodeRaster, fetchPhoto, segmentGarments } from "@/lib/meta/sam";
import { tagGarment } from "@/lib/meta/spark";

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
  let photoUrl = "";
  try {
    const body = (await request.json()) as { photoUrl?: unknown };
    photoUrl = typeof body.photoUrl === "string" ? body.photoUrl : "";
    if (!photoUrl.startsWith("https://")) {
      return NextResponse.json({ error: "photoUrl must be an https URL." }, { status: 400 });
    }

    const { bytes, mime } = await fetchPhoto(photoUrl);
    const meta = await sharp(bytes).metadata();
    const iw = meta.width ?? 0;
    const ih = meta.height ?? 0;
    if (iw <= 0 || ih <= 0) {
      return NextResponse.json({ error: "Could not read the photo dimensions." }, { status: 400 });
    }

    const tSam = performance.now();
    const raw = await segmentGarments(bytes, mime, iw, ih);
    const samMs = Math.round(performance.now() - tSam);

    // Filter 1+2: confidence >= 0.90 AND mask area >= 2% of the image.
    const confident = raw.filter((d) => d.confidence >= MIN_CONFIDENCE);
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

    const tCutout = performance.now();
    const cut = await Promise.all(
      units.map(async (u) => {
        try {
          const { png } = await makeCutout(bytes, iw, ih, u.box, u.raster, u.maskWidth, u.maskHeight);
          const id = newId();
          const cutoutUrl = await putCandidatePng(id, png);
          return { ...u, id, cutoutUrl };
        } catch {
          return null;
        }
      }),
    );
    const cutoutMs = Math.round(performance.now() - tCutout);

    const tTag = performance.now();
    const tagged = await Promise.all(
      cut
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map(async (c) => {
          const tags = await tagGarment(c.cutoutUrl, { isPair: c.isPair });
          return { ...c, tags };
        }),
    );
    const tagMs = Math.round(performance.now() - tTag);

    // Filter 5: Spark gate. Rejects are deleted so candidates/ holds no junk.
    const candidates = [];
    for (const c of tagged) {
      if (!c.tags.is_single_garment) {
        try {
          await del(c.cutoutUrl);
        } catch {
          // Best-effort cleanup; the orphan harms nothing.
        }
        continue;
      }
      const item = {
        id: c.id,
        cutoutUrl: c.cutoutUrl,
        nouns: c.nouns,
        confidence: c.confidence,
        box: c.box,
        tags: c.tags,
        photoUrl,
        createdAt: new Date().toISOString(),
      };
      await saveCandidate(item);
      candidates.push(item);
    }

    const totalMs = Math.round(performance.now() - tAll);
    console.log(
      `segment photo=${photoUrl.slice(0, 80)} sam_ms=${samMs} cutout_ms=${cutoutMs} ` +
        `tag_ms=${tagMs} total_ms=${totalMs} raw=${raw.length} ` +
        `confident=${confident.length} area=${withArea.length} units=${units.length} ` +
        `candidates=${candidates.length}`,
    );
    return NextResponse.json({ candidates });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Segmentation failed.";
    console.log(`segment photo=${photoUrl.slice(0, 80)} ERROR ${message.slice(0, 160)}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
