import { hashKey } from "./hash.ts";
import { tapeLabel } from "./labels.ts";
import {
  isBaseTopType,
  isLayerType,
  isMidLayerType,
  isOuterType,
  midAllowedOver,
  normalizeOutfitType,
  outfitKey,
} from "./outfits.ts";

/**
 * Deterministic styling engine: enumerates complete outfits from the closet,
 * hard-filters them, and scores the survivors with weighted style rules.
 * The top candidates go to Spark, which picks and ranks as final stylist.
 * Pure (no I/O): fully unit-tested.
 */

export interface RuleItem {
  id: string;
  type: string;
  primary_color: string;
  secondary_colors: string[];
  formality: number;
  warmth: number;
  layer: string;
  fabric_weight: string;
  pattern: string;
  nickname: string;
  distinguishing_note: string;
  fit?: string | null;
  length?: string | null;
  sleeve?: string | null;
  rise?: string | null;
}

export interface StyleProfile {
  style?: string | null;
  undertone?: "warm" | "cool" | "neutral" | "not sure" | null;
  strictness?: "relaxed" | "standard" | "conservative" | null;
}

export interface StyleWeather {
  highC: number;
  lowC: number;
  precipPct: number;
  /** Percent; 0 when the provider omits it (hot+humid rule simply skips). */
  humidityPct: number;
}

export type OccasionBucket =
  | "gym"
  | "travel"
  | "brunch"
  | "casual-date"
  | "party"
  | "office"
  | "interview"
  | "wedding"
  | "casual";

/** Formality ranges per occasion bucket, inclusive. */
export const OCCASION_RANGES: Record<OccasionBucket, [number, number]> = {
  gym: [1, 1],
  travel: [1, 2],
  brunch: [2, 3],
  "casual-date": [2, 3],
  party: [2, 4],
  office: [3, 4],
  interview: [4, 5],
  wedding: [3, 5],
  casual: [1, 3],
};

const CHIP_OCCASIONS: Record<string, OccasionBucket> = {
  gym: "gym",
  work: "office",
  date: "casual-date",
  "date night": "casual-date",
  party: "party",
  brunch: "brunch",
  dinner: "casual-date",
  class: "casual",
  errands: "casual",
  casual: "casual",
};

const TEXT_OCCASIONS: Array<[RegExp, OccasionBucket]> = [
  [/interview|job\b|hiring/, "interview"],
  [/wedding|bride|groom/, "wedding"],
  [/travel|flight|airport|trip|vacation/, "travel"],
  [/gym|workout|run\b|yoga|sport/, "gym"],
  [/party|club|concert|birthday/, "party"],
  [/brunch/, "brunch"],
  [/date|dinner|romantic|anniversary/, "casual-date"],
  [/office|work|meeting|conference|presentation/, "office"],
  [/class|school|lecture|campus/, "casual"],
  [/errand|grocery|shopping/, "casual"],
];

/** Free-text keywords win over the chip; unknown falls back to casual. */
export function resolveOccasion(chip: string | null, text: string | null): OccasionBucket {
  const hay = `${chip ?? ""} ${text ?? ""}`.toLowerCase();
  for (const [pattern, bucket] of TEXT_OCCASIONS) {
    if (pattern.test(hay)) return bucket;
  }
  if (chip) {
    const mapped = CHIP_OCCASIONS[chip.toLowerCase()];
    if (mapped) return mapped;
  }
  return "casual";
}

/** Every soft score weighs into the total; the weights sum to 1. */
export const STYLE_WEIGHTS = {
  color: 0.22,
  proportion: 0.13,
  pattern: 0.1,
  mood: 0.14,
  rotation: 0.08,
  undertone: 0.05,
  climate: 0.1,
  modesty: 0.08,
  feedback: 0.1,
} as const;

/** Target warmth sums (shoes excluded) by daytime high, from cold to hot. */
export function warmthBand(highC: number): [number, number] {
  if (highC >= 28) return [3, 7];
  if (highC >= 20) return [5, 9];
  if (highC >= 12) return [7, 12];
  if (highC >= 5) return [10, 15];
  return [12, 99];
}

/** RAIN_PCT or more means the outfit needs an outer layer. */
export const RAIN_PCT = 40;
export const COLD_LOW_C = 5;

const NEUTRALS = new Set([
  "black",
  "white",
  "grey",
  "gray",
  "navy",
  "beige",
  "camel",
  "stone",
  "cream",
  "brown",
  "olive",
  "denim",
]);

const HUE_WORDS: Record<string, string> = {
  red: "red",
  crimson: "red",
  burgundy: "red",
  maroon: "red",
  scarlet: "red",
  wine: "red",
  orange: "orange",
  coral: "orange",
  peach: "orange",
  rust: "orange",
  terracotta: "orange",
  yellow: "yellow",
  mustard: "yellow",
  gold: "yellow",
  green: "green",
  emerald: "green",
  sage: "green",
  mint: "green",
  forest: "green",
  teal: "green",
  blue: "blue",
  sapphire: "blue",
  sky: "blue",
  cobalt: "blue",
  purple: "purple",
  lavender: "purple",
  lilac: "purple",
  plum: "purple",
  violet: "purple",
  pink: "pink",
  blush: "pink",
  rose: "pink",
  magenta: "pink",
  fuchsia: "pink",
};

