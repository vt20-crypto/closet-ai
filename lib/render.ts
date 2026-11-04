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
}

/** Stylized-avatar prompt (proven shape: spike 08b + AGENTS.md). */
export function buildAvatarPrompt(input: AvatarPromptInput): string {
  const vibe = input.vibe && VIBE_POSE[input.vibe] ? VIBE_POSE[input.vibe] : VIBE_POSE.minimal;
  const traits = [
    input.height ? `${input.height} height` : null,
    input.build ? `${input.build} build` : null,
    input.hairNote ? `hair: ${input.hairNote}` : null,
  ].filter(Boolean);
  return (
    `Generate ONE stylized full-body character based on this person: fashion-illustration / ` +
    `3D-animated style, same face, skin tone, hair and build` +
    (traits.length > 0 ? ` (${traits.join(", ")})` : ``) +
    `, plain grey fitted base layer, ${vibe.pose}, ${vibe.expression}, ` +
    `plain neutral studio background. A stylized character, NOT a store mannequin. ` +
    `Entire body head to feet visible.`
  );
}

/** Garment-only render prompt (AGENTS.md wording). */
export const RENDER_PROMPT =
  "Dress the person ONLY in the provided garment images. Do not add, invent or substitute " +
  "any clothing. Reference garments may have small missing areas; render them as complete, " +
  "continuous garments. Keep face, body and pose unchanged.";

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

/** Cache key: avatar version + sorted item ids (order-independent). */
export function renderCacheKey(avatarVersion: string, itemIds: string[]): string {
  return `renders/${hashKey([avatarVersion, ...[...itemIds].sort()].join("|"))}`;
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
