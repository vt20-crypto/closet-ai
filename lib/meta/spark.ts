import "server-only";

import type { RawOutfit } from "../outfits";
import type { DressState } from "../dress";
import {
  candidateContext,
  replanToolDefinitions,
  runAgentLoop,
  runReplanTool,
  type AgentTraceEntry,
  type AgentTurn,
  type ReplanCandidate,
  type ReplanContext,
} from "../dressAgent";

import { getMetaClient } from "./client";
import { hashKey, readCache, writeCache } from "../cache";
import {
  isModelDead,
  isTransientModel404,
  markModelDead,
  SPARK_MODELS,
  sleepWithinBudget,
  withModelFailover,
  type RetryBudget,
} from "./retry";
import { TAG_SCHEMA, type GarmentTags } from "./tagSchema";

export type { GarmentTags };



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
  // Own policy, separate from the pick: a dead id fails over immediately so
  // dress can never starve the pick; 429/5xx get one retry on the same id.
  // Any failure returns null so the caller skips the dress note.
  try {
    const { result: res } = await withModelFailover(
      "spark dress",
      async (model) => {
        let retried = false;
        for (;;) {
          try {
            return await api.responses.create(
              {
                model,
                reasoning: { effort: "low" },
                tools: [{ type: "web_search" }],
                input: `What is the dress code for "${venue}"? Answer in exactly one sentence.`,
              },
              { timeout: 10_000, maxRetries: 0 },
            );
          } catch (err) {
            if (isTransientModel404(err)) throw err;
            const status = (err as { status?: number })?.status;
            const retryable = status === 429 || (typeof status === "number" && status >= 500);
            if (!retryable || retried) throw err;
            retried = true;
            const raw = (err as { headers?: unknown })?.headers;
            const headerValue =
              raw && typeof (raw as Headers).get === "function"
                ? (raw as Headers).get("retry-after")
                : null;
            const secs = headerValue ? Number(headerValue) : NaN;
            const delay = Number.isFinite(secs) ? Math.max(0, secs * 1000) : 1000;
            if (budget && !(await sleepWithinBudget(delay, budget))) throw err;
            if (!budget) await sleep(delay);
          }
        }
      },
      budget,
    );
    const note = (res.output_text ?? "").trim();
    const urls = citationUrls(res.output);
    const out = { note: note || null, url: urls[0] ?? null, citations: urls.length };
    if (out.note) await writeCache(cachePath, out);
    return out;
  } catch {
    return null;
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
  /** e.g. "tomorrow (2026-11-05), evening"; null for today, any time. */
  whenLine: string | null;
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
          score: { type: "integer" },
        },
        required: ["item_ids", "reason", "weather_note", "score"],
        additionalProperties: false,
      },
    },
  },
  required: ["outfits"],
  additionalProperties: false,
} as const;

