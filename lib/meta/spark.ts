import "server-only";

import { getMetaClient } from "./client";

const MODEL = "muse-spark-1.3";

export interface GarmentTags {
  is_single_garment: boolean;
  rejection_reason: string | null;
  type: string;
  primary_color: string;
  secondary_colors: string[];
  formality: number;
  warmth: number;
  layer: "base" | "mid" | "outer";
  fabric_weight: string;
  pattern: string;
  seasons: string[];
  distinguishing_note: string;
}

// Strict JSON schema ported from spikes/07-spark-tag.ts (throwaway spike).
// With strict:true every object needs additionalProperties:false and all
// keys in required. Do NOT send response_format on Responses (it 400s).
const TAG_SCHEMA = {
  type: "object",
  properties: {
    is_single_garment: { type: "boolean" },
    rejection_reason: { type: ["string", "null"] },
    type: { type: "string" },
    primary_color: { type: "string" },
    secondary_colors: { type: "array", items: { type: "string" } },
    formality: { type: "integer" },
    warmth: { type: "integer" },
    layer: { type: "string", enum: ["base", "mid", "outer"] },
    fabric_weight: { type: "string" },
    pattern: { type: "string" },
    seasons: { type: "array", items: { type: "string" } },
    distinguishing_note: { type: "string" },
  },
  required: [
    "is_single_garment",
    "rejection_reason",
    "type",
    "primary_color",
    "secondary_colors",
    "formality",
    "warmth",
    "layer",
    "fabric_weight",
    "pattern",
    "seasons",
    "distinguishing_note",
  ],
  additionalProperties: false,
} as const;

const BASE_PROMPT =
  "This is a garment cutout on a transparent background (checkerboard = transparent, ignore it). " +
  "If the image is NOT one single whole garment — e.g. empty/transparent, a fragment, multiple " +
  "items, a non-garment object, or unrecognizable — set is_single_garment=false and say why in " +
  "rejection_reason (else null). Otherwise describe the garment. Formality and warmth are 1-5. " +
  "The distinguishing_note must name one visual detail that tells this item apart from similar ones.";

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
  };
}

/**
 * Tag one garment cutout with Spark (low reasoning effort, strict JSON).
 * The cutout URL is a public Blob URL, passed straight through as the image.
 * Never throws: 429s are retried with backoff from 500ms (honoring
 * Retry-After); a 400 content_policy_violation becomes a rejection.
 */
export async function tagGarment(
  cutoutUrl: string,
  opts?: { isPair?: boolean },
): Promise<GarmentTags> {
  const api = getMetaClient();
  const prompt = opts?.isPair ? BASE_PROMPT + PAIR_PROMPT : BASE_PROMPT;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await api.responses.create({
        model: MODEL,
        reasoning: { effort: "low" },
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", detail: "auto", image_url: cutoutUrl },
            ],
          },
        ],
        text: { format: { type: "json_schema", name: "tag", strict: true, schema: TAG_SCHEMA } },
      });
      const text = res.output_text ?? "";
      return JSON.parse(text) as GarmentTags;
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 400 && /content_policy_violation/i.test(message)) {
        return rejected("content_policy_violation");
      }
      if (status === 429 && attempt < 3) {
        const headers = (err as { headers?: unknown })?.headers;
        const headerValue =
          headers && typeof (headers as Headers).get === "function"
            ? (headers as Headers).get("retry-after")
            : null;
        const secs = headerValue ? Number(headerValue) : NaN;
        const backoff = Number.isFinite(secs) ? Math.max(0, secs * 1000) : 500 * 2 ** attempt;
        await sleep(backoff);
        continue;
      }
      return rejected(`tag_error: ${message.slice(0, 120)}`);
    }
  }
  return rejected("tag_retries_exhausted");
}
