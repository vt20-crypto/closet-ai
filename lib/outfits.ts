/**
 * Outfit validation + closet coverage (pure functions, no I/O).
 *
 * An outfit is a list of closet item ids. Server-side rules:
 * - every id must exist (one unknown id invalidates the WHOLE outfit);
 * - complete: (top + bottom) or dress; shoes required iff the closet has any;
 * - no raw type twice, except same-type items with distinct layers;
 * - excluded combos (sorted id sets already shown this session) are invalid.
 */

export type OutfitCategory = "top" | "bottom" | "dress" | "shoes" | "outer" | "other";

export interface OutfitItemLike {
  id: string;
  tags: {
    type: string;
    layer: string;
  };
}

export interface RawOutfit {
  item_ids: string[];
  reason: string;
  weather_note: string;
  /** 1-10 style + weather + occasion fit. Absent/unscored counts as 5. */
  score?: number;
}

export interface ValidatedOutfit extends RawOutfit {
  /** Sorted ids, used for session exclusion. */
  key: string;
}

/** Pieces in the laundry sit out: hidden from coverage and outfit picks. */
export function wearableItems<T extends { laundry?: boolean }>(items: T[]): T[] {
  return items.filter((item) => !item.laundry);
}

export interface OutfitProblem {
  index: number;
  reasons: string[];
}