/**
 * Pick up to 6 ranked outfits from the compact closet list. No tools on
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
    `Pick up to 6 outfits from this closet, best first (never pad with filler; fewer good outfits beat six bad ones). Use ONLY these item ids, exactly as written:`,
    lines,
    input.weatherLine ? `Today's weather: ${input.weatherLine}.` : `No weather data; ignore weather.`,
    input.mood ? `Mood: ${input.mood}.` : `No mood given; pick something versatile.`,
    input.occasion ? `Occasion: ${input.occasion}.` : `No occasion given; pick everyday outfits.`,
  ];
  if (input.destination) parts.push(`Destination: ${input.destination}.`);
  if (input.dressCodeNote) parts.push(`Dress code to respect: ${input.dressCodeNote}`);
  if (input.whenLine) parts.push(`When: ${input.whenLine}.`);
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
      `reason is 20 words or fewer tying the outfit to the mood and occasion. ` +
      `score is 1-10 for style + weather + occasion fit, best first.`,
  );
  // "minimal" is the shortest documented reasoning pass
  // (dev.meta.ai/docs/reasoning). The pick is latency-critical.
  // Failover: a dead id rotates immediately (no backoff); 429/5xx rethrow
  // to the route's outage mapping, exactly as before.
  const { result: res } = await withModelFailover(
    "spark outfits",
    (model) =>
      api.responses.create({
        model,
        reasoning: { effort: "minimal" },
        input: parts.join("\n"),
        text: { format: { type: "json_schema", name: "outfits", strict: true, schema: OUTFIT_SCHEMA } },
      }),
    input.budget,
  );
  const parsed = JSON.parse(res.output_text ?? "") as { outfits?: RawOutfit[] };
  return Array.isArray(parsed.outfits) ? parsed.outfits.slice(0, 6) : [];
}

export interface VoiceSlots {
  mood: string | null;
  occasion: string | null;
  occasion_text: string | null;
  destination: string | null;
  city: string | null;
  date_text: string | null;
  time: string | null;
}

const VOICE_SCHEMA = {
  type: "object",
  properties: {
    mood: { type: ["string", "null"] },
    occasion: { type: ["string", "null"] },
    occasion_text: { type: ["string", "null"] },
    destination: { type: ["string", "null"] },
    city: { type: ["string", "null"] },
    date_text: { type: ["string", "null"] },
    time: { type: ["string", "null"] },
  },
  required: ["mood", "occasion", "occasion_text", "destination", "city", "date_text", "time"],
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
    `destination is a named venue or place; city is where they are or are going; ` +
    `date_text is any date reference (tomorrow, friday, june 3) or null; ` +
    `time is morning, afternoon, or evening when mentioned (breakfast/brunch map to morning, lunch to afternoon, dinner/drinks/night to evening), else null. ` +
    `Transcript: ${JSON.stringify(transcript.slice(0, 500))}`;
  const started = Date.now();
  const { result: res } = await withModelFailover(
    "spark voice",
    (model) =>
      api.responses.create({
        model,
        reasoning: { effort: "minimal" },
        input: prompt,
        text: { format: { type: "json_schema", name: "voice_slots", strict: true, schema: VOICE_SCHEMA } },
      }),
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
    date_text: str(parsed.date_text),
    time: str(parsed.time),
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
  let retriesBackoff = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    // Failover: skip breaker-dead ids; a 404 rotates immediately below.
    const model = SPARK_MODELS.find((m) => !isModelDead(m));
    if (!model) break;
    try {
      // "minimal" is the shortest documented reasoning pass
      // (dev.meta.ai/docs/reasoning); "none" 400s on Spark. Tagging is a
      // narrow classification call, so it gets the cheapest effort.
      const res = await api.responses.create({
        model,
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
      console.log(`spark tag model_used=${model}`);
      return { tags: JSON.parse(text) as GarmentTags, errored: false };
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 400 && /content_policy_violation/i.test(message)) {
        return { tags: rejected("content_policy_violation"), errored: false };
      }
      if (isTransientModel404(err)) {
        // Dead id: mark it for 90s and rotate immediately, no backoff.
        markModelDead(model);
        console.log(`spark tag model_dead=${model} failing over`);
        continue;
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

// --- Get-dressed agent ---

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["match", "wrong_item", "unsure"] },
    matched_item_id: { type: ["string", "null"] },
    say: { type: "string" },
    compliment: { type: "string" },
  },
  required: ["verdict", "matched_item_id", "say", "compliment"],
  additionalProperties: false,
} as const;

export interface DressCheckCandidate {
  id: string;
  nickname: string;
  primary_color: string;
  distinguishing_note: string;
  /** Public cutout URL, passed straight through as the reference image. */
  cutoutUrl: string;
}

export interface DressCheckInput {
  /** Snapshot JPEG bytes (route-resized to ≤1024px), inlined as a data URL. */
  snapshotJpeg: Buffer;
  target: DressCheckCandidate;
  /** Same-type closet items that are the likely confusions (up to 3). */
  others: DressCheckCandidate[];
  /** True when this is the outfit's last step (asks for a compliment). */
  finalStep: boolean;
  budget?: RetryBudget;
}

export interface DressCheckResult {
  verdict: "match" | "wrong_item" | "unsure";
  matched_item_id: string | null;
  say: string;
  compliment: string | null;
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length > maxWords ? words.slice(0, maxWords).join(" ") : text;
}

/**
 * Check a dressed step: Spark (low effort for accuracy — look-alikes are the
 * demo moment) compares the snapshot against the target cutout plus up to 3
 * same-type items. IDs are validated by the route against the closet.
 */
