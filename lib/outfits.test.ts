import test from "node:test";
import assert from "node:assert/strict";

import {
  arrangeForPages,
  countCompleteOutfits,
  countCoverage,
  coverageMissing,
  normalizeOutfitType,
  outfitKey,
  slotForType,
  slotRank,
  validateOutfits,
  wearableItems,
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

test("validateOutfits allows a mid layer over a listed base top", () => {
  const closet = [...CLOSET, item("c1", "cardigan", "mid")];
  const { valid } = validateOutfits({
    items: closet,
    raw: [{ item_ids: ["t1", "c1", "b1", "s1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(valid.length, 1);
});

test("normalizeOutfitType maps button-down, oxford and flannel to top", () => {
  assert.equal(normalizeOutfitType("button-down"), "top");
  assert.equal(normalizeOutfitType("oxford shirt"), "top");
  assert.equal(normalizeOutfitType("flannel"), "top");
});

test("validateOutfits rejects shirt+polo+shirt (exactly one base top)", () => {
  const closet = [...CLOSET, item("t3", "shirt"), item("p1", "polo", "mid")];
  const { valid, problems } = validateOutfits({
    items: closet,
    raw: [{ item_ids: ["t1", "t3", "p1", "b1", "s1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(valid.length, 0);
  assert.match(problems[0]?.reasons.join(";") ?? "", /exactly one base top/);
});

test("validateOutfits accepts tee + cardigan + jacket", () => {
  const closet = [...CLOSET, item("c1", "cardigan", "mid"), item("j1", "jacket", "outer")];
  const { valid } = validateOutfits({
    items: closet,
    raw: [{ item_ids: ["t1", "c1", "j1", "b1", "s1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(valid.length, 1);
});

test("validateOutfits accepts a cardigan over a blouse", () => {
  const closet = [...CLOSET, item("bl1", "blouse"), item("c1", "cardigan", "mid")];
  const { valid } = validateOutfits({
    items: closet,
    raw: [{ item_ids: ["bl1", "c1", "b1", "s1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(valid.length, 1);
});

test("validateOutfits rejects a mid layer over a sweater base", () => {
  const closet = [...CLOSET, item("c1", "cardigan", "mid")];
  const { valid, problems } = validateOutfits({
    items: closet,
    raw: [{ item_ids: ["t2", "c1", "b1", "s1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(valid.length, 0);
  assert.match(problems[0]?.reasons.join(";") ?? "", /shirt-like base/);
});

test("a shirt tagged as outer still counts as a top, never an outer", () => {
  const closet = [...CLOSET, item("sh1", "shirt", "outer"), item("j1", "jacket", "outer")];
  const bad = validateOutfits({
    items: closet,
    raw: [{ item_ids: ["t1", "sh1", "j1", "b1", "s1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(bad.valid.length, 0);
  const good = validateOutfits({
    items: closet,
    raw: [{ item_ids: ["t1", "j1", "b1", "s1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(good.valid.length, 1);
});

test("validateOutfits rejects a top worn with a dress", () => {
  const { valid, problems } = validateOutfits({
    items: CLOSET,
    raw: [{ item_ids: ["d1", "t1", "s1"], reason: "r", weather_note: "w" }],
  });
  assert.equal(valid.length, 0);
  assert.match(problems[0]?.reasons.join(";") ?? "", /dress/);
});

test("arrangeForPages interleaves a repeated bottom", () => {
  const closet = [...CLOSET, item("b2", "chinos"), item("t3", "polo")];
  const raw = [
    { item_ids: ["t1", "b1", "s1"], reason: "r", weather_note: "w" },
    { item_ids: ["t2", "b1", "s1"], reason: "r", weather_note: "w" },
    { item_ids: ["t3", "b2", "s1"], reason: "r", weather_note: "w" },
  ];
  const { valid } = validateOutfits({ items: closet, raw });
  assert.equal(valid.length, 3);
  const arranged = arrangeForPages(valid, closet);
  assert.deepEqual(
    arranged.map((o) => o.key),
    ["b1|s1|t1", "b2|s1|t3", "b1|s1|t2"],
  );
});

test("wearableItems hides laundry pieces", () => {
  assert.deepEqual(
    wearableItems([{ id: "a" }, { id: "b", laundry: true }, { id: "c", laundry: false }]).map((i) => i.id),
    ["a", "c"],
  );
});

test("arrangeForPages keeps an already-diverse order", () => {
  const closet = [...CLOSET, item("b2", "chinos"), item("t3", "polo")];
  const raw = [
    { item_ids: ["t1", "b1", "s1"], reason: "r", weather_note: "w" },
    { item_ids: ["t3", "b2", "s1"], reason: "r", weather_note: "w" },
  ];
  const { valid } = validateOutfits({ items: closet, raw });
  const arranged = arrangeForPages(valid, closet);
  assert.deepEqual(
    arranged.map((o) => o.key),
    ["b1|s1|t1", "b2|s1|t3"],
  );
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