function clean(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

const KEYWORDS: { category: OutfitCategory; words: string[] }[] = [
  { category: "dress", words: ["dress", "gown", "sundress", "frock"] },
  { category: "shoes", words: ["shoe", "sneaker", "boot", "sandal", "heel", "loafer", "trainer", "pump", "flat", "slipon"] },
  { category: "outer", words: ["jacket", "coat", "blazer", "cardigan", "vest", "parka", "windbreaker", "raincoat", "overcoat"] },
  { category: "bottom", words: ["pants", "jeans", "trousers", "shorts", "skirt", "leggings", "joggers", "chinos", "capris", "culottes"] },
  { category: "top", words: ["shirt", "tshirt", "tee", "blouse", "sweater", "hoodie", "sweatshirt", "tank", "polo", "turtleneck", "top", "henley", "jersey", "buttondown", "oxford", "flannel"] },
];

/** Map a free-form Spark type string to an outfit category. */
export function normalizeOutfitType(type: string): OutfitCategory {
  const c = clean(type);
  if (!c) return "other";
  for (const { category, words } of KEYWORDS) {
    for (const w of words) {
      if (c.includes(w) || w.includes(c)) return category;
    }
  }
  return "other";
}

/**
 * Garment roles are decided by TYPE, never by the layer tag: a shirt tagged
 * "mid" is still a base top, never a layer. Knitwear (sweater/hoodie/
 * sweatshirt) can serve as either the base top or the mid layer.
 */
const BASE_TOP_WORDS = [
  "tshirt",
  "tee",
  "shirt",
  "blouse",
  "tank",
  "polo",
  "turtleneck",
  "henley",
  "jersey",
  "top",
  "buttondown",
  "oxford",
  "flannel",
  "sweater",
  "hoodie",
  "sweatshirt",
];

const MID_LAYER_WORDS = ["cardigan", "sweater", "hoodie", "sweatshirt", "overshirt", "vest", "fleece"];

/** Base tops a mid layer may sit on: plain shirts and blouses, never knitwear. */
const MID_BASE_WORDS = ["tshirt", "tee", "shirt", "blouse", "tank", "polo", "turtleneck", "henley"];

function includesWord(cleaned: string, words: string[]): boolean {
  return words.some((word) => cleaned.includes(word));
}

/** Can this type serve as the outfit's single base top? */
export function isBaseTopType(type: string): boolean {
  return includesWord(clean(type), BASE_TOP_WORDS);
}

/** Is this type a layering piece (mid), whatever its layer tag says? */
export function isMidLayerType(type: string): boolean {
  return includesWord(clean(type), MID_LAYER_WORDS);
}

/** Is this type a true outer layer (mid-layer pieces excluded)? */
export function isOuterType(type: string): boolean {
  return normalizeOutfitType(type) === "outer" && !isMidLayerType(type);
}

/** Is this type a mid or outer layer piece? */
export function isLayerType(type: string): boolean {
  return isMidLayerType(type) || isOuterType(type);
}

/** A mid layer only sits on a plain base top, never on knitwear. */
export function midAllowedOver(baseType: string): boolean {
  const c = clean(baseType);
  if (c.includes("sweatshirt") || c.includes("hoodie") || c.includes("sweater")) return false;
  return includesWord(c, MID_BASE_WORDS);
}

export type OutfitSlot = "top" | "bottom" | "dress" | "shoes" | "mid" | "outer" | "other";

/**
 * Assign every item to exactly one structural slot. Knitwear and layering
 * pieces share a flex pool: the first base-eligible flex item becomes the top
 * when no plain top exists, and every other flex item is a mid layer.
 */
export function classifySlots(matched: OutfitItemLike[]): Record<OutfitSlot, OutfitItemLike[]> {
  const slots: Record<OutfitSlot, OutfitItemLike[]> = {
    top: [],
    bottom: [],
    dress: [],
    shoes: [],
    mid: [],
    outer: [],
    other: [],
  };
  const flex: OutfitItemLike[] = [];
  for (const item of matched) {
    const category = normalizeOutfitType(item.tags.type);
    if (category === "dress") slots.dress.push(item);
    else if (category === "shoes") slots.shoes.push(item);
    else if (category === "bottom") slots.bottom.push(item);
    else if (isMidLayerType(item.tags.type)) flex.push(item);
    else if (category === "outer") slots.outer.push(item);
    else if (category === "top" && isBaseTopType(item.tags.type)) slots.top.push(item);
    else slots.other.push(item);
  }
  for (const item of flex) {
    if (slots.top.length === 0 && slots.dress.length === 0 && isBaseTopType(item.tags.type)) {
      slots.top.push(item);
    } else {
      slots.mid.push(item);
    }
  }
  return slots;
}

export interface CoverageCount {
  tops: number;
  bottoms: number;
  dresses: number;
  shoes: number;
  outer: number;
}

/** Count closet coverage by category, in code (never guessed by the model). */
export function countCoverage(items: OutfitItemLike[]): CoverageCount {
  const counts: CoverageCount = { tops: 0, bottoms: 0, dresses: 0, shoes: 0, outer: 0 };
  for (const item of items) {
    switch (normalizeOutfitType(item.tags.type)) {
      case "top": counts.tops += 1; break;
      case "bottom": counts.bottoms += 1; break;
      case "dress": counts.dresses += 1; break;
      case "shoes": counts.shoes += 1; break;
      case "outer": counts.outer += 1; break;
      case "other": break;
    }
  }
  return counts;
}

export type MissingCategory = "tops" | "bottoms" | "dresses";

/**
 * Which categories block a complete outfit. A dress alone suffices, so a
 * closet with any dress is always coverable; otherwise tops AND bottoms are
 * both required.
 */
export function coverageMissing(counts: CoverageCount): MissingCategory[] {
  if (counts.dresses > 0) return [];
  const missing: MissingCategory[] = [];
  if (counts.tops === 0) missing.push("tops");
  if (counts.bottoms === 0) missing.push("bottoms");
  return missing;
}

/** Canonical key for a combination: sorted ids joined. */
export function outfitKey(ids: string[]): string {
  return [...ids].sort().join("|");
}

export interface ValidationInput {
  items: OutfitItemLike[];
  raw: RawOutfit[];
  excludeKeys?: Set<string>;
}

/**
 * Validate model-proposed outfits. Returns the valid ones (1-3, never padded)
 * plus per-outfit problems for the single retry prompt.
 */
export function validateOutfits(input: ValidationInput): {
  valid: ValidatedOutfit[];
  problems: OutfitProblem[];
} {
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const closetHasShoes = input.items.some(
    (item) => normalizeOutfitType(item.tags.type) === "shoes",
  );
  const valid: ValidatedOutfit[] = [];
  const problems: OutfitProblem[] = [];

  input.raw.forEach((outfit, index) => {
    const reasons: string[] = [];
    const ids = Array.isArray(outfit.item_ids) ? outfit.item_ids : [];
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      reasons.push(`unknown item ids: ${unknown.join(", ")}`);
    }
    const key = outfitKey(ids);
    if (input.excludeKeys?.has(key)) {
      reasons.push("combination already shown this session");
    }

    const matched = ids
      .map((id) => byId.get(id))
      .filter((item): item is OutfitItemLike => item !== undefined);

    if (matched.length > 0 && reasons.length === 0) {
      const categories = matched.map((item) => normalizeOutfitType(item.tags.type));
      const hasTop = categories.includes("top");
      const hasBottom = categories.includes("bottom");
      const hasDress = categories.includes("dress");
      const hasShoes = categories.includes("shoes");
      if (!(hasDress || (hasTop && hasBottom))) {
        reasons.push("incomplete: needs top+bottom or a dress");
      }
      if (closetHasShoes && !hasShoes) {
        reasons.push("incomplete: closet has shoes, outfit needs a pair");
      }
      // One-per-slot structure: roles come from the garment type, never the
      // layer tag, so a shirt tagged "mid" still counts as a base top.
      const slots = classifySlots(matched);
      if (slots.dress.length > 0) {
        if (slots.dress.length > 1) reasons.push("only one dress per outfit");
        if (slots.top.length + slots.bottom.length + slots.mid.length > 0) {
          reasons.push("a dress outfit takes no separate top, bottom or mid layer");
        }
      } else if (slots.top.length !== 1 || slots.bottom.length !== 1) {
        reasons.push("needs exactly one base top and one bottom");
      }
      if (slots.shoes.length > 1) reasons.push("only one pair of shoes per outfit");
      if (slots.outer.length > 1) reasons.push("only one outer layer per outfit");
      if (slots.mid.length > 1) reasons.push("only one mid layer per outfit");
      if (slots.mid.length === 1 && slots.top.length !== 1) {
        reasons.push("a mid layer needs exactly one base top");
      }
      if (
        slots.mid.length === 1 &&
        slots.top.length === 1 &&
        !midAllowedOver(slots.top[0]?.tags.type ?? "")
      ) {
        reasons.push("a mid layer needs a shirt-like base (tee, blouse, polo…), never knitwear");
      }
      const seen = new Map<string, string[]>();
      for (const item of matched) {
        const typeKey = clean(item.tags.type) || "unknown";
        const layers = seen.get(typeKey) ?? [];
        layers.push(item.tags.layer);
        seen.set(typeKey, layers);
      }
      for (const [typeKey, layers] of seen) {
        if (layers.length > 1 && new Set(layers).size !== layers.length) {
          reasons.push(`type used twice without distinct layers: ${typeKey}`);
        }
      }
    }

    if (reasons.length === 0 && matched.length === ids.length && ids.length > 0) {
      valid.push({ ...outfit, item_ids: ids, key });
    } else {
      if (ids.length === 0) reasons.push("empty outfit");
      problems.push({ index, reasons });
    }
  });

  return { valid, problems };
}