/** Hue family of a free-text color, or null when neutral/unrecognized. */
export function colorFamily(color: string): string | null {
  const text = color.toLowerCase().trim();
  if (NEUTRALS.has(text)) return null;
  const tokens = text.split(/[^a-z]+/).filter(Boolean);
  for (const token of tokens) {
    const family = HUE_WORDS[token];
    if (family) return family;
  }
  return null;
}

/** Wheel order for analogous-hue checks (thevou 6-3-1 spirit). */
const WHEEL = ["red", "orange", "yellow", "green", "blue", "purple", "pink"];

function analogous(a: string, b: string): boolean {
  if (a === b) return true;
  const ia = WHEEL.indexOf(a);
  const ib = WHEEL.indexOf(b);
  if (ia === -1 || ib === -1) return false;
  const diff = Math.abs(ia - ib);
  return diff === 1 || diff === WHEEL.length - 1;
}

/** Vivid accent hues (denim/navy/olive stay out: too common to be a statement). */
const VIVID_HUES = new Set(["red", "orange", "yellow", "pink", "purple"]);

const BOLD_PATTERN_WORDS = [
  "graphic",
  "logo",
  "floral",
  "tropical",
  "camo",
  "animal",
  "leopard",
  "paisley",
  "tie-dye",
  "tiedye",
  "geometric",
  "abstract",
  "colorful",
  "large",
  "big",
];
const QUIET_PATTERN_WORDS = ["pinstripe", "micro", "small", "subtle", "tone", "mini", "fine"];

function patternText(pattern: string): string {
  return pattern.toLowerCase().trim();
}

/** Bold = an attention-grabbing print, not a classic solid/stripe. */
export function isBoldPattern(pattern: string): boolean {
  const text = patternText(pattern);
  if (text === "" || text === "solid" || text === "unknown") return false;
  if (QUIET_PATTERN_WORDS.some((word) => text.includes(word))) return false;
  return BOLD_PATTERN_WORDS.some((word) => text.includes(word));
}

/** Case-insensitive label for reasons: nickname, else "color type". */
export function itemLabel(item: Pick<RuleItem, "nickname" | "primary_color" | "type">): string {
  return tapeLabel(item);
}

export interface StyleContext {
  items: RuleItem[];
  weather: StyleWeather;
  occasion: OccasionBucket;
  mood: string | null;
  profile: StyleProfile;
  /** Pair key "idA|idB" (sorted) to averaged vote in [-1, 1]. */
  pairScores: Record<string, number>;
  /** Item id to days since last worn; absent means never/unlogged. */
  wearDays: Record<string, number>;
  /** Deterministic sampling seed (e.g. closet-version hash). */
  seed: string;
}

function categoryOf(item: RuleItem): string {
  return normalizeOutfitType(item.type);
}

function isShoe(item: RuleItem): boolean {
  return categoryOf(item) === "shoes";
}

/** Warmth sum, shoes excluded (footwear doesn't insulate the outfit). */
export function warmthSum(items: RuleItem[]): number {
  return items.filter((item) => !isShoe(item)).reduce((sum, item) => sum + item.warmth, 0);
}

/** Distance outside the band; 0 when inside. Shoes excluded from the sum. */
export function warmthDistance(items: RuleItem[], highC: number): number {
  const [lo, hi] = warmthBand(highC);
  const sum = warmthSum(items);
  if (sum < lo) return lo - sum;
  if (sum > hi) return sum - hi;
  return 0;
}

const SUEDE_HINTS = ["suede", "nubuck"];
const CANVAS_HINTS = ["canvas", "espadrille"];
const LIGHT_HINTS = ["white", "cream", "beige", "stone", "light", "pastel", "pink"];

function haystack(item: RuleItem): string {
  return `${item.type} ${item.nickname} ${item.distinguishing_note}`.toLowerCase();
}

/** Hard weather filter: band (3+ outside rejects), heavy coat in heat, no outer in cold/rain. */
export function failsWeather(items: RuleItem[], weather: StyleWeather): string | null {
  if (warmthDistance(items, weather.highC) >= 3) return "warmth outside the band";
  const heavyCoat = items.some(
    (item) => isOuterType(item.type) && item.warmth >= 4 && weather.highC > 24,
  );
  if (heavyCoat) return "heavy coat above 24C";
  const needsOuter = weather.lowC < COLD_LOW_C || weather.precipPct >= RAIN_PCT;
  if (needsOuter && !items.some((item) => isOuterType(item.type))) {
    return "no outer layer for cold or rain";
  }
  if (weather.precipPct >= RAIN_PCT) {
    const rainRisk = items.some((item) => {
      if (!isShoe(item)) return false;
      const text = haystack(item);
      if (SUEDE_HINTS.some((hint) => text.includes(hint))) return true;
      if (CANVAS_HINTS.some((hint) => text.includes(hint))) {
        const colors = `${item.primary_color} ${item.secondary_colors.join(" ")}`.toLowerCase();
        return LIGHT_HINTS.some((hint) => colors.includes(hint));
      }
      return false;
    });
    if (rainRisk) return "rain-risk shoes";
  }
  return null;
}

