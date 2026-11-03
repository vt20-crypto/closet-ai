import {
  normalizeOutfitType,
  outfitKey,
  validateOutfits,
  type OutfitCategory,
} from "./outfits.ts";

/**
 * Rule-based fallback when the Spark pick fails (Meta outage). Deterministic,
 * unit-tested, and honest: the route marks these source:"rules" and the UI
 * tapes them "Quick pick, AI unavailable". Never presented as model output.
 */

export interface FallbackTags {
  type: string;
  primary_color: string;
  formality: number;
  warmth: number;
  layer: string;
  pattern: string;
  nickname?: string;
}

export interface FallbackItem {
  id: string;
  tags: FallbackTags;
}

export interface FallbackWeather {
  highC: number;
  lowC: number;
}

export interface FallbackOutfit {
  item_ids: string[];
  reason: string;
}

const OCCASION_FORMALITY: Record<string, number> = {
  work: 4,
  date: 4,
  party: 4,
  class: 2,
  gym: 1,
  errands: 2,
  brunch: 3,
  dinner: 4,
};

/** Cold enough that an outer layer and warm picks win. */
const COLD_LOW_C = 12;
/** Hot enough that the coolest picks win. */
const HOT_HIGH_C = 24;

function isPatterned(pattern: string): boolean {
  const p = pattern.toLowerCase();
  return p !== "" && p !== "solid" && p !== "unknown";
}

function labelFor(tags: FallbackTags): string {
  const nick = (tags.nickname ?? "").trim();
  if (nick) return nick;
  return `${tags.primary_color} ${tags.type}`.trim();
}

function formalityWord(target: number): string {
  if (target <= 1) return "sporty";
  if (target <= 2) return "casual";
  if (target <= 3) return "smart-casual";
  if (target <= 4) return "dressy";
  return "formal";
}

function scoreItem(tags: FallbackTags, slot: OutfitCategory, target: number, cold: boolean, hot: boolean): number {
  let score = Math.abs(tags.formality - target) * 10;
  if (cold) score += (5 - tags.warmth) * 4;
  if (hot) score += tags.warmth * 4;
  return score;
}

/** FNV-1a hash: string seed → uint32. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG: deterministic per seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic shuffle: same seed → same order, so Shuffle varies by seed. */
export function seededShuffle<T>(arr: T[], seed: string): T[] {
  const out = [...arr];
  const rand = mulberry32(hashSeed(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Up to 3 complete outfits from ALL closet slots (no per-slot caps).
 * Candidates are scored, validated, then seeded-shuffled so each Shuffle
 * (seed = date + exclude count) surfaces new combos. Skips a second
 * patterned piece (color-clash rule).
 */
export function fallbackOutfits(
  items: FallbackItem[],
  weather: FallbackWeather,
  mood: string | null,
  occasion: string | null,
  excludeKeys: string[] = [],
  seed = "",
): FallbackOutfit[] {
  const target = (occasion && OCCASION_FORMALITY[occasion.toLowerCase()]) || 3;
  const cold = weather.lowC < COLD_LOW_C;
  const hot = weather.highC > HOT_HIGH_C;
  const excluded = new Set(excludeKeys);

  const bySlot = new Map<OutfitCategory, FallbackItem[]>();
  for (const item of [...items].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const slot = normalizeOutfitType(item.tags.type);
    const list = bySlot.get(slot) ?? [];
    list.push(item);
    bySlot.set(slot, list);
  }
  const ranked = (slot: OutfitCategory): FallbackItem[] =>
    [...(bySlot.get(slot) ?? [])].sort(
      (a, b) => scoreItem(a.tags, slot, target, cold, hot) - scoreItem(b.tags, slot, target, cold, hot),
    );

  const tops = ranked("top");
  const bottoms = ranked("bottom");
  const dresses = ranked("dress");
  const shoes = ranked("shoes").slice(0, 1);
  const outers = cold ? ranked("outer").slice(0, 1) : [];

  const combos: string[][] = [];
  for (const t of tops) {
    for (const b of bottoms) {
      if (isPatterned(t.tags.pattern) && isPatterned(b.tags.pattern)) continue;
      combos.push([t.id, b.id, ...shoes.map((s) => s.id), ...outers.map((o) => o.id)]);
    }
  }
  for (const d of dresses) {
    combos.push([d.id, ...shoes.map((s) => s.id), ...outers.map((o) => o.id)]);
  }

  const occasionWord = occasion ?? "everyday";
  const weatherNote = cold
    ? `Warm layers for a ${Math.round(weather.lowC)}°C low.`
    : hot
      ? `Light picks for a ${Math.round(weather.highC)}°C high.`
      : `Good for ${Math.round(weather.lowC)}–${Math.round(weather.highC)}°C.`;
  const moodBit = mood ? ` A ${mood} ${formalityWord(target)} pick.` : "";

  const candidates: string[][] = [];
  for (const ids of combos) {
    const key = outfitKey(ids);
    if (excluded.has(key)) continue;
    const { valid } = validateOutfits({
      items: items.map((i) => ({ id: i.id, tags: { type: i.tags.type, layer: i.tags.layer } })),
      raw: [{ item_ids: ids, reason: "", weather_note: "" }],
      excludeKeys: new Set<string>(),
    });
    if (valid.length === 0) continue;
    candidates.push(ids);
  }
  return seededShuffle(candidates, seed)
    .slice(0, 3)
    .map((ids) => {
      const names = ids.map((id) => {
        const found = items.find((i) => i.id === id);
        return found ? labelFor(found.tags) : "an item";
      });
      return {
        item_ids: ids,
        reason: `Rule pick for ${occasionWord}: ${names.join(" + ")}.${moodBit} ${weatherNote}`,
      };
    });
}
