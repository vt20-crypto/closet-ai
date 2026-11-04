import test from "node:test";
import assert from "node:assert/strict";

import { validateItemEdit, type EditableTags } from "./itemEdit.ts";

const CURRENT: EditableTags = {
  nickname: "Daily",
  type: "jeans",
  primary_color: "denim",
  fit: "baggy",
  length: "ankle",
  sleeve: "n/a",
  rise: "high",
  formality: 2,
  warmth: 3,
};

test("accepts a full valid edit", () => {
  const { tags, error } = validateItemEdit(
    { nickname: "Walkable", primary_color: "black", formality: 3, warmth: 2, fit: "slim" },
    CURRENT,
  );
  assert.equal(error, undefined);
  assert.deepEqual(tags, { ...CURRENT, nickname: "Walkable", primary_color: "black", formality: 3, warmth: 2, fit: "slim" });
});

test("untouched fields keep their values", () => {
  const { tags } = validateItemEdit({}, CURRENT);
  assert.deepEqual(tags, CURRENT);
});

test("empty nickname clears it (fallback shows), long ones reject", () => {
  const { tags, error } = validateItemEdit({ nickname: "  " }, CURRENT);
  assert.equal(error, undefined);
  assert.equal(tags?.nickname, "");
  assert.match(validateItemEdit({ nickname: 7 }, CURRENT).error ?? "", /2 words/);
});

test("rejects long nicknames, empty types and out-of-range steppers", () => {
  assert.match(validateItemEdit({ nickname: "way too long nickname" }, CURRENT).error ?? "", /2 words/);
  assert.match(validateItemEdit({ nickname: "one two three" }, CURRENT).error ?? "", /2 words/);
  assert.match(validateItemEdit({ type: "" }, CURRENT).error ?? "", /Type/);
  assert.match(validateItemEdit({ formality: 6 }, CURRENT).error ?? "", /Formality/);
  assert.match(validateItemEdit({ warmth: 0 }, CURRENT).error ?? "", /Warmth/);
});

test("re-normalizes axes when the type changes", () => {
  const { tags } = validateItemEdit({ type: "midi dress" }, CURRENT);
  assert.equal(tags?.type, "midi dress");
  assert.equal(tags?.fit, "n/a");
  assert.equal(tags?.rise, "n/a");
});