export async function checkSnapshot(input: DressCheckInput): Promise<DressCheckResult> {
  const api = getMetaClient();
  const describe = (c: DressCheckCandidate) =>
    `${c.id} ("${c.nickname}", ${c.primary_color}; tells apart by: ${c.distinguishing_note || "general look"})`;
  const prompt =
    `The user was asked to put on this item: ${describe(input.target)}. ` +
    `The images arrive in order: the target cutout, then same-type cutouts, then the snapshot photo LAST. ` +
    `The snapshot shows what they actually put on. ` +
    `Compare distinguishing details carefully: color shade, collar, buttons, print, pockets. ` +
    (input.others.length > 0
      ? `These same-type closet items are the likely confusions: ${input.others.map(describe).join(" | ")}. `
      : `No same-type alternatives exist in the closet. `) +
    `verdict is "match" if the snapshot shows the target, "wrong_item" if it shows one of the others, "unsure" if you cannot tell. ` +
    `matched_item_id is the shown item's id, or null when unsure. ` +
    `say (25 words or fewer, spoken aloud): for a match, confirm naming the item; ` +
    `for wrong_item, name which item it looks like AND the visible difference (e.g. different buttons); ` +
    `for unsure, ask for a closer or better-lit photo. ` +
    (input.finalStep
      ? `compliment is a one-line compliment for finishing the outfit.`
      : `compliment is an empty string.`);
  const references = [input.target, ...input.others].map((c) => ({
    type: "input_image" as const,
    detail: "auto" as const,
    image_url: c.cutoutUrl,
  }));
  const { result: res } = await withModelFailover(
    "spark dress check",
    (model) =>
      api.responses.create({
        model,
        // Accuracy over speed: look-alike tell-aparts are the demo moment.
        reasoning: { effort: "low" },
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              ...references,
              {
                type: "input_image",
                detail: "auto",
                image_url: `data:image/jpeg;base64,${input.snapshotJpeg.toString("base64")}`,
              },
            ],
          },
        ],
        text: { format: { type: "json_schema", name: "dress_check", strict: true, schema: CHECK_SCHEMA } },
      }),
    input.budget,
  );
  const parsed = JSON.parse(res.output_text ?? "") as Partial<DressCheckResult>;
  const verdict =
    parsed.verdict === "match" || parsed.verdict === "wrong_item" || parsed.verdict === "unsure"
      ? parsed.verdict
      : "unsure";
  return {
    verdict,
    matched_item_id: typeof parsed.matched_item_id === "string" ? parsed.matched_item_id : null,
    say: truncateWords(typeof parsed.say === "string" ? parsed.say : "I couldn't tell.", 25),
    compliment:
      input.finalStep && typeof parsed.compliment === "string" && parsed.compliment.trim()
        ? parsed.compliment.trim()
        : null,
  };
}

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    garments_match: { type: "boolean" },
    invented_items: { type: "array", items: { type: "string" } },
  },
  required: ["garments_match", "invented_items"],
  additionalProperties: false,
} as const;

export interface VerifyRenderInput {
  /** Data-URL PNG of the composed render (never logged). */
  renderDataUrl: string;
  /** Reference cutout URLs (public Blob URLs), in outfit order. */
  referenceUrls: string[];
  budget?: RetryBudget;
}

export interface VerifyRenderResult {
  garments_match: boolean;
  invented_items: string[];
}

/**
 * Render verification (spike 08c shape): the render first, then every
 * reference cutout. Runs through the Spark failover chain.
 */
export async function verifyRender(input: VerifyRenderInput): Promise<VerifyRenderResult> {
  const api = getMetaClient();
  const { result: res } = await withModelFailover(
    "spark verify",
    (model) =>
      api.responses.create({
        model,
        reasoning: { effort: "low" },
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "The first image is a composed try-on render; the following images are the reference " +
                  "garment cutouts given to the image model. Set garments_match=true ONLY if the person " +
                  "wears exactly the reference garments and no other clothing was added, invented or " +
                  "substituted. List any added/invented clothing in invented_items.",
              },
              { type: "input_image", detail: "auto", image_url: input.renderDataUrl },
              ...input.referenceUrls.map((image_url) => ({
                type: "input_image" as const,
                detail: "auto" as const,
                image_url,
              })),
            ],
          },
        ],
        text: { format: { type: "json_schema", name: "verify", strict: true, schema: VERIFY_SCHEMA } },
      }),
    input.budget,
  );
  const parsed = JSON.parse(res.output_text ?? "") as Partial<VerifyRenderResult>;
  const invented = Array.isArray(parsed.invented_items)
    ? parsed.invented_items.filter((item): item is string => typeof item === "string")
    : [];
  return { garments_match: parsed.garments_match === true, invented_items: invented };
}