/** Hard formality filter: spread (outerwear excluded) over 2, or items 2+ outside the range. */
export function failsFormality(items: RuleItem[], range: [number, number]): string | null {
  const core = items.filter((item) => !isOuterType(item.type));
  const levels = core.map((item) => item.formality);
  if (levels.length > 1 && Math.max(...levels) - Math.min(...levels) > 2) {
    return "formality spread over 2";
  }
  const [lo, hi] = range;
  const outside = items.some((item) => {
    const distance = item.formality < lo ? lo - item.formality : item.formality > hi ? item.formality - hi : 0;
    return distance >= 2;
  });
  if (outside) return "item outside the occasion range";
  return null;
}

function isSneaker(item: RuleItem): boolean {
  return /sneaker|trainer|tennis/.test(item.type.toLowerCase());
}

function median(values: number[]): number {
  if (values.length === 0) return 3;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Hard shoe filter: formality clash with the outfit median, or sneakers at dressy occasions. */
export function failsShoes(items: RuleItem[], occasionHi: number): string | null {
  const shoes = items.filter(isShoe);
  if (shoes.length === 0) return null;
  const rest = items.filter((item) => !isShoe(item)).map((item) => item.formality);
  const mid = median(rest);
  if (shoes.some((shoe) => Math.abs(shoe.formality - mid) >= 2)) {
    return "shoe formality clashes with the outfit";
  }
  if (occasionHi >= 4 && shoes.some(isSneaker)) return "sneakers at a dressy occasion";
  return null;
}

function cleanType(type: string): string {
  return type.toLowerCase().replace(/[^a-z]/g, "");
}

/** Same cleaned type twice needs distinct layers (mirrors validateOutfits). */
function typeClash(ids: string[], byId: Map<string, RuleItem>): boolean {
  const seen = new Map<string, string[]>();
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) return true;
    const key = cleanType(item.type) || "unknown";
    const layers = seen.get(key) ?? [];
    layers.push(item.layer);
    seen.set(key, layers);
  }
  for (const layers of seen.values()) {
    if (layers.length > 1 && new Set(layers).size !== layers.length) return true;
  }
  return false;
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedInt(seed: string): number {
  return parseInt(hashKey(seed).slice(0, 8), 16);
}

/** Cap on enumerated combos before filtering; larger closets sample down. */
export const MAX_COMBOS = 400;

function* enumerateBases(
  tops: RuleItem[],
  bottoms: RuleItem[],
  dresses: RuleItem[],
  shoes: RuleItem[],
  mids: RuleItem[],
  outers: RuleItem[],
  layering: boolean,
  byId: Map<string, RuleItem>,
): Generator<string[]> {
  const shoeOptions: (string | null)[] = shoes.length > 0 ? shoes.map((s) => s.id) : [null];
  // Dress bases take no mid layer; top bases take one only over a plain base.
  const bases: Array<{ ids: string[]; topType: string | null }> = [];
  for (const top of tops) {
    for (const bottom of bottoms) {
      for (const shoe of shoeOptions) {
        bases.push({ ids: [top.id, bottom.id, ...(shoe ? [shoe] : [])], topType: top.type });
      }
    }
  }
  for (const dress of dresses) {
    for (const shoe of shoeOptions) {
      bases.push({ ids: [dress.id, ...(shoe ? [shoe] : [])], topType: null });
    }
  }
  for (const base of bases) {
    yield base.ids;
    if (!layering) continue;
    const baseSet = new Set(base.ids);
    const midOk = base.topType !== null && midAllowedOver(base.topType);
    for (const mid of mids) {
      if (!midOk || baseSet.has(mid.id)) continue;
      const withMid = [...base.ids, mid.id];
      if (!typeClash(withMid, byId)) yield withMid;
      for (const outer of outers) {
        if (baseSet.has(outer.id) || outer.id === mid.id) continue;
        const withBoth = [...base.ids, mid.id, outer.id];
        if (!typeClash(withBoth, byId)) yield withBoth;
      }
    }
    for (const outer of outers) {
      if (baseSet.has(outer.id)) continue;
      const withOuter = [...base.ids, outer.id];
      if (!typeClash(withOuter, byId)) yield withOuter;
    }
  }
}

/**
 * Relaxation ladder levels, in order. The last resort drops every rule so a
 * small closet still gets ranked looks.
 */
export const RELAX_LEVELS = ["warmth", "occasion", "spread", "shoes", "all"] as const;

