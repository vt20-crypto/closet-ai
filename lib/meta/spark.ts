import "server-only";

import type { RawOutfit } from "../outfits";

import { getMetaClient } from "./client";
import { hashKey, readCache, writeCache } from "../cache";
import {
  isTransientModel404,
  sleepForTransient404,
  sleepWithinBudget,
  withTransient404Retry,
  type ModelRetryCounters,
  type RetryBudget,
} from "./retry";
import { TAG_SCHEMA, type GarmentTags } from "./tagSchema";

export type { GarmentTags };

const MODEL = "muse-spark-1.3";

const BASE_PROMPT =
  "This is a garment cutout on a transparent background (checkerboard = transparent, ignore it). " +
  "If the image is NOT one single whole garment — e.g. empty/transparent, a fragment, multiple " +
  "items, a non-garment object, or unrecognizable — set is_single_garment=false and say why in " +
  "rejection_reason (else null). Otherwise describe the garment. Formality and warmth are 1-5. " +
  "The distinguishing_note must name one visual detail that tells this item apart from similar ones. " +
  "The nickname is at most 2 words and 16 characters total, playful but accurate " +
  "(e.g. 'Walkable', \"Daily Levi's\").";

const PAIR_PROMPT =
  " This cutout may show a matched PAIR of shoes/boots side by side; if so, describe it as one " +
  "pair item (type should reflect a pair, e.g. 'sneakers') and mention the pair in distinguishing_note.";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rejected(reason: string): GarmentTags {
  return {
    is_single_garment: false,
    rejection_reason: reason,
    type: "unknown",
    primary_color: "unknown",
    secondary_colors: [],
    formality: 1,
    warmth: 1,
    layer: "base",
    fabric_weight: "unknown",
    pattern: "unknown",
    seasons: [],
    distinguishing_note: "",
    nickname: "",
  };
}

/**
 * Tag one garment cutout with Spark (low reasoning effort, strict JSON).
 * The cutout URL is a public Blob URL, passed straight through as the image.
 * Never throws: 429s are retried with backoff from 500ms (honoring
 * Retry-After); a 400 content_policy_violation becomes a rejection.
 */
export interface DressCodeNote {
  /** Null when the search ran fine but said nothing usable. */
  note: string | null;
  url: string | null;
  /** How many url_citation annotations the search response carried. */
  citations: number;
}

/**
 * Separate dress-code lookup, only for a named venue/event. One sentence back.
 * The source URL comes from the response's url_citation annotations, never
 * from model text; no citation means no link. 10s timeout; any failure
 * returns null so the caller skips it.
 */
const DRESS_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeVenue(venue: string): string {
  return venue.toLowerCase().trim().replace(/\s+/g, " ");
}

export async function fetchDressCode(
  venue: string,
  budget?: RetryBudget,
): Promise<DressCodeNote | null> {
  const normalized = normalizeVenue(venue);
  if (!normalized) return null;
  const cachePath = `dress/${hashKey(normalized)}`;
  const cached = await readCache<DressCodeNote>(cachePath, DRESS_TTL_MS);
  console.log(`dress cache=${cached.hit ? "hit" : "miss"}`);
  if (cached.hit && cached.data) return cached.data;
  const api = getMetaClient();
  // Own policy, separate from the pick: a 404 (outage signature) skips dress
  // immediately so it can never starve the pick; 429/5xx get one retry.
  // Any failure returns null so the caller skips the dress note.
  let retried = false;
  for (;;) {
    try {
      const res = await api.responses.create(
        {
          model: MODEL,
          reasoning: { effort: "low" },
          tools: [{ type: "web_search" }],
          input: `What is the dress code for "${venue}"? Answer in exactly one sentence.`,
        },
        { timeout: 10_000, maxRetries: 0 },
      );
      const note = (res.output_text ?? "").trim();
      const urls = citationUrls(res.output);
      const out = { note: note || null, url: urls[0] ?? null, citations: urls.length };
      if (out.note) await writeCache(cachePath, out);
      return out;
    } catch (err) {
      if (isTransientModel404(err)) return null;
      const status = (err as { status?: number })?.status;
      const retryable = status === 429 || (typeof status === "number" && status >= 500);
      if (retryable && !retried) {
        retried = true;
        const raw = (err as { headers?: unknown })?.headers;
        const headerValue =
          raw && typeof (raw as Headers).get === "function"
            ? (raw as Headers).get("retry-after")
            : null;
        const secs = headerValue ? Number(headerValue) : NaN;
        const delay = Number.isFinite(secs) ? Math.max(0, secs * 1000) : 1000;
        if (budget && !(await sleepWithinBudget(delay, budget))) return null;
        if (!budget) await sleep(delay);
        continue;
      }
      return null;
    }
  }
}

