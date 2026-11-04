import { normalizeFitTags, type GarmentTags } from "./meta/tagSchema.ts";

/** The tag fields the edit sheet may change. */
export type EditableTags = Pick<
  GarmentTags,
  "nickname" | "type" | "primary_color" | "fit" | "length" | "sleeve" | "rise" | "formality" | "warmth"
>;

const MAX_NICKNAME = 16;
const MAX_TYPE = 60;
const MAX_COLOR = 40;

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
}

function cleanInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

/**
 * Validate an edit-sheet body against the current tags. Axes re-normalize
 * against the merged type, so retagging jeans as a dress drops rise to n/a.
 * Returns the merged tags or a short user-facing error.
 */
export function validateItemEdit(
  body: Record<string, unknown>,
  current: EditableTags,
): { tags?: EditableTags; error?: string } {
  let nickname = current.nickname;
  if (body.nickname !== undefined) {
    const text = cleanText(body.nickname, MAX_NICKNAME);
    if (text === null || text.split(/\s+/).length > 2) {
      return { error: "Nicknames are at most 2 words and 16 characters." };
    }
    nickname = text;
  }
  let type = current.type;
  if (body.type !== undefined) {
    const text = cleanText(body.type, MAX_TYPE);
    if (text === null) return { error: "Type needs 1–60 characters." };
    type = text;
  }
  let primaryColor = current.primary_color;
  if (body.primary_color !== undefined) {
    const text = cleanText(body.primary_color, MAX_COLOR);
    if (text === null) return { error: "Color needs 1–40 characters." };
    primaryColor = text;
  }
  let formality = current.formality;
  if (body.formality !== undefined) {
    const value = cleanInt(body.formality);
    if (value === null) return { error: "Formality is 1–5." };
    formality = value;
  }
  let warmth = current.warmth;
  if (body.warmth !== undefined) {
    const value = cleanInt(body.warmth);
    if (value === null) return { error: "Warmth is 1–5." };
    warmth = value;
  }
  for (const axis of ["fit", "length", "sleeve", "rise"] as const) {
    const value = body[axis];
    if (value !== undefined && typeof value !== "string") {
      return { error: `${axis} must be text.` };
    }
  }
  const axes = normalizeFitTags(
    type,
    body.fit ?? current.fit,
    body.length ?? current.length,
    body.sleeve ?? current.sleeve,
    body.rise ?? current.rise,
  );
  return { tags: { nickname, type, primary_color: primaryColor, ...axes, formality, warmth } };
}