export interface ActiveFilters {
  warmth: boolean;
  occasion: boolean;
  spread: number;
  shoes: boolean;
}

function filtersForLevel(level: number): ActiveFilters {
  return {
    warmth: level <= 0,
    occasion: level <= 1,
    spread: level <= 2 ? 2 : level <= RELAX_LEVELS.length - 1 ? 3 : Number.POSITIVE_INFINITY,
    shoes: level <= 3,
  };
}

function failsSpread(items: RuleItem[], spread: number): string | null {
  const core = items.filter((item) => !isOuterType(item.type)).map((item) => item.formality);
  if (core.length > 1 && Math.max(...core) - Math.min(...core) > spread) {
    return "formality spread over the limit";
  }
  return null;
}

function failsOccasion(items: RuleItem[], range: [number, number]): string | null {
  const [lo, hi] = range;
  const outside = items.some((item) => {
    const distance = item.formality < lo ? lo - item.formality : item.formality > hi ? item.formality - hi : 0;
    return distance >= 2;
  });
  return outside ? "item outside the occasion range" : null;
}

function passesFilters(
  items: RuleItem[],
  ctx: StyleContext,
  range: [number, number],
  active: ActiveFilters,
): boolean {
  if (active.warmth && failsWeather(items, ctx.weather)) return false;
  if (active.occasion && failsOccasion(items, range)) return false;
  if (active.shoes && failsShoes(items, range[1])) return false;
  if (failsSpread(items, active.spread)) return false;
  return true;
}

function nonShoeHues(items: RuleItem[]): string[] {
  const hues: string[] = [];
  for (const item of items) {
    if (isShoe(item)) continue;
    const family = colorFamily(item.primary_color);
    if (family && !hues.includes(family)) hues.push(family);
  }
  return hues;
}

/** 0-1 non-neutral hue families; neutrals, denim and unknowns score clean. */
export function scoreColor(items: RuleItem[], occasion: OccasionBucket): number {
  const hues = nonShoeHues(items);
  let score: number;
  if (hues.length <= 1) {
    score = 1;
  } else if (hues.length === 2) {
    const [a, b] = hues as [string, string];
    if (analogous(a, b)) {
      score = 1;
    } else {
      const secondOnShoes = items.some(
        (item) => isShoe(item) && colorFamily(item.primary_color) !== null,
      );
      score = secondOnShoes ? 0.8 : 0.6;
    }
  } else {
    score = 0.2;
  }
  const social: OccasionBucket[] = ["party", "brunch", "casual-date", "casual", "wedding"];
  if ((occasion === "office" || occasion === "interview") && hues.length <= 1) {
    score = Math.min(1, score + 0.1);
  } else if (social.includes(occasion)) {
    const accents = hues.filter((hue) => VIVID_HUES.has(hue));
    if (accents.length === 1 && hues.length === 2) score = Math.min(1, score + 0.15);
  }
  return score;
}

/** A statement piece: a bold print or one vivid hue. */
export function isStatementItem(item: RuleItem): boolean {
  if (isBoldPattern(item.pattern)) return true;
  const family = colorFamily(item.primary_color);
  return family !== null && VIVID_HUES.has(family);
}

function axisOf(item: RuleItem): {
  fit: string | null;
  length: string | null;
  sleeve: string | null;
  rise: string | null;
} {
  const clean = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const v = value.toLowerCase().trim();
    return v === "" || v === "n/a" ? null : v;
  };
  return { fit: clean(item.fit), length: clean(item.length), sleeve: clean(item.sleeve), rise: clean(item.rise) };
}

const LOOSE_TOPS = ["loose", "oversized"];
const SLIM_BOTTOMS = ["skinny", "slim", "straight"];
const WIDE_BOTTOMS = ["wide-leg", "baggy", "loose", "flared"];
const FITTED_TOPS = ["fitted", "boxy"];
const RELAXED_FITS = ["relaxed", "loose", "oversized", "flowy"];

/**
 * Proportion rules (themodestman-style balance). Any axis that is missing
 * stays neutral; only stated fits participate.
 */
