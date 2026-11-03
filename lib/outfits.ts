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
  { category: "top", words: ["shirt", "tshirt", "tee", "blouse", "sweater", "hoodie", "sweatshirt", "tank", "polo", "turtleneck", "top", "henley", "jersey"] },
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
