import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ClosetItem } from "./closet.ts";
import {
  advance,
  applySwap,
  backStep,
  createDressState,
  currentStep,
  finishDress,
  markUnavailable,
  orderSteps,
  skipStep,
  toDressItem,
  type DressItem,
} from "./dress.ts";

const item = (id: string, slot: DressItem["slot"], layer: string, nickname: string): DressItem => ({
  id,
  slot,
  layer,
  nickname,
});

describe("orderSteps", () => {
  it("orders base tops, then bottoms and dresses, then mid, outer, shoes, other", () => {
    const ids = orderSteps([
      item("shoes", "shoes", "base", "sneakers"),
      item("outer", "outer", "outer", "coat"),
      item("mid", "top", "mid", "sweater"),
      item("bottom", "bottom", "base", "jeans"),
      item("dress", "dress", "base", "sundress"),
      item("tee", "top", "base", "tee"),
      item("pin", "other", "base", "brooch"),
    ]);
    assert.deepEqual(ids, ["tee", "bottom", "dress", "mid", "outer", "shoes", "pin"]);
  });

  it("breaks ties by nickname then id", () => {
    const ids = orderSteps([
      item("b", "top", "base", "same"),
      item("a", "top", "base", "same"),
    ]);
    assert.deepEqual(ids, ["a", "b"]);
  });
});

describe("dress state machine", () => {
  it("advances through steps and finishes on the last one", () => {
    let state = createDressState(["a", "b"]);
    assert.equal(currentStep(state)?.itemId, "a");
    state = advance(state);
    assert.equal(currentStep(state)?.itemId, "b");
    state = advance(state);
    assert.equal(state.done, true);
    assert.equal(currentStep(state), null);
    assert.equal(advance(state).done, true);
  });

  it("skips without finishing and goes back to redo", () => {
    let state = createDressState(["a", "b"]);
    state = skipStep(state);
    assert.deepEqual(
      state.steps.map((s) => s.status),
      ["skipped", "todo"],
    );
    state = backStep(state);
    assert.equal(currentStep(state)?.itemId, "a");
    assert.equal(state.done, false);
    assert.equal(backStep(state).index, 0);
  });

  it("swaps the worn item and jumps back to it", () => {
    let state = createDressState(["a", "b"]);
    state = advance(state);
    state = applySwap(state, "a", "c");
    assert.deepEqual(
      state.steps.map((s) => s.itemId),
      ["c", "b"],
    );
    assert.equal(currentStep(state)?.itemId, "c");
    assert.equal(state.steps[0].status, "todo");
  });

  it("ignores swaps for unknown or identical ids", () => {
    const state = createDressState(["a"]);
    assert.equal(applySwap(state, "zzz", "c"), state);
    assert.equal(applySwap(state, "a", "a"), state);
  });

  it("tracks unavailable ids once and finishes on demand", () => {
    let state = createDressState(["a"]);
    state = markUnavailable(state, "x");
    state = markUnavailable(state, "x");
    assert.deepEqual(state.unavailableIds, ["x"]);
    assert.equal(finishDress(state).done, true);
  });

  it("empty outfits finish immediately", () => {
    assert.equal(createDressState([]).done, true);
  });
});

describe("toDressItem", () => {
  // Real GET /api/closet shape: fields nested under tags.
  const closetItem = (id: string, tags: Partial<ClosetItem["tags"]>): ClosetItem => ({
    id,
    cutoutUrl: `https://example.com/${id}.png`,
    nouns: ["shirt"],
    confidence: 0.95,
    box: { left: 0, top: 0, right: 10, bottom: 10 },
    tags: {
      is_single_garment: true,
      rejection_reason: null,
      type: "t-shirt",
      primary_color: "purple",
      secondary_colors: [],
      formality: 2,
      warmth: 2,
      layer: "base",
      fabric_weight: "light",
      pattern: "solid",
      seasons: ["summer"],
      distinguishing_note: "small pocket",
      nickname: "Grape Tee",
      ...tags,
    },
    photoUrl: "https://example.com/photo.jpg",
    createdAt: "2026-11-03T00:00:00.000Z",
  });

  it("flattens nested tags for dressing order", () => {
    const item = toDressItem(closetItem("a", {}));
    assert.equal(item.id, "a");
    assert.equal(item.slot, "top");
    assert.equal(item.layer, "base");
    assert.equal(item.nickname, "Grape Tee");
  });

  it("falls back when the nickname is missing", () => {
    const item = toDressItem(closetItem("b", { nickname: "" }));
    assert.equal(item.nickname, "purple t-shirt");
  });

  it("falls back to other/base on missing tags", () => {
    const bare = { id: "c", tags: null };
    const item = toDressItem(bare);
    assert.equal(item.slot, "other");
    assert.equal(item.layer, "base");
    assert.equal(item.nickname, "unknown other");
  });
});
