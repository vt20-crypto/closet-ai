import test from "node:test";
import assert from "node:assert/strict";

import {
  countCompleteOutfits,
  countCoverage,
  coverageMissing,
  normalizeOutfitType,
  outfitKey,
  slotForType,
  slotRank,
  validateOutfits,
  type OutfitItemLike,
} from "./outfits.ts";

function item(id: string, type: string, layer = "base"): OutfitItemLike {
  return { id, tags: { type, layer } };
}

const CLOSET: OutfitItemLike[] = [
  item("t1", "shirt"),
  item("t2", "sweater", "mid"),
  item("b1", "jeans"),
  item("d1", "dress"),
  item("s1", "sneakers"),
  item("o1", "jacket", "outer"),
];

test("normalizeOutfitType maps common types, plurals included", () => {
  assert.equal(normalizeOutfitType("T-Shirts"), "top");
  assert.equal(normalizeOutfitType("jeans"), "bottom");
  assert.equal(normalizeOutfitType("Sneakers"), "shoes");
  assert.equal(normalizeOutfitType("dress"), "dress");
  assert.equal(normalizeOutfitType("jacket"), "outer");
  assert.equal(normalizeOutfitType("scarf"), "other");
  assert.equal(normalizeOutfitType(""), "other");
});

test("countCoverage counts by category in code", () => {
  assert.deepEqual(countCoverage(CLOSET), { tops: 2, bottoms: 1, dresses: 1, shoes: 1, outer: 1 });
});

test("coverageMissing is empty when a dress exists", () => {
  assert.deepEqual(coverageMissing({ tops: 0, bottoms: 0, dresses: 1, shoes: 0, outer: 0 }), []);
});

test("coverageMissing names tops and bottoms when neither exists", () => {
  assert.deepEqual(
    coverageMissing({ tops: 0, bottoms: 0, dresses: 0, shoes: 1, outer: 0 }),
    ["tops", "bottoms"],
  );
  assert.deepEqual(
    coverageMissing({ tops: 2, bottoms: 0, dresses: 0, shoes: 0, outer: 0 }),
    ["bottoms"],
  );
});

test("outfitKey sorts ids before joining", () => {
  assert.equal(outfitKey(["b", "a", "c"]), "a|b|c");
  assert.equal(outfitKey(["a", "b"]), outfitKey(["b", "a"]));
});

test("validateOutfits accepts a complete top+bottom+shoes outfit", () => {
  const { valid, problems } = validateOutfits({
    items: CLOSET,
    raw: [{ item_ids: ["t1", "b1", "s1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(valid.length, 1);
  assert.equal(valid[0]?.key, "b1|s1|t1");
  assert.deepEqual(problems, []);
});

test("validateOutfits accepts a dress-only outfit when closet has shoes... only with shoes", () => {
  const { valid } = validateOutfits({
    items: CLOSET,
    raw: [{ item_ids: ["d1", "s1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(valid.length, 1);
  const rejected = validateOutfits({
    items: CLOSET,
    raw: [{ item_ids: ["d1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(rejected.valid.length, 0);
  assert.match(rejected.problems[0]?.reasons.join(";") ?? "", /shoes/);
});

test("validateOutfits rejects top-only as incomplete", () => {
  const { valid, problems } = validateOutfits({
    items: CLOSET,
    raw: [{ item_ids: ["t1", "s1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(valid.length, 0);
  assert.match(problems[0]?.reasons.join(";") ?? "", /top\+bottom or a dress/);
});

test("one unknown id invalidates the whole outfit (no trimming)", () => {
  const { valid, problems } = validateOutfits({
    items: CLOSET,
    raw: [{ item_ids: ["t1", "b1", "s1", "ghost"], reason: "r", weather_note: "w" }],
  });
  assert.equal(valid.length, 0);
  assert.match(problems[0]?.reasons.join(";") ?? "", /unknown item ids: ghost/);
});

test("validateOutfits rejects a duplicated type without distinct layers", () => {
  const { valid, problems } = validateOutfits({
    items: [...CLOSET, item("t3", "shirt")],
    raw: [{ item_ids: ["t1", "t3", "b1", "s1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(valid.length, 0);
  assert.match(problems[0]?.reasons.join(";") ?? "", /twice without distinct layers/);
});

test("validateOutfits allows same type with distinct layers", () => {
  const closet = [...CLOSET, item("t3", "sweater", "outer")];
  const { valid } = validateOutfits({
    items: closet,
    raw: [{ item_ids: ["t2", "t3", "b1", "s1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(valid.length, 1);
});

test("validateOutfits rejects already-shown combinations", () => {
  const { valid, problems } = validateOutfits({
    items: CLOSET,
    raw: [{ item_ids: ["s1", "t1", "b1"], reason: "r", weather_note: "w" }],
    excludeKeys: new Set(["b1|s1|t1"]),
  });
  assert.equal(valid.length, 0);
  assert.match(problems[0]?.reasons.join(";") ?? "", /already shown/);
});

test("shoes are not required when the closet has none", () => {
  const closet = [item("t1", "shirt"), item("b1", "jeans")];
  const { valid } = validateOutfits({
    items: closet,
    raw: [{ item_ids: ["t1", "b1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(valid.length, 1);
});

test("flat-lay slots order outer before top, shoes last", () => {
  const slots = ["sneakers", "jeans", "coat", "shirt", "dress"].map(slotForType);
  assert.deepEqual(slots, ["shoes", "bottom", "outer", "top", "dress"]);
  const ordered = [...slots].sort((a, b) => slotRank(a) - slotRank(b));
  assert.deepEqual(ordered, ["outer", "top", "dress", "bottom", "shoes"]);
});

test("flat-lay slots put unknown types last", () => {
  assert.equal(slotForType("handbag"), "other");
  assert.ok(slotRank("other") > slotRank("shoes"));
});

test("countCompleteOutfits counts every valid combo", () => {
  const items = [item("t1", "shirt"), item("t2", "sweater"), item("b1", "jeans"), item("s1", "sneakers")];
  // 2 tops × 1 bottom × 1 shoes = 2 complete outfits.
  assert.equal(countCompleteOutfits(items), 2);
});

test("countCompleteOutfits is 0 without a complete outfit", () => {
  assert.equal(countCompleteOutfits([item("t1", "shirt")]), 0);
});
