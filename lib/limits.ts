import type { BlobStore } from "./blobStore.ts";
import { writeJsonToStore } from "./blobStore.ts";

/**
 * Free-plan caps (docs/BUSINESS.md). Only avatar generations are enforced
 * server-side today; the rest are recorded here so the UI and future routes
 * share one source of truth.
 */
export const AVATAR_GENERATIONS_PER_WEEK = 3;
export const AVATAR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Demo override: AVATAR_WEEKLY_LIMIT env var replaces the default 3.
 * Non-numeric, fractional, zero and negative values fall back to 3.
 */
export function avatarWeeklyLimit(): number {
  const raw = process.env.AVATAR_WEEKLY_LIMIT;
  if (raw === undefined) return AVATAR_GENERATIONS_PER_WEEK;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return AVATAR_GENERATIONS_PER_WEEK;
  return parsed;
}
/** Cached renders are free; only fresh try-on renders count. */
export const RENDER_MAX_PER_DAY = 20;
export const DRESS_SESSIONS_MAX_PER_DAY = 3;

const USAGE_PATH = "usage/avatar-generations.json";

export interface AvatarAllowance {
  allowed: boolean;
  /** Generations left in the current rolling window. */
  remaining: number;
  /** ISO date the next generation frees up; null while allowed. */
  resetAt: string | null;
}

/** Rolling-window filter: keeps stamps after (now - window, now]. */
export function inAvatarWindow(now: number, generations: number[]): number[] {
  return generations
    .filter((t) => Number.isFinite(t) && t > now - AVATAR_WINDOW_MS && t <= now)
    .sort((a, b) => a - b);
}

/** Pure allowance math: `limit` generations per rolling 7 days. */
export function avatarAllowance(
  now: number,
  generations: number[],
  limit: number = avatarWeeklyLimit(),
): AvatarAllowance {
  const recent = inAvatarWindow(now, generations);
  const remaining = Math.max(0, limit - recent.length);
  if (remaining > 0) return { allowed: true, remaining, resetAt: null };
  const oldest = recent[0] ?? now;
  return { allowed: false, remaining: 0, resetAt: new Date(oldest + AVATAR_WINDOW_MS).toISOString() };
}

export async function readAvatarGenerations(store: BlobStore): Promise<number[]> {
  try {
    const entries = await store.listBlobs(USAGE_PATH);
    const blob = entries.find((entry) => entry.pathname === USAGE_PATH);
    if (!blob) return [];
    const data = await store.fetchJson<unknown>(blob.url);
    if (!Array.isArray(data)) return [];
    return data.filter((t): t is number => typeof t === "number");
  } catch {
    return [];
  }
}

export async function checkAvatarAllowance(store: BlobStore, now: number): Promise<AvatarAllowance> {
  return avatarAllowance(now, await readAvatarGenerations(store));
}

/** Record one generation (call only after success). Prunes old stamps. */
export async function recordAvatarGeneration(store: BlobStore, now: number): Promise<void> {
  const recent = inAvatarWindow(now, await readAvatarGenerations(store));
  recent.push(now);
  await writeJsonToStore(store, USAGE_PATH, recent);
}

/** "You can create a new avatar again on November 11." */
export function avatarLimitMessage(
  resetAt: string | null,
  limit: number = avatarWeeklyLimit(),
): string {
  if (!resetAt) return `You've used all ${limit} avatar generations for this week.`;
  const date = new Date(resetAt).toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return `You can create a new avatar again on ${date}.`;
}