function citationUrls(output: unknown): string[] {
  const urls: string[] = [];
  if (!Array.isArray(output)) return urls;
  for (const item of output) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const annotations = (part as { annotations?: unknown }).annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        const cited = annotation as { type?: unknown; url?: unknown };
        if (
          cited.type === "url_citation" &&
          typeof cited.url === "string" &&
          cited.url.startsWith("http")
        ) {
          urls.push(cited.url);
        }
      }
    }
  }
  return urls;
}

export interface ClosetLine {
  id: string;
  type: string;
  primary_color: string;
  formality: number;
  warmth: number;
  layer: string;
}

export interface PickOutfitsInput {
  closet: ClosetLine[];
  weatherLine: string | null;
  mood: string | null;
  occasion: string | null;
  destination: string | null;
  dressCodeNote: string | null;
  excludeKeys: string[];
  retryProblems: string | null;
  /** Shared per-request retry deadline (never past route maxDuration - 5s). */
  budget?: RetryBudget;
}

// Strict JSON schema for the outfit pick (no tools on this call).
const OUTFIT_SCHEMA = {
  type: "object",
  properties: {
    outfits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
          weather_note: { type: "string" },
        },
        required: ["item_ids", "reason", "weather_note"],
        additionalProperties: false,
      },
    },
  },
  required: ["outfits"],
  additionalProperties: false,
} as const;

/**
 * Pick up to 9 ranked outfits from the compact closet list. No tools on
 * this call. Returns the raw proposals; the route validates every id
 * server-side.
 */
export async function pickOutfits(input: PickOutfitsInput): Promise<RawOutfit[]> {
  const api = getMetaClient();
  const lines = input.closet
    .map(
      (c) =>
        `${c.id} | ${c.type} | ${c.primary_color} | formality ${c.formality}/5 | warmth ${c.warmth}/5 | ${c.layer}`,
    )
    .join("\n");
  const parts = [
    `Pick up to 9 outfits from this closet, best first (never pad with filler; fewer good outfits beat nine bad ones). Use ONLY these item ids, exactly as written:`,
    lines,
    input.weatherLine ? `Today's weather: ${input.weatherLine}.` : `No weather data; ignore weather.`,
    input.mood ? `Mood: ${input.mood}.` : `No mood given; pick something versatile.`,
    input.occasion ? `Occasion: ${input.occasion}.` : `No occasion given; pick everyday outfits.`,
  ];
  if (input.destination) parts.push(`Destination: ${input.destination}.`);
  if (input.dressCodeNote) parts.push(`Dress code to respect: ${input.dressCodeNote}`);
  if (input.excludeKeys.length > 0) {
    parts.push(
      `Do NOT repeat these already-shown combinations (sorted id sets): ${input.excludeKeys.join("; ")}.`,
    );
  }
  if (input.retryProblems) {
    parts.push(`Your previous proposals were all invalid: ${input.retryProblems} Fix them.`);
  }
  parts.push(
    `Each outfit must be complete: top+bottom or a dress, plus shoes if the closet has any. ` +
      `Never use the same garment type twice except layered pieces. ` +
      `weather_note is one line of clothing advice for the weather WITHOUT temperature numbers (numbers render separately). ` +
      `reason is 20 words or fewer tying the outfit to the mood and occasion.`,
  );
  // "minimal" is the shortest documented reasoning pass
  // (dev.meta.ai/docs/reasoning). The pick is latency-critical.
  const res = await withTransient404Retry(
    "spark outfits",
    () =>
      api.responses.create({
        model: MODEL,
        reasoning: { effort: "minimal" },
        input: parts.join("\n"),
        text: { format: { type: "json_schema", name: "outfits", strict: true, schema: OUTFIT_SCHEMA } },
      }),
    undefined,
    input.budget,
  );
  const parsed = JSON.parse(res.output_text ?? "") as { outfits?: RawOutfit[] };
  return Array.isArray(parsed.outfits) ? parsed.outfits.slice(0, 9) : [];
}

export interface VoiceSlots {
  mood: string | null;
  occasion: string | null;
  occasion_text: string | null;
  destination: string | null;
  city: string | null;
}

const VOICE_SCHEMA = {
  type: "object",
  properties: {
    mood: { type: ["string", "null"] },
    occasion: { type: ["string", "null"] },
    occasion_text: { type: ["string", "null"] },
    destination: { type: ["string", "null"] },
    city: { type: ["string", "null"] },
  },
  required: ["mood", "occasion", "occasion_text", "destination", "city"],
  additionalProperties: false,
} as const;

/**
 * Map a voice transcript onto the /today form. Minimal effort, strict JSON;
 * every field is nullable and the caller decides what fills the form.
 * Never throws Meta errors raw — transient 404s retry, the rest propagate
 * for the route's meta_unavailable mapping.
 */