export function scoreProportion(items: RuleItem[], stylePref: string | null): number {
  const tops = items.filter((item) => categoryOf(item) === "top");
  const bottoms = items.filter((item) => categoryOf(item) === "bottom");
  const dresses = items.filter((item) => categoryOf(item) === "dress");
  const layers = items.filter((item) => isLayerType(item.type));
  const topAxes = tops.map(axisOf);
  const bottomAxes = bottoms.map(axisOf);
  const hasInfo =
    topAxes.some((a) => a.fit ?? a.length) || bottomAxes.some((a) => a.fit ?? a.rise);
  if (!hasInfo && dresses.length === 0) return 0.5;
  const topLoose = topAxes.some((a) => (a.fit && LOOSE_TOPS.includes(a.fit)) || a.length === "longline");
  const bottomSlim = bottomAxes.some((a) => a.fit && SLIM_BOTTOMS.includes(a.fit));
  if (topLoose && bottomSlim) return 1;
  const bottomWide = bottomAxes.some((a) => a.fit && WIDE_BOTTOMS.includes(a.fit));
  const topFitted = topAxes.some((a) => (a.fit && FITTED_TOPS.includes(a.fit)) || a.length === "cropped");
  if (bottomWide && topFitted) return 1;
  const topOversized = topAxes.some((a) => a.fit === "oversized");
  const bottomOversized = bottomAxes.some(
    (a) => a.fit && ["oversized", "baggy", "wide-leg"].includes(a.fit),
  );
  if (topOversized && bottomOversized) {
    return stylePref === "streetwear" || stylePref === "relaxed" ? 0.7 : 0.2;
  }
  const croppedTop = topAxes.some((a) => a.length === "cropped");
  const highRise = bottomAxes.some((a) => a.rise === "high");
  if (croppedTop && highRise) return 1;
  const longlineTop = topAxes.some((a) => a.length === "longline");
  if (longlineTop && bottomSlim) return 1;
  const bodycon = dresses.some((item) => axisOf(item).fit === "bodycon");
  const looseLayer = layers.some((item) => {
    const fit = axisOf(item).fit;
    return fit !== null && ["oversized", "relaxed", "loose"].includes(fit);
  });
  if (bodycon && looseLayer) return 1;
  const aline = dresses.some((item) => axisOf(item).fit === "a-line");
  if (aline && topFitted) return 1;
  return 0.5;
}

function sharedColor(a: RuleItem, b: RuleItem): boolean {
  const colorsOf = (item: RuleItem): string[] =>
    [item.primary_color, ...item.secondary_colors].map((c) => c.toLowerCase().trim()).filter(Boolean);
  const setA = new Set(colorsOf(a));
  return colorsOf(b).some((color) => setA.has(color));
}

function isQuietPattern(pattern: string): boolean {
  const text = patternText(pattern);
  if (text === "" || text === "solid" || text === "unknown") return true;
  return QUIET_PATTERN_WORDS.some((word) => text.includes(word));
}

/** Max one bold pattern; a second print must be smaller/quieter and share a color. */
export function scorePattern(items: RuleItem[]): number {
  const patterned = items.filter((item) => {
    const text = patternText(item.pattern);
    return text !== "" && text !== "solid" && text !== "unknown";
  });
  if (patterned.length === 0) return 1;
  if (patterned.length === 1) return isBoldPattern(patterned[0]?.pattern ?? "") ? 0.9 : 1;
  if (patterned.length === 2) {
    const [a, b] = patterned as [RuleItem, RuleItem];
    const bolds = patterned.filter((item) => isBoldPattern(item.pattern)).length;
    if (bolds >= 2) return 0.2;
    const share = sharedColor(a, b);
    const eitherQuiet = isQuietPattern(a.pattern) || isQuietPattern(b.pattern);
    if (bolds === 0) return share ? (eitherQuiet ? 0.9 : 0.8) : 0.7;
    const second = isBoldPattern(a.pattern) ? b : a;
    const quiet = isQuietPattern(second.pattern);
    if (share && quiet) return 0.8;
    if (share) return 0.6;
    if (quiet) return 0.5;
    return 0.3;
  }
  return 0.1;
}

const SOFT_FABRICS = ["soft", "fleece", "flannel", "knit", "cashmere", "wool", "velvet", "sherpa"];

function hasSoftFabric(item: RuleItem): boolean {
  return SOFT_FABRICS.some((word) => item.fabric_weight.toLowerCase().includes(word));
}

/** Mood modifiers: confident/bold want a statement, cozy wants warmth+softness. */
export function scoreMood(mood: string | null, items: RuleItem[]): number {
  if (!mood) return 0.5;
  const statements = items.filter(isStatementItem).length;
  switch (mood.toLowerCase()) {
    case "confident":
      return statements === 1 ? 1 : statements === 0 ? 0.4 : 0.5;
    case "bold":
      return statements === 1 ? 1 : 0.4;
    case "cozy": {
      const warmthPart = Math.max(0, Math.min(1, (warmthSum(items) - 6) / 8));
      const softPart = items.some(hasSoftFabric) ? 1 : 0.4;
      return 0.5 * warmthPart + 0.5 * softPart;
    }
    case "calm": {
      const hues = nonShoeHues(items);
      if (hues.length <= 1) return 1;
      if (hues.length === 2) {
        const [a, b] = hues as [string, string];
        return analogous(a, b) ? 0.7 : 0.3;
      }
      return 0.2;
    }
    case "lazy": {
      const forms = items.map((item) => item.formality);
      const avg = forms.reduce((sum, form) => sum + form, 0) / Math.max(1, forms.length);
      const base = avg <= 2 ? 1 : avg <= 3 ? 0.6 : 0.3;
      const relaxed = items.some((item) => {
        const fit = axisOf(item).fit;
        return fit !== null && RELAXED_FITS.includes(fit);
      });
      return Math.min(1, base + (relaxed ? 0.2 : 0));
    }
    default:
      return 0.5;
  }
}