export interface ReplanInput {
  items: ReplanCandidate[];
  state: DressState;
  transcript: string;
  weatherLine: string | null;
  budget?: RetryBudget;
}

export interface ReplanOutcome {
  say: string;
  state: DressState;
  trace: AgentTraceEntry[];
  steps: number;
  stopped: "done" | "cap" | "repeat";
}

function describeReplanState(state: DressState): string {
  const steps = state.steps
    .map((step, i) => `${i === state.index ? ">" : " "}${step.itemId}:${step.status}`)
    .join(" ");
  return `steps ${steps}; unavailable: ${state.unavailableIds.join(",") || "none"}`;
}

/**
 * Voice replan loop: the model reasons over the outfit state and calls tools;
 * every id the loop touches is validated by runReplanTool against the closet
 * items provided here. Cap 5 turns; same (tool, args) 3× stops the loop.
 */
export async function replanOutfit(input: ReplanInput): Promise<ReplanOutcome> {
  const api = getMetaClient();
  const tools = replanToolDefinitions();
  const systemPrompt =
    `You guide a low-vision user getting dressed, one item at a time. Current plan: ${describeReplanState(input.state)}. ` +
    `They just said: "${input.transcript}". ` +
    `Same-slot candidates (pick replacements ONLY from these ids):\n${candidateContext({ items: input.items, weatherLine: input.weatherLine, state: input.state })} ` +
    `Use get_outfit_state when unsure; swap_item(slot, item_id, reason) to change an item; ` +
    `mark_unavailable(item_id) for laundry/lost items; finish when they say done or the outfit is complete. ` +
    `Never invent item ids. Reply to the user in at most 2 short sentences (spoken aloud).`;
  let previousResponseId: string | undefined;
  let chainModel: string | undefined;
  const callTurn = async (
    outputs?: Array<{ callId: string; output: string }>,
  ): Promise<{ turn: AgentTurn; responseId: string }> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result: res }: { result: any } = await withModelFailover(
      "spark dress replan",
      async (model) => {
        // previous_response_id chains are model-specific: a failover to a
        // new id restarts the turn with the prompt plus tool results so far.
        const chained = !!previousResponseId && model === chainModel;
        const response = await api.responses.create(
          chained
            ? {
                model,
                reasoning: { effort: "low" },
                tools,
                previous_response_id: previousResponseId,
                input: (outputs ?? []).map((o) => ({
                  type: "function_call_output",
                  call_id: o.callId,
                  output: o.output,
                })),
              }
            : {
                model,
                reasoning: { effort: "low" },
                tools,
                input:
                  systemPrompt +
                  ((outputs ?? []).length > 0
                    ? `\nTool results so far: ${JSON.stringify(outputs)}. Continue the replan.`
                    : ""),
              },
        );
        chainModel = model;
        previousResponseId = response.id as string;
        return response as unknown;
      },
      input.budget,
    );
    previousResponseId = res.id as string;
    const found: Array<{ name: string; args: Record<string, unknown>; callId: string }> = [];
    for (const item of (res.output ?? []) as Array<{ type?: string }>) {
      if (item.type === "function_call") {
        const call = item as unknown as { name: string; arguments: string; call_id: string };
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        found.push({ name: call.name, args, callId: call.call_id });
      }
    }
    if (found.length > 0) return { turn: { kind: "tools", calls: found }, responseId: previousResponseId };
    return { turn: { kind: "text", text: res.output_text ?? "" }, responseId: previousResponseId };
  };

  let context: ReplanContext = { items: input.items, weatherLine: input.weatherLine, state: input.state };
  const outcome = await runAgentLoop({
    initialContext: context,
    firstTurn: async () => (await callTurn()).turn,
    nextTurn: async (outputs) => (await callTurn(outputs)).turn,
    onTool: async (name, args) => {
      const applied = runReplanTool(context, name, args);
      context = applied.context;
      return applied;
    },
  });
  return { say: outcome.say, state: outcome.context.state, trace: outcome.trace, steps: outcome.steps, stopped: outcome.stopped };
}
