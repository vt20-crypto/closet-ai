import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { tapeLabel } from "./labels.ts";

describe("tapeLabel", () => {
  it("prefers the nickname when present", () => {
    assert.equal(
      tapeLabel({ nickname: "Daily Levi's", primary_color: "blue", type: "jeans" }),
      "Daily Levi's",
    );
  });

  it("trims a padded nickname", () => {
    assert.equal(
      tapeLabel({ nickname: "  Walkable ", primary_color: "brown", type: "boots" }),
      "Walkable",
    );
  });

  it("falls back to '<primary_color> <type>' when nickname is missing", () => {
    assert.equal(
      tapeLabel({ primary_color: "blue", type: "denim jacket" }),
      "blue denim jacket",
    );
    assert.equal(
      tapeLabel({ nickname: "", primary_color: "blue", type: "denim jacket" }),
      "blue denim jacket",
    );
    assert.equal(
      tapeLabel({ nickname: null, primary_color: "grey", type: "coat" }),
      "grey coat",
    );
  });
});
