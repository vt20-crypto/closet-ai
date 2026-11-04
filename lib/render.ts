import { hashKey } from "./hash.ts";

/**
 * Pure avatar/render helpers: prompt building, cache keys, verification
 * decisions, and the Save-look object. No server imports, so node:test can
 * cover them.
 */

export type Vibe = "playful" | "minimal" | "edgy" | "classic";

const VIBE_POSE: Record<Vibe, { pose: string; expression: string }> = {
  playful: { pose: "relaxed dynamic pose, one hand in pocket", expression: "bright smile" },
  minimal: { pose: "neutral front-facing pose, arms at sides", expression: "calm expression" },
  edgy: { pose: "slightly angled pose, chin down", expression: "confident smirk" },
  classic: { pose: "straight front-facing pose", expression: "gentle smile" },
};

export interface AvatarPromptInput {
  height?: string | null;
  build?: string | null;
  hairNote?: string | null;
  vibe?: Vibe | null;
  /** One-line Spark appearance brief; never logged or stored, prompt-only. */
  appearance?: string | null;
}

/** Stylized-avatar prompt (proven shape: spike 08b + AGENTS.md). */
export function buildAvatarPrompt(input: AvatarPromptInput): string {
  const vibe = input.vibe && VIBE_POSE[input.vibe] ? VIBE_POSE[input.vibe] : VIBE_POSE.minimal;
  const traits = [
    input.height ? `${input.height} height` : null,
    input.build ? `${input.build} build` : null,
    input.hairNote ? `hair: ${input.hairNote}` : null,
  ].filter(Boolean);
  const likeness = input.appearance
    ? ` Preserve exact likeness: ${input.appearance}. Same skin tone, hairstyle, facial hair, glasses.`
    : ``;
  return (
    `Generate ONE stylized full-body character based on this person: fashion-illustration / ` +
    `3D-animated style, same face, skin tone, hair and build` +
    (traits.length > 0 ? ` (${traits.join(", ")})` : ``) +
    `, plain grey fitted base layer, ${vibe.pose}, ${vibe.expression}, ` +
    `plain neutral studio background.${likeness} A stylized character, NOT a store mannequin. ` +
    `Entire body head to feet visible.`
  );
}

/** Garment-only render prompt (AGENTS.md wording). */
export const RENDER_PROMPT =
  "Dress the person ONLY in the provided garment images. Do not add, invent or substitute " +
  "any clothing. Reference garments may have small missing areas; render them as complete, " +
  "continuous garments. Keep face, body and pose unchanged.";

/**
 * Bump when the render prompt changes: the version rides in the cache key,
 * so stale renders from an older prompt are never reused.
 */
export const RENDER_PROMPT_VERSION = 2;

/** Minimal tag view the fit describer needs (tags carry "n/a" when N/A). */
export interface FitTags {
  type: string;
  primary_color?: string | null;
  fit?: string | null;
  length?: string | null;
  rise?: string | null;
  sleeve?: string | null;
}

/** Fit value → silhouette phrase. Unknown/"n/a" values yield null (no claim). */
export function fitSilhouette(fit: string | null | undefined): string | null {
  switch ((fit ?? "").toLowerCase()) {
    case "skinny":
      return "skinny, tight to the leg";
    case "slim":
      return "slim, close through hip and thigh";
    case "straight":
      return "straight-leg, even width hip to ankle";
    case "regular":
      return "regular straight fit";
    case "relaxed":
      return "relaxed, easy through hip and thigh";
    case "loose":
      return "loose, draped with room";
    case "baggy":
      return "baggy, very loose through hip, thigh and leg, wide straight leg, fabric pooling at the ankle";
    case "wide-leg":
      return "wide-leg, flaring wide from the hip";
    case "bootcut":
      return "bootcut, fitted through thigh, flaring below the knee";
    case "flared":
      return "flared, fitted at the hip, widening to the hem";
    case "oversized":
      return "oversized, dropped shoulders, roomy body, extends past the hip";
    case "boxy":
      return "boxy, straight wide body with square shoulders";
    case "fitted":
      return "fitted, close to the body";
    case "bodycon":
      return "bodycon, tight to the body";
    case "a-line":
      return "a-line, fitted at the top, widening toward the hem";
    case "flowy":
      return "flowy, soft drape that moves away from the body";
    default:
      return null;
  }
}

