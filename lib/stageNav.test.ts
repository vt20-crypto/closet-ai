import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { stageDistance, stageStep } from "./stageNav.ts";

describe("stageStep", () => {
  it("advances and retreats within the page", () => {
    assert.equal(stageStep(0, 1, 3), 1);
    assert.equal(stageStep(1, 1, 3), 2);
    assert.equal(stageStep(2, -1, 3), 1);
  });

  it("wraps around both ends", () => {
    assert.equal(stageStep(2, 1, 3), 0);
    assert.equal(stageStep(0, -1, 3), 2);
  });

  it("stays put for a single look or an empty page", () => {
    assert.equal(stageStep(0, 1, 1), 0);
    assert.equal(stageStep(0, -1, 1), 0);
    assert.equal(stageStep(0, 1, 0), 0);
  });
});

describe("stageDistance", () => {
  it("measures forward steps with wrap", () => {
    assert.equal(stageDistance(0, 2, 3), 2);
    assert.equal(stageDistance(2, 0, 3), 1);
    assert.equal(stageDistance(1, 1, 3), 0);
  });
});
