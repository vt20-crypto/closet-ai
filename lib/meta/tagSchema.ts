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
  ],
  additionalProperties: false,
} as const;
