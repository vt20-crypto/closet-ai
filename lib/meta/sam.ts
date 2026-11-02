import "server-only";

import {
  decodeMaskToRaster,
  parseImageStream,
  recordsOfKind,
  type SegmentationMask,
} from "@meta-sam/parser";

import { getMetaClient } from "./client";

/**
 * Specific garment nouns, one per SAM request. Generic phrases ("clothing")
 * fragment into dozens of junk masks (spike 06), so don't add any here.
 */
export const GARMENT_NOUNS = [
  "shirt",
  "t-shirt",
  "pants",
  "jeans",
  "shorts",
  "skirt",
  "dress",
  "jacket",
  "sweater",
  "hoodie",
  "coat",
  "shoe",
  "sneaker",
  "boot",
] as const;

export type GarmentNoun = (typeof GARMENT_NOUNS)[number];

/** Half-open source-pixel box: [left, right) x [top, bottom). */
export interface PixelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GarmentDetection {
  noun: string;
  box: PixelBox;
  confidence: number;
  mask: SegmentationMask;
}

interface WireEvent {
  type?: string;
  item_id?: unknown;
  output_index?: unknown;
  content_index?: unknown;
  part?: { type?: unknown; text?: unknown } | null;
}

// Stream-event shim adapted from Meta's MIT-licensed cookbook:
//   https://github.com/meta-models/meta-model-cookbook/tree/main/07_sam/01_api_basics
//   (typescript/sam-api.ts, typescript/02-upload-and-segment-video.ts)
// The API streams `response.content_part.done` but not
// `response.output_text.done`, so the shim synthesizes the latter for the
// parser. Ported from spikes/common.ts (throwaway spike, same cookbook).
async function* normalizedEvents(stream: AsyncIterable<unknown>): AsyncIterable<WireEvent> {
  const completed = new Set<string>();
  for await (const raw of stream) {
    const event = raw as WireEvent;
    const lane = `${String(event.item_id)}:${String(event.output_index)}:${String(event.content_index)}`;
    if (event.type === "response.output_text.done") {
      if (!completed.has(lane)) {
        completed.add(lane);
        yield event;
      }
      continue;
    }
    yield event;
    if (
      event.type === "response.content_part.done" &&
      !completed.has(lane) &&
      event.part !== null &&
      typeof event.part === "object" &&
      event.part.type === "output_text" &&
      typeof event.part.text === "string"
    ) {
      completed.add(lane);
      yield {
        type: "response.output_text.done",
        item_id: event.item_id,
        output_index: event.output_index,
        content_index: event.content_index,
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(err: unknown, attempt: number): number | null {
  const status = (err as { status?: number })?.status;
  const retryable = status === 429 || (typeof status === "number" && status >= 500);
  if (!retryable) return null;
  const raw = (err as { headers?: unknown })?.headers;
  const get = (name: string): string | null => {
    if (!raw) return null;
    if (typeof (raw as Headers).get === "function") return (raw as Headers).get(name);
    const rec = raw as Record<string, unknown>;
    const v = rec[name] ?? rec[name.toLowerCase()];
    return typeof v === "string" ? v : null;
  };
  const retryAfter = get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  }
  return 500 * 2 ** attempt;
}

function clampBox(box: PixelBox, w: number, h: number): PixelBox | null {
  const left = Math.max(0, Math.min(w, Math.round(box.left)));
  const top = Math.max(0, Math.min(h, Math.round(box.top)));
  const right = Math.max(0, Math.min(w, Math.round(box.right)));
  const bottom = Math.max(0, Math.min(h, Math.round(box.bottom)));
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

function mimeFor(bytes: Buffer, url: string): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return "image/webp";
  if (/\.png(\?|$)/i.test(url)) return "image/png";
  if (/\.webp(\?|$)/i.test(url)) return "image/webp";
  return "image/jpeg";
}

export interface NounResult {
  noun: string;
  status: "ok" | "error";
  /** Short error code (HTTP status or failure kind). Absent on success. */
  code?: string;
  masks: number;
  detections: GarmentDetection[];
}

function errorCode(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") {
    const message = err instanceof Error ? err.message : "";
    const policy = /content_policy_violation/i.test(message) ? " content_policy_violation" : "";
    return `${status}${policy}`;
  }
  return err instanceof Error ? err.name : "unknown";
}

/** Segment one image (already fetched) for one noun. Never throws. */
export async function segmentBytes(
  bytes: Buffer,
  mime: string,
  noun: string,
  imageWidth: number,
  imageHeight: number,
): Promise<NounResult> {
  const api = getMetaClient();
  const failure = (err: unknown): NounResult => ({
    noun,
    status: "error",
    code: errorCode(err),
    masks: 0,
    detections: [],
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const stream = await api.responses.create({
        model: "sam-3.1",
        stream: true,
        metadata: { include_confidence: "true" },
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: noun },
              {
                type: "input_image",
                detail: "auto",
                image_url: `data:${mime};base64,${bytes.toString("base64")}`,
              },
            ],
          },
        ],
      });
      const result = await parseImageStream(
        normalizedEvents(stream as unknown as AsyncIterable<unknown>) as never,
      ).finalResult;
      if (result.outcome.status !== "completed") {
        return { noun, status: "error", code: `outcome_${result.outcome.status}`, masks: 0, detections: [] };
      }
      const boxes = recordsOfKind(result.records, "box");
      const masks = recordsOfKind(result.records, "mask");
      const out: GarmentDetection[] = [];
      for (const m of masks) {
        const paired = boxes.find((b) => b.objectId === m.objectId);
        const raw: PixelBox | undefined =
          m.bounds &&
          [m.bounds.left, m.bounds.top, m.bounds.right, m.bounds.bottom].every(
            (v) => typeof v === "number",
          )
            ? { left: m.bounds.left, top: m.bounds.top, right: m.bounds.right, bottom: m.bounds.bottom }
            : paired
              ? { left: paired.left, top: paired.top, right: paired.right, bottom: paired.bottom }
              : undefined;
        if (!raw) continue;
        const box = clampBox(raw, imageWidth, imageHeight);
        if (!box) continue;
        const confidence = m.confidence ?? paired?.confidence ?? 0;
        out.push({ noun, box, confidence, mask: m.mask });
      }
      return { noun, status: "ok", masks: masks.length, detections: out };
    } catch (err) {
      const status = (err as { status?: number })?.status;
      // The model declines some images; a 400 is final, not worth retrying.
      if (status === 400) return failure(err);
      const backoff = retryAfterMs(err, attempt);
      if (backoff !== null && attempt < 3) {
        await sleep(backoff);
        continue;
      }
      return failure(err);
    }
  }
  return { noun, status: "error", code: "retries_exhausted", masks: 0, detections: [] };
}