/** Length value → phrase. Unknown/"n/a" yields null. */
export function lengthPhrase(length: string | null | undefined): string | null {
  switch ((length ?? "").toLowerCase()) {
    case "cropped":
      return "cropped above the ankle";
    case "longline":
      return "longline, extends past the hip";
    case "short":
      return "short";
    case "knee":
      return "knee length";
    case "midi":
      return "midi length";
    case "maxi":
      return "maxi length";
    case "ankle":
      return "ankle length";
    case "full":
      return "full length";
    default:
      return null;
  }
}

/** Rise value → phrase. Unknown/"n/a" yields null. */
export function risePhrase(rise: string | null | undefined): string | null {
  switch ((rise ?? "").toLowerCase()) {
    case "high":
      return "high-rise";
    case "mid":
      return "mid-rise";
    case "low":
      return "low-rise";
    default:
      return null;
  }
}

/** Sleeve value → phrase. Unknown/"n/a" yields null. */
export function sleevePhrase(sleeve: string | null | undefined): string | null {
  switch ((sleeve ?? "").toLowerCase()) {
    case "sleeveless":
      return "sleeveless";
    case "short":
      return "short sleeves";
    case "three-quarter":
      return "three-quarter sleeves";
    case "long":
      return "long sleeves";
    default:
      return null;
  }
}

/**
 * One garment line for render/verify prompts. The fit phrase comes FIRST,
 * then length/rise/sleeve, then color + type — text overrides the cutout.
 */
export function describeGarmentFit(tags: FitTags): string {
  const phrases = [
    fitSilhouette(tags.fit),
    risePhrase(tags.rise),
    sleevePhrase(tags.sleeve),
    lengthPhrase(tags.length),
  ].filter((phrase): phrase is string => phrase !== null);
  const name = [tags.primary_color, tags.type].filter(Boolean).join(" ");
  return phrases.length > 0 ? `${phrases.join("; ")} ${name}` : name;
}

/** Fit lines for every garment in a look (skips garments with no fit info). */
export function describeLookFits(garments: FitTags[]): string[] {
  return garments.map(describeGarmentFit);
}

/**
 * Full render prompt: base garment-only prompt + per-garment fit lines with
 * the fit-override instruction (cutouts are flat color/fabric references).
 */
export function buildRenderPrompt(garments: FitTags[]): string {
  if (garments.length === 0) return RENDER_PROMPT;
  const lines = describeLookFits(garments);
  return (
    `${RENDER_PROMPT}\nGarments in this look (wear each in EXACTLY this fit):\n` +
    lines.map((line) => `- ${line}`).join("\n") +
    "\nThe garment cutouts are flat references for color, fabric and details; " +
    "the FIT described in text overrides the cutout's apparent shape."
  );
}

/**
 * Verify prompt builder (pure; spark.ts sends it). Expected fits ride along
 * so a wrong fit on a provided garment is flaggable as a major item.
 */
export function buildVerifyPrompt(expectedFits: string[]): string {
  const base =
    "The first image is a composed try-on render; the following images are the reference " +
    "garment cutouts given to the image model. The avatar wears a plain neutral base layer, " +
    "and the render may show an undershirt, socks, or plain neutral shoes when the look " +
    "provides no shoes — those are expected, do NOT list them. Set garments_match=true as " +
    "long as every reference garment is worn in the right color, type and fit. List ONLY a " +
    "clearly different or extra visible garment, or a wrong color/type/fit of a provided " +
    "garment, in invented_items. Mark major=true when the item is a top, bottom, outerwear " +
    "or dress; otherwise major=false.";
  if (expectedFits.length === 0) return base;
  return (
    `${base}\nExpected fits (text overrides the cutouts' apparent shape):\n` +
    expectedFits.map((line) => `- ${line}`).join("\n") +
    "\nIf a provided top, bottom, outerwear or dress is worn in the wrong fit, list it as " +
    "a major invented item named like '<garment> looks <seen fit>, expected <fit>'."
  );
}

