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

/** Cache key: avatar version + sorted item ids (order-independent). */
export function renderCacheKey(avatarVersion: string, itemIds: string[]): string {
  return `renders/${hashKey([avatarVersion, ...[...itemIds].sort()].join("|"))}`;
}

export type VerifyDecision = "pass" | "rerender" | "fallback";

/**
 * Pure verification decision: match passes; the first failure re-renders
 * once naming the invented items; anything after that falls back to flat-lay.
 */
export function decideVerification(garmentsMatch: boolean, attempt: number): VerifyDecision {
  if (garmentsMatch) return "pass";
  return attempt <= 0 ? "rerender" : "fallback";
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