export async function parseVoiceSlots(
  transcript: string,
  opts?: { budget?: RetryBudget },
): Promise<VoiceSlots> {
  const api = getMetaClient();
  const prompt =
    `The user spoke to plan an outfit. Extract each slot or null when absent. ` +
    `mood is one word for how they want to feel ` +
    `(prefer: calm, confident, cozy, bold, lazy); occasion is one word for the event type ` +
    `(prefer: work, class, date, gym, party, errands, brunch, dinner); ` +
    `occasion_text is any extra detail; ` +
    `destination is a named venue or place; city is where they are or are going. ` +
    `Transcript: ${JSON.stringify(transcript.slice(0, 500))}`;
  const started = Date.now();
  const res = await withTransient404Retry(
    "spark voice",
    () =>
      api.responses.create({
        model: MODEL,
        reasoning: { effort: "minimal" },
        input: prompt,
        text: { format: { type: "json_schema", name: "voice_slots", strict: true, schema: VOICE_SCHEMA } },
      }),
    undefined,
    opts?.budget,
  );
  const parsed = JSON.parse(res.output_text ?? "") as Partial<VoiceSlots>;
  console.log(`spark voice_ms=${Date.now() - started}`);
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    mood: str(parsed.mood),
    occasion: str(parsed.occasion),
    occasion_text: str(parsed.occasion_text),
    destination: str(parsed.destination),
    city: str(parsed.city),
  };
}

export interface TagResult {
  tags: GarmentTags;
  /**
   * True when the tag CALL failed (network, rate-limit exhaustion, bad
   * payload) as opposed to the model judging the cutout. Callers retry once
   * on errored and, if it still fails, show the candidate untagged — an
   * error must never count as a rejection.
   */
  errored: boolean;
}

/**
 * Fallback tags for a candidate the tagger could never reach (kept only
 * because the user explicitly kept it). Honest about what is unknown; the
 * free-form type keeps it out of outfit completeness math.
 */
export function untaggedFallback(nouns: string[]): GarmentTags {
  return {
    is_single_garment: true,
    rejection_reason: null,
    type: nouns[0] ?? "garment",
    primary_color: "unknown",
    secondary_colors: [],
    formality: 3,
    warmth: 3,
    layer: "base",
    fabric_weight: "unknown",
    pattern: "unknown",
    seasons: [],
    distinguishing_note: "Kept without tags; tagging failed.",
    nickname: "",
  };
}

/**
 * Tag one garment cutout with Spark (low reasoning effort, strict JSON).
 * imageRef is a public URL or a data URL (small flattened JPEGs go inline).
 * Never throws: 429s are retried with backoff from 500ms (honoring
 * Retry-After); a 400 content_policy_violation becomes a rejection.
 */
export async function tagGarment(
  imageRef: string,
  opts?: { isPair?: boolean; budget?: RetryBudget },
): Promise<TagResult> {
  const api = getMetaClient();
  const prompt = opts?.isPair ? BASE_PROMPT + PAIR_PROMPT : BASE_PROMPT;
  const retryCounters: ModelRetryCounters = { retries404: 0 };
  let retriesBackoff = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      // "minimal" is the shortest documented reasoning pass
      // (dev.meta.ai/docs/reasoning); "none" 400s on Spark. Tagging is a
      // narrow classification call, so it gets the cheapest effort.
      const res = await api.responses.create({
        model: MODEL,
        reasoning: { effort: "minimal" },
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", detail: "auto", image_url: imageRef },
            ],
          },
        ],
        text: { format: { type: "json_schema", name: "tag", strict: true, schema: TAG_SCHEMA } },
      });
      const text = res.output_text ?? "";
      return { tags: JSON.parse(text) as GarmentTags, errored: false };
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 400 && /content_policy_violation/i.test(message)) {
        return { tags: rejected("content_policy_violation"), errored: false };
      }
      if (isTransientModel404(err)) {
        // Shared branch with every other Meta call path (see retry.ts).
        if (
          await sleepForTransient404({
            context: "spark tag",
            err,
            counters: retryCounters,
            budget: opts?.budget,
          })
        ) {
          continue;
        }
        return { tags: rejected(`tag_error: ${message.slice(0, 120)}`), errored: true };
      }
      if (status === 429 && retriesBackoff < 3) {
        const headers = (err as { headers?: unknown })?.headers;
        const headerValue =
          headers && typeof (headers as Headers).get === "function"
            ? (headers as Headers).get("retry-after")
            : null;
        const secs = headerValue ? Number(headerValue) : NaN;
        const backoff = Number.isFinite(secs) ? Math.max(0, secs * 1000) : 500 * 2 ** retriesBackoff;
        await sleep(backoff);
        retriesBackoff += 1;
        continue;
      }
      return { tags: rejected(`tag_error: ${message.slice(0, 120)}`), errored: true };
    }
  }
  return { tags: rejected("tag_retries_exhausted"), errored: true };
}