function isJeanOrShoe(item: RuleItem): boolean {
  return /jean/.test(item.type.toLowerCase()) || isShoe(item);
}

/** Recency penalty, halved for jeans and shoes; no log means no penalty. */
export function scoreRotation(items: RuleItem[], wearDays: Record<string, number>): number {
  const penalties = items
    .map((item) => {
      const days = wearDays[item.id];
      if (days === undefined || days < 0) return null;
      const raw = Math.max(0, 1 - days / 7);
      return isJeanOrShoe(item) ? raw * 0.5 : raw;
    })
    .filter((penalty): penalty is number => penalty !== null);
  if (penalties.length === 0) return 1;
  const avg = penalties.reduce((sum, penalty) => sum + penalty, 0) / penalties.length;
  return Math.max(0, 1 - avg);
}

const WARM_PALETTE = ["mustard", "olive", "rust", "camel", "ivory", "red", "gold", "terracotta"];
const COOL_PALETTE = ["sapphire", "emerald", "lavender", "pink", "charcoal", "white", "silver", "plum", "teal"];

/** Undertone bonus on the TOP's color; unset or "not sure" scores neutral. */
export function scoreUndertone(items: RuleItem[], undertone: StyleProfile["undertone"]): number {
  if (!undertone || undertone === "not sure" || undertone === "neutral") return 1;
  const top = items.find((item) => categoryOf(item) === "top") ?? items.find((item) => categoryOf(item) === "dress");
  if (!top) return 1;
  const tokens = `${top.primary_color} ${top.secondary_colors.join(" ")}`.toLowerCase().split(/[^a-z]+/);
  const palette = undertone === "warm" ? WARM_PALETTE : COOL_PALETTE;
  return tokens.some((token) => palette.includes(token)) ? 1 : 0.4;
}

/** Hot+humid prefers low warmth and relaxed fits; otherwise neutral. */
export function scoreClimate(items: RuleItem[], weather: StyleWeather): number {
  const hotHumid = weather.highC >= 28 && weather.humidityPct >= 60;
  if (!hotHumid) return 1;
  const avg = warmthSum(items) / Math.max(1, items.filter((item) => !isShoe(item)).length);
  const warmthPart = Math.max(0, Math.min(1, 1 - (avg - 1) / 4));
  const relaxed = items.some((item) => {
    const fit = axisOf(item).fit;
    return fit !== null && RELAXED_FITS.includes(fit);
  });
  return 0.6 * warmthPart + 0.4 * (relaxed ? 1 : 0.5);
}

/** Conservative strictness prefers covered shoulders/knees and top-of-range formality. */
export function scoreModesty(
  items: RuleItem[],
  strictness: StyleProfile["strictness"],
  range: [number, number],
): number {
  if (strictness !== "conservative") return 1;
  const tops = items.filter((item) => categoryOf(item) === "top");
  const bottoms = items.filter(
    (item) => categoryOf(item) === "bottom" || categoryOf(item) === "dress",
  );
  const shoulders = tops.every((item) => {
    const sleeve = axisOf(item).sleeve;
    if (sleeve === null) return true;
    return sleeve !== "sleeveless";
  });
  const knees = bottoms.every((item) => axisOf(item).length !== "short");
  const forms = items.map((item) => item.formality);
  const avg = forms.reduce((sum, form) => sum + form, 0) / Math.max(1, forms.length);
  const formPart = avg >= range[0] + 1 ? 1 : Math.max(0, 1 - (range[0] + 1 - avg) / 2);
  return 0.4 * (shoulders ? 1 : 0) + 0.3 * (knees ? 1 : 0) + 0.3 * formPart;
}

/** Votes on the same look adjust its pairs; unknown pairs score neutral. */
export interface LookVote {
  key: string;
  itemIds: string[];
  vote: 1 | -1;
}

/** Average vote per sorted id-pair, clamped to [-1, 1]. */
export function pairAdjustments(votes: LookVote[]): Record<string, number> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const vote of votes) {
    const ids = [...new Set(vote.itemIds)].sort();
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = `${ids[i]}|${ids[j]}`;
        const entry = sums.get(key) ?? { total: 0, count: 0 };
        entry.total += vote.vote;
        entry.count += 1;
        sums.set(key, entry);
      }
    }
  }
  const out: Record<string, number> = {};
  for (const [key, entry] of sums) {
    out[key] = Math.max(-1, Math.min(1, entry.total / entry.count));
  }
  return out;
}

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

export function scoreFeedback(items: RuleItem[], pairScores: Record<string, number>): number {
  const ids = [...new Set(items.map((item) => item.id))].sort();
  const known: number[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const score = pairScores[pairKey(ids[i] as string, ids[j] as string)];
      if (score !== undefined) known.push(score);
    }
  }
  if (known.length === 0) return 1;
  const avg = known.reduce((sum, score) => sum + score, 0) / known.length;
  return Math.max(0, Math.min(1, 1 + avg * 0.2));
}

