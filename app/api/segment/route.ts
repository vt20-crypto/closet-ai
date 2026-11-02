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
  let photoPathname = "";
  try {
    const body = (await request.json()) as { photoPathname?: unknown };
    photoPathname = typeof body.photoPathname === "string" ? body.photoPathname : "";
    if (!isPhotoPathname(photoPathname)) {
      return NextResponse.json(
        { error: "photoPathname must be a photo in our own store (photos/...)." },
        { status: 400 },
      );
    }

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

    const tSam = performance.now();
    const { detections: raw, allErrored } = await segmentGarments(bytes, mime, iw, ih);
    const samMs = Math.round(performance.now() - tSam);
    if (allErrored) {
      console.log(`segment photo=${photoPathname} sam_ms=${samMs} all_nouns_errored`);
      return NextResponse.json({ error: "Couldn't scan, try again." }, { status: 503 });
    }

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
          return { ...u, id, cutoutUrl, png };
        } catch {
          return null;
        }
      }),
    );
    const cutoutMs = Math.round(performance.now() - tCutout);

    // Filter 5: Spark gate. Tag the small flattened JPEG (fast); a tag-call
    // ERROR is retried once and then kept untagged for the user to judge —
    // never counted as a rejection. Gate rejections are kept too, shown
    // separately with their reason; the user is the final judge.
    const tTag = performance.now();
    const tagged = await Promise.all(
      cut
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map(async (c) => {
          const t0 = performance.now();
          let errored = true;
          let tags = null;
          try {
            const flat = await flattenForTag(c.png);
            const dataUrl = `data:image/jpeg;base64,${flat.toString("base64")}`;
            let result = await tagGarment(dataUrl, { isPair: c.isPair });
            if (result.errored) result = await tagGarment(dataUrl, { isPair: c.isPair });
            tags = result.errored ? null : result.tags;
            errored = result.errored;
          } catch {
            errored = true;
          }
          const ms = Math.round(performance.now() - t0);
          const single = tags ? String(tags.is_single_garment) : "untagged";
          const reason = tags?.rejection_reason?.replace(/\s+/g, " ") ?? "-";
          console.log(`tag id=${c.id} single=${single} reason=${reason} errored=${errored} tag_ms=${ms}`);
          return {
            id: c.id,
            cutoutUrl: c.cutoutUrl,
            nouns: c.nouns,
            confidence: c.confidence,
            box: c.box,
            tags,
          };
        }),
    );
    const tagMs = Math.round(performance.now() - tTag);

    const candidates = [];
    for (const c of tagged) {
      const item = {
        id: c.id,
        cutoutUrl: c.cutoutUrl,
        nouns: c.nouns,
        confidence: c.confidence,
        box: c.box,
        tags: c.tags,
        photoUrl,
        photoPathname,
        createdAt: new Date().toISOString(),
      };
      await saveCandidate(item);
      candidates.push(item);
    }

    const scanMeta = await recordScan(
      photoPathname,
      candidates.map((c) => c.id),
    );

    const totalMs = Math.round(performance.now() - tAll);
    console.log(
      `segment photo=${photoPathname} sam_ms=${samMs} cutout_ms=${cutoutMs} ` +
        `tag_ms=${tagMs} total_ms=${totalMs} raw=${raw.length} ` +
        `confident=${confident.length} area=${withArea.length} units=${units.length} ` +
        `candidates=${candidates.length}`,
    );
    return NextResponse.json({
      candidates,
      photo: {
        pathname: photoPathname,
        scannedAt: scanMeta.scannedAt,
        candidateCount: scanMeta.candidateIds.length,
        keptCount: scanMeta.keptIds.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Segmentation failed.";
    console.log(`segment photo=${photoPathname || "?"} ERROR ${message.slice(0, 160)}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
