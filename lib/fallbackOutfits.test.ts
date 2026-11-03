import test from "node:test";
import assert from "node:assert/strict";

import { fallbackOutfits, type FallbackItem } from "./fallbackOutfits.ts";

function item(id: string, tags: Partial<FallbackItem["tags"]> & { type: string }): FallbackItem {
  return {
    id,
    tags: {
      primary_color: "grey",
      formality: 3,
      warmth: 3,
      layer: "base",
      pattern: "solid",
      ...tags,
    },
  };
}

const CLOSET: FallbackItem[] = [
  item("t1", { type: "shirt", formality: 2, warmth: 2, nickname: "Crisp White" }),
  item("t2", { type: "sweater", formality: 3, warmth: 4, pattern: "striped" }),
  item("b1", { type: "jeans", formality: 2, warmth: 3 }),
  item("b2", { type: "skirt", formality: 4, warmth: 2, pattern: "floral" }),
  item("s1", { type: "sneakers", formality: 1, warmth: 2 }),
  item("o1", { type: "coat", formality: 4, warmth: 5, layer: "outer" }),
  item("d1", { type: "dress", formality: 4, warmth: 2 }),
];

test("fallback returns complete outfits with reasons", () => {
  const out = fallbackOutfits(CLOSET, { highC: 20, lowC: 14 }, "cozy", "class");
  assert.ok(out.length >= 1 && out.length <= 3);
  for (const o of out) {
    assert.ok(o.item_ids.length >= 2);
    assert.ok(o.reason.length > 0);
    assert.match(o.reason, /Rule pick/);
  }
});

test("fallback includes an outer layer when cold", () => {
  const out = fallbackOutfits(CLOSET, { highC: 8, lowC: 2 }, null, "work");
  assert.ok(out.length > 0);
  assert.ok(out[0].item_ids.includes("o1"));
  assert.match(out[0].reason, /Warm layers/);
});

test("fallback never pairs two patterned pieces", () => {
  const out = fallbackOutfits(CLOSET, { highC: 20, lowC: 14 }, null, null);
  assert.ok(out.length > 0);
  for (const o of out) {
    assert.ok(!o.item_ids.includes("t2") || !o.item_ids.includes("b2"));
  }
});

test("fallback skips excluded combinations", () => {
  const first = fallbackOutfits(CLOSET, { highC: 20, lowC: 14 }, null, null);
  assert.ok(first.length > 0);
  const key = [...first[0].item_ids].sort().join("|");
  const second = fallbackOutfits(CLOSET, { highC: 20, lowC: 14 }, null, null, [key]);
  assert.ok(second.every((o) => [...o.item_ids].sort().join("|") !== key));
});

test("fallback needs shoes when the closet has them", () => {
  const out = fallbackOutfits(CLOSET, { highC: 20, lowC: 14 }, null, null);
  for (const o of out) assert.ok(o.item_ids.includes("s1"));
});

test("fallback returns [] when no complete outfit exists", () => {
  const out = fallbackOutfits([item("t1", { type: "shirt" })], { highC: 20, lowC: 14 }, null, null);
  assert.deepEqual(out, []);
});