export interface ScoredOutfit {
  itemIds: string[];
  score: number;
  parts: Record<string, number>;
}

export function scoreOutfit(items: RuleItem[], ctx: StyleContext, range: [number, number]): ScoredOutfit {
  const parts: Record<string, number> = {
    color: scoreColor(items, ctx.occasion),
    proportion: scoreProportion(items, ctx.profile.style ?? null),
    pattern: scorePattern(items),
    mood: scoreMood(ctx.mood, items),
    rotation: scoreRotation(items, ctx.wearDays),
    undertone: scoreUndertone(items, ctx.profile.undertone ?? null),
    climate: scoreClimate(items, ctx.weather),
    modesty: scoreModesty(items, ctx.profile.strictness ?? null, range),
    feedback: scoreFeedback(items, ctx.pairScores),
  };
  let total = 0;
  for (const [name, weight] of Object.entries(STYLE_WEIGHTS)) {
    total += weight * (parts[name] ?? 0.5);
  }
  return { itemIds: items.map((item) => item.id), score: total, parts };
}

/**
 * One or two stylist sentences from the outfit's own labels — never numbers,
 * never rule names. Built from the strongest true signals: color story,
 * proportion balance, weather coverage, occasion fit.
 */
export function ruleReason(items: RuleItem[], ctx: StyleContext): string {
  const byId = new Map(items.map((item) => [item.id, item]));
  const top = items.find((item) => categoryOf(item) === "top");
  const bottom = items.find((item) => categoryOf(item) === "bottom");
  const dress = items.find((item) => categoryOf(item) === "dress");
  const outer = items.find((item) => isOuterType(item.type));
  const hues = nonShoeHues(items);
  const phrases: string[] = [];

  const core = [top?.id, bottom?.id, dress?.id].filter(Boolean) as string[];
  if (hues.length <= 1 && core.length >= 1) {
    const labels = core.map((id) => itemLabel(byId.get(id) as RuleItem));
    phrases.push(`${labels.join(" and ")} keep it clean`);
  } else if (hues.length === 2) {
    const vivid = items.find((item) => !isShoe(item) && isStatementItem(item));
    if (vivid) {
      phrases.push(`the ${itemLabel(vivid)} lifts the neutrals`);
    } else {
      phrases.push(`${hues.join(" and ")} sit well together`);
    }
  }

  const topAxis = top ? axisOf(top) : null;
  const bottomAxis = bottom ? axisOf(bottom) : null;
  if (topAxis && bottomAxis) {
    const loose = (topAxis.fit && LOOSE_TOPS.includes(topAxis.fit)) || topAxis.length === "longline";
    const slim = bottomAxis.fit && SLIM_BOTTOMS.includes(bottomAxis.fit);
    if (loose && slim) {
      phrases.push(`the ${itemLabel(top as RuleItem)} balances ${itemLabel(bottom as RuleItem)}`);
    } else {
      const wide = bottomAxis.fit && WIDE_BOTTOMS.includes(bottomAxis.fit);
      const fitted = (topAxis.fit && FITTED_TOPS.includes(topAxis.fit)) || topAxis.length === "cropped";
      if (wide && fitted) {
        phrases.push(`the ${itemLabel(top as RuleItem)} sharpens ${itemLabel(bottom as RuleItem)}`);
      } else if (topAxis.length === "cropped" && bottomAxis.rise === "high") {
        phrases.push(`the cropped top meets the high rise just right`);
      }
    }
  }

  if (ctx.weather.precipPct >= RAIN_PCT && outer) {
    phrases.push(`the ${itemLabel(outer)} covers the rain`);
  } else if (ctx.weather.highC >= 28) {
    phrases.push("light layers for the heat");
  } else if (ctx.weather.lowC < COLD_LOW_C && outer) {
    phrases.push(`the ${itemLabel(outer)} keeps you warm`);
  }

  const occasionLine: Record<string, string> = {
    office: "sharp enough for the office",
    interview: "polished for the interview",
    wedding: "dressed up for the wedding",
    party: "ready for the party",
    brunch: "easy for brunch",
    gym: "built for the workout",
    travel: "comfortable for travel",
  };
  const line = occasionLine[ctx.occasion];
  if (line && phrases.length < 3) phrases.push(line);

  const picked = phrases.slice(0, 3);
  if (picked.length === 0) {
    const piece = top ?? dress ?? items[0];
    return piece ? `The ${itemLabel(piece)} carries this look.` : "A simple combination that works.";
  }
  const sentence = picked.join("; ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** Deterministic one-line weather advice for the outfit card (no numbers). */
export function ruleWeatherNote(weather: StyleWeather | null): string {
  if (!weather) return "Picked for an easy day.";
  if (weather.precipPct >= RAIN_PCT) return "Bring the outer layer — rain is likely.";
  if (weather.highC >= 28) return "Light layers for the heat.";
  if (weather.lowC < COLD_LOW_C) return "Layer up for the cold.";
  return "Right weight for the day.";
}

export interface StyleCandidate {
  /** outfitKey of the sorted item ids — doubles as the Spark reference id. */
  id: string;
  itemIds: string[];
  score: number;
  reason: string;
}

export interface GenerationStats {
  /** Raw enumerated combos before sampling. */
  generated: number;
  /** Combos that entered filtering (post sampling cap). */
  sampled: number;
  /** Combos passing the final filter level. */
  afterFilters: number;
  /** Relax ladder step used, or null when level 0 sufficed. */
  relaxed: string | null;
  topScore: number;
}

function pairSignature(items: RuleItem[]): string {
  const top = items.find((item) => categoryOf(item) === "top");
  const bottom = items.find((item) => categoryOf(item) === "bottom");
  const dress = items.find((item) => categoryOf(item) === "dress");
  // Layered variants are distinct looks: the same base with and without a
  // cardigan must not knock each other out of the candidate list.
  const layers = items
    .filter((item) => isLayerType(item.type))
    .map((item) => item.id)
    .sort()
    .join("+");
  if (top && bottom) return `${top.id}+${bottom.id}|${layers}`;
  if (dress) return `${dress.id}|${layers}`;
  return items.map((item) => item.id).sort().join("+");
}

/**
 * Enumerate, filter (with the relax ladder), score and diversify. Never
 * returns empty when the closet holds any complete base — the ladder ends
 * with every filter off, and whatever survives still gets ranked.
 */
export function generateCandidates(ctx: StyleContext): { candidates: StyleCandidate[]; stats: GenerationStats } {
  const byId = new Map(ctx.items.map((item) => [item.id, item]));
  const ofCategory = (category: string): RuleItem[] =>
    ctx.items.filter((item) => categoryOf(item) === category).sort((a, b) => (a.id < b.id ? -1 : 1));
  // Roles come from the garment type, never the layer tag: a shirt tagged
  // "mid" stays a base top, and only true layering pieces become layers.
  const byType = (fn: (type: string) => boolean): RuleItem[] =>
    ctx.items.filter((item) => fn(item.type)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const tops = byType(isBaseTopType);
  const bottoms = ofCategory("bottom");
  const dresses = ofCategory("dress");
  const shoesList = ofCategory("shoes");
  const mids = byType(isMidLayerType);
  const outers = byType(isOuterType);
  const range = OCCASION_RANGES[ctx.occasion];
  const layering = ctx.weather.lowC < 12 || ctx.weather.precipPct >= RAIN_PCT;

  // Reservoir sample the enumeration so huge closets stay bounded.
  const random = mulberry32(seedInt(ctx.seed));
  const pool: string[][] = [];
  let generated = 0;
  for (const combo of enumerateBases(tops, bottoms, dresses, shoesList, mids, outers, layering, byId)) {
    generated += 1;
    if (pool.length < MAX_COMBOS) {
      pool.push(combo);
      continue;
    }
    const slot = Math.floor(random() * generated);
    if (slot < MAX_COMBOS) pool[slot] = combo;
  }

  const resolve = (ids: string[]): RuleItem[] =>
    ids.map((id) => byId.get(id)).filter((item): item is RuleItem => item !== undefined);

  let relaxed: string | null = null;
  let passing: string[][] = [];
  if (pool.length < 3) {
    passing = pool.filter((ids) => !typeClash(ids, byId));
  } else {
    for (let level = 0; level <= RELAX_LEVELS.length; level += 1) {
      const active = filtersForLevel(level);
      const kept = pool.filter((ids) => !typeClash(ids, byId) && passesFilters(resolve(ids), ctx, range, active));
      if (kept.length >= 3 || level === RELAX_LEVELS.length) {
        passing = kept;
        relaxed = level === 0 ? null : RELAX_LEVELS[level - 1] ?? null;
        break;
      }
    }
  }

  const scored = passing
    .map((ids) => ({ ids, scored: scoreOutfit(resolve(ids), ctx, range) }))
    .sort((a, b) => b.scored.score - a.scored.score);

  // Diversity: no two candidates share the same base plus the same layers.
  const seen = new Set<string>();
  const candidates: StyleCandidate[] = [];
  for (const entry of scored) {
    if (candidates.length >= 15) break;
    const items = resolve(entry.ids);
    const signature = pairSignature(items);
    if (seen.has(signature)) continue;
    seen.add(signature);
    const itemIds = [...entry.ids].sort();
    candidates.push({
      id: outfitKey(itemIds),
      itemIds,
      score: entry.scored.score,
      reason: ruleReason(items, ctx),
    });
  }

  return {
    candidates,
    stats: {
      generated,
      sampled: pool.length,
      afterFilters: passing.length,
      relaxed,
      topScore: candidates.length > 0 ? (candidates[0]?.score ?? 0) : 0,
    },
  };
}
