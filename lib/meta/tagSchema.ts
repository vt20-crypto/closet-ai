// Pure tag-schema module (no server-only import) so node:test can verify the
// strict JSON schema shape without pulling in the Meta client.

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
  /** Playful but accurate, at most 2 words (e.g. "Walkable", "Daily Levi's"). */
  nickname: string;
  /** Cut details: always present, "n/a" when the garment has no such axis. */
  fit: string;
  length: string;
  sleeve: string;
  rise: string;
}

/** Every fit axis value the tagger may emit, plus "n/a". */
export const FIT_VALUES = [
  "skinny",
  "slim",
  "regular",
  "straight",
  "relaxed",
  "loose",
  "baggy",
  "wide-leg",
  "bootcut",
  "flared",
  "oversized",
  "boxy",
  "fitted",
  "bodycon",
  "a-line",
  "flowy",
  "n/a",
] as const;

export const LENGTH_VALUES = [
  "cropped",
  "regular",
  "longline",
  "short",
  "knee",
  "midi",
  "maxi",
  "ankle",
  "full",
  "n/a",
] as const;

export const SLEEVE_VALUES = ["sleeveless", "short", "three-quarter", "long", "n/a"] as const;

export const RISE_VALUES = ["low", "mid", "high", "n/a"] as const;

type FitCategory =
  | "full-bottom"
  | "shorts"
  | "top"
  | "dress"
  | "skirt"
  | "jacket"
  | "shoes"
  | "other";

const BOTTOM_FITS = [
  "skinny",
  "slim",
  "regular",
  "straight",
  "relaxed",
  "loose",
  "baggy",
  "wide-leg",
  "bootcut",
  "flared",
] as const;

/**
 * Which fit-axis values are valid per garment category. Anything outside
 * (or any axis a category has no values for) normalizes to "n/a".
 */
const FIT_RULES: Record<
  FitCategory,
  { fit: readonly string[]; length: readonly string[]; sleeve: readonly string[]; rise: readonly string[] }
> = {
  "full-bottom": {
    fit: BOTTOM_FITS,
    length: ["ankle", "full", "cropped"],
    sleeve: [],
    rise: ["low", "mid", "high"],
  },
  shorts: {
    fit: ["slim", "regular", "relaxed", "loose"],
    length: ["short", "knee"],
    sleeve: [],
    rise: [],
  },
  top: {
    fit: ["slim", "regular", "relaxed", "oversized", "boxy"],
    length: ["cropped", "regular", "longline"],
    sleeve: ["sleeveless", "short", "three-quarter", "long"],
    rise: [],
  },
  dress: {
    fit: ["bodycon", "fitted", "a-line", "flowy"],
    length: ["short", "knee", "midi", "maxi"],
    sleeve: [],
    rise: [],
  },
  skirt: {
    fit: ["bodycon", "fitted", "a-line", "flowy"],
    length: ["short", "knee", "midi", "maxi"],
    sleeve: [],
    rise: [],
  },
  jacket: {
    fit: ["fitted", "regular", "oversized"],
    length: ["cropped", "regular", "longline"],
    sleeve: [],
    rise: [],
  },
  shoes: { fit: [], length: [], sleeve: [], rise: [] },
  other: { fit: [], length: [], sleeve: [], rise: [] },
};

/** Free-text type to fit category. Unrecognized and accessory types get "other". */
export function fitCategoryForType(type: string): FitCategory {
  const t = type.toLowerCase();
  if (/(sneaker|shoe|boot|sandal|heel|loafer|slipper|footwear)/.test(t)) return "shoes";
  if (/(hat|cap|beanie|scarf|belt|tie|purse|bag|glove|sunglass|watch|jewel)/.test(t)) return "other";
  if (t.includes("short")) return "shorts";
  if (t.includes("skirt")) return "skirt";
  if (t.includes("dress") || t.includes("gown")) return "dress";
  if (
    t.includes("jean") ||
    /(pants|trouser|chino|jogger|legging|sweatpant|cargo|corduroy)/.test(t)
  ) {
    return "full-bottom";
  }
  if (/(jacket|coat|blazer|vest|parka|windbreaker)/.test(t)) return "jacket";
  return "top";
}

function cleanAxis(value: unknown, allowed: readonly string[]): string {
  const clean = typeof value === "string" ? value.toLowerCase().trim() : "";
  if (clean === "n/a" || clean === "") return "n/a";
  return (allowed as readonly string[]).includes(clean) ? clean : "n/a";
}

export interface FitAxes {
  fit: string;
  length: string;
  sleeve: string;
  rise: string;
}

/** Server-side validation: anything invalid for the garment type becomes "n/a". */
export function normalizeFitTags(
  type: string,
  fit: unknown,
  length: unknown,
  sleeve: unknown,
  rise: unknown,
): FitAxes {
  const rules = FIT_RULES[fitCategoryForType(type)];
  return {
    fit: cleanAxis(fit, rules.fit),
    length: cleanAxis(length, rules.length),
    sleeve: cleanAxis(sleeve, rules.sleeve),
    rise: cleanAxis(rise, rules.rise),
  };
}

// Strict JSON schema ported from spikes/07-spark-tag.ts (throwaway spike).
// With strict:true every object needs additionalProperties:false and all
// keys in required. Do NOT send response_format on Responses (it 400s).
export const TAG_SCHEMA = {
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
    nickname: { type: "string" },
    fit: { type: "string", enum: [...FIT_VALUES] },
    length: { type: "string", enum: [...LENGTH_VALUES] },
    sleeve: { type: "string", enum: [...SLEEVE_VALUES] },
    rise: { type: "string", enum: [...RISE_VALUES] },
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
    "nickname",
    "fit",
    "length",
    "sleeve",
    "rise",
  ],
  additionalProperties: false,
} as const;
