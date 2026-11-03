import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyScoreThreshold, scoreOf } from "./outfitScores.ts";

const o = (key: string, score?: number) => ({ key, score });

describe("scoreOf", () => {
  it("clamps out-of-range scores and defaults unscored to 5", () => {
    assert.equal(scoreOf(o("a", 8)), 8);
    assert.equal(scoreOf(o("a")), 5);
    assert.equal(scoreOf(o("a", Number.NaN)), 5);
    assert.equal(scoreOf(o("a", 0)), 1);
    assert.equal(scoreOf(o("a", 99)), 10);
    assert.equal(scoreOf(o("a", 6.6)), 7);
  });
});

describe("applyScoreThreshold", () => {
  it("keeps only outfits at/above 7, best first", () => {
    const { picked, relaxed } = applyScoreThreshold(
      [o("a", 6), o("b", 9), o("c", 7), o("d", 5)],
      7,
    );
    assert.deepEqual(
      picked.map((p) => p.key),
      ["b", "c"],
    );
    assert.equal(relaxed, false);
  });

  it("relaxes to the top 2 at/above 5 when nothing scores 7", () => {
    const { picked, relaxed } = applyScoreThreshold(
      [o("a", 4), o("b", 6), o("c", 5), o("d", 3)],
      7,
    );
    assert.deepEqual(
      picked.map((p) => p.key),
      ["b", "c"],
    );
    assert.equal(relaxed, true);
  });

  it("never shows an empty result when valid outfits exist, even all below 5", () => {
    const { picked, relaxed } = applyScoreThreshold([o("a", 2), o("b", 4)], 7);
    assert.deepEqual(
      picked.map((p) => p.key),
      ["b", "a"],
    );
    assert.equal(relaxed, true);
  });

  it("does not relax on the threshold-5 pass; empty means exhausted", () => {
    const { picked, relaxed } = applyScoreThreshold([o("a", 4), o("b", 3)], 5);
    assert.deepEqual(picked, []);
    assert.equal(relaxed, false);
  });

  it("empty input stays empty without relaxing", () => {
    const { picked, relaxed } = applyScoreThreshold([], 7);
    assert.deepEqual(picked, []);
    assert.equal(relaxed, false);
  });
});