/**
 * Fit correction for the one re-render: when a major invented item names a
 * garment in this look, name its expected fit explicitly
 * ("make the jeans clearly baggy…"). Unmatched items yield no correction.
 */
export function fitCorrection(itemName: string, garments: FitTags[]): string | null {
  const lowered = itemName.toLowerCase();
  const match = garments.find(
    (garment) => garment.type && lowered.includes(garment.type.toLowerCase()),
  );
  if (!match) return null;
  const phrase = fitSilhouette(match.fit);
  if (!phrase) return null;
  const name = [match.primary_color, match.type].filter(Boolean).join(" ");
  return `Make the ${name} clearly ${phrase}.`;
}

export interface ImageFormat {
  ext: "png" | "webp" | "jpg";
  contentType: "image/png" | "image/webp" | "image/jpeg";
}

/**
 * Sniff PNG / WEBP / JPEG by magic bytes. Muse Image returns WEBP bytes
 * even when the request implies PNG, so storage extension, Blob content
 * type and data-URL mime must come from here, not from an assumption.
 * Unknown or truncated input falls back to PNG (the previous behavior).
 */
export function detectImageFormat(bytes: Buffer): ImageFormat {
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { ext: "webp", contentType: "image/webp" };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { ext: "png", contentType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", contentType: "image/jpeg" };
  }
  return { ext: "png", contentType: "image/png" };
}

/**
 * Cache key: prompt version + avatar version + sorted item ids
 * (order-independent) + the closet stamp (max updatedAt). An edit changes
 * the stamp, and a prompt bump changes the version, so stale renders for
 * that look never serve.
 */
export function renderCacheKey(avatarVersion: string, itemIds: string[], stamp = ""): string {
  return `renders/${hashKey([String(RENDER_PROMPT_VERSION), avatarVersion, ...[...itemIds].sort(), stamp].join("|"))}`;
}

export interface InventedItem {
  item: string;
  /** Top, bottom, outerwear or dress level — worth a re-render. */
  major: boolean;
}

export type VerifyDecision = "pass" | "rerender" | "accept";

/** Blob cache record for one look: first image, then verification fills in. */
export interface RenderRecord {
  url: string;
  verified: boolean;
  invented: InventedItem[];
}

/**
 * Pure verification decision. Expected base-layer bits (plain base layer,
 * undershirt, socks, neutral shoes when the look provides none) arrive as
 * major=false and never trigger a re-render. A mismatch, or any major
 * invented garment, re-renders once; anything after that is accepted as-is
 * (the first image already on screen stays).
 */
export function decideVerification(
  garmentsMatch: boolean,
  invented: InventedItem[],
  attempt: number,
): VerifyDecision {
  if (garmentsMatch && !invented.some((entry) => entry.major)) return "pass";
  return attempt <= 0 ? "rerender" : "accept";
}

export interface SavedLook {
  itemIds: string[];
  date: string | null;
  timeOfDay: string | null;
  place: string | null;
  renderUrl: string | null;
}

/** The Lookbook handoff object: date, time and place ride along. */
export function buildSavedLook(
  itemIds: string[],
  opts: { date?: string | null; timeOfDay?: string | null; place?: string | null; renderUrl?: string | null },
): SavedLook {
  return {
    itemIds: [...itemIds],
    date: opts.date ?? null,
    timeOfDay: opts.timeOfDay ?? null,
    place: opts.place ?? null,
    renderUrl: opts.renderUrl ?? null,
  };
}