/**
 * Reorder ranked outfits into pages of 3 so one page never leans on a single
 * piece: within each page the next pick prefers an unseen bottom (or dress),
 * then any pick that keeps every item to at most 2 appearances. Best-effort:
 * when the closet forces repeats, the order simply stays ranked.
 */
export function arrangeForPages(valid: ValidatedOutfit[], items: OutfitItemLike[]): ValidatedOutfit[] {
  if (valid.length <= 1) return [...valid];
  const byId = new Map(items.map((item) => [item.id, item]));
  const anchorOf = (outfit: ValidatedOutfit): string => {
    for (const id of outfit.item_ids) {
      const category = normalizeOutfitType(byId.get(id)?.tags.type ?? "");
      if (category === "bottom" || category === "dress") return id;
    }
    return outfit.key;
  };
  const remaining = [...valid];
  const out: ValidatedOutfit[] = [];
  while (remaining.length > 0) {
    const page: ValidatedOutfit[] = [];
    const counts = new Map<string, number>();
    const anchors = new Set<string>();
    const fits = (outfit: ValidatedOutfit): boolean =>
      outfit.item_ids.every((id) => (counts.get(id) ?? 0) < 2);
    for (const pass of [0, 1, 2]) {
      for (let i = 0; i < remaining.length && page.length < 3; ) {
        const outfit = remaining[i] as ValidatedOutfit;
        if ((pass === 2 || fits(outfit)) && (pass >= 1 || !anchors.has(anchorOf(outfit)))) {
          page.push(outfit);
          remaining.splice(i, 1);
          for (const id of outfit.item_ids) counts.set(id, (counts.get(id) ?? 0) + 1);
          anchors.add(anchorOf(outfit));
        } else {
          i += 1;
        }
      }
    }
    out.push(...page);
  }
  return out;
}

/** Flat-lay slot order for /today: outer first, shoes last, the rest by body. */
export const SLOT_ORDER: OutfitCategory[] = ["outer", "top", "dress", "bottom", "shoes", "other"];

/** Display slot for a garment type (reuses the completeness categories). */
export function slotForType(type: string): OutfitCategory {
  return normalizeOutfitType(type);
}

/** Rank for flat-lay ordering; unknown categories go last. */
export function slotRank(category: string): number {
  const rank = (SLOT_ORDER as string[]).indexOf(category);
  return rank === -1 ? SLOT_ORDER.length : rank;
}

const COUNT_CAP_PER_SLOT = 12;

/**
 * Count every valid complete outfit the closet can make (same validator as
 * the route). Enumerates top×bottom and dress combos with shoes when the
 * closet has any, capped per slot to bound the search. Powers "Seen N of M".
 */
export function countCompleteOutfits(items: OutfitItemLike[]): number {
  const byCat = new Map<OutfitCategory, OutfitItemLike[]>();
  for (const item of items) {
    const cat = normalizeOutfitType(item.tags.type);
    const list = byCat.get(cat) ?? [];
    if (list.length < COUNT_CAP_PER_SLOT) list.push(item);
    byCat.set(cat, list);
  }
  const tops = byCat.get("top") ?? [];
  const bottoms = byCat.get("bottom") ?? [];
  const dresses = byCat.get("dress") ?? [];
  const shoesList = byCat.get("shoes") ?? [];
  const outers = byCat.get("outer") ?? [];
  const shoesOptions: string[][] = shoesList.length > 0 ? shoesList.map((s) => [s.id]) : [[]];
  const outerOptions: string[][] = [[], ...outers.map((o) => [o.id])];

  const raw: RawOutfit[] = [];
  for (const t of tops) {
    for (const b of bottoms) {
      for (const s of shoesOptions) {
        for (const o of outerOptions) {
          raw.push({ item_ids: [t.id, b.id, ...s, ...o], reason: "", weather_note: "" });
        }
      }
    }
  }
  for (const d of dresses) {
    for (const s of shoesOptions) {
      for (const o of outerOptions) {
        raw.push({ item_ids: [d.id, ...s, ...o], reason: "", weather_note: "" });
      }
    }
  }
  return validateOutfits({ items, raw }).valid.length;
}