/** Fetch a photo URL to bytes. Throws on network failure. */
export async function fetchPhoto(photoUrl: string): Promise<{ bytes: Buffer; mime: string }> {
  const res = await fetch(photoUrl);
  if (!res.ok) throw new Error(`Could not fetch photo: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim();
  const mime =
    contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp"
      ? contentType
      : mimeFor(bytes, photoUrl);
  return { bytes, mime };
}

export interface GarmentSegmentation {
  detections: GarmentDetection[];
  results: NounResult[];
  /** True when every noun call errored: the scan tells the user to retry. */
  allErrored: boolean;
}

/**
 * Run garment nouns with capped concurrency (5 at a time: 14 at once
 * trips rate limits). Per-noun status is logged by the caller-visible
 * results; the whole call never throws for API errors.
 */
export async function segmentGarments(
  bytes: Buffer,
  mime: string,
  imageWidth: number,
  imageHeight: number,
  nouns: readonly string[] = GARMENT_NOUNS,
  concurrency = 5,
): Promise<GarmentSegmentation> {
  const results: NounResult[] = new Array(nouns.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, nouns.length)) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= nouns.length) return;
        const noun = nouns[index] as string;
        const t0 = performance.now();
        const result = await segmentBytes(bytes, mime, noun, imageWidth, imageHeight);
        results[index] = result;
        const ms = Math.round(performance.now() - t0);
        console.log(
          `sam noun=${noun} status=${result.status}` +
            (result.code ? ` code=${result.code}` : "") +
            ` masks=${result.masks} latency_ms=${ms}`,
        );
      }
    },
  );
  await Promise.all(workers);
  return {
    detections: results.flatMap((r) => r.detections),
    results,
    allErrored: results.length > 0 && results.every((r) => r.status === "error"),
  };
}

/** Validate that a decoded raster only contains 0/1 values. */
export function decodeRaster(mask: SegmentationMask): Uint8Array {
  return decodeMaskToRaster(mask);
}
