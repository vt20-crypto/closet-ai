import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildAvatarPrompt,
  buildSavedLook,
  decideVerification,
  RENDER_PROMPT,
  renderCacheKey,
} from "./render.ts";

describe("renderCacheKey", () => {
  it("is order-independent and version-scoped", () => {
    assert.equal(renderCacheKey("v1", ["b", "a"]), renderCacheKey("v1", ["a", "b"]));
    assert.notEqual(renderCacheKey("v1", ["a", "b"]), renderCacheKey("v2", ["a", "b"]));
    assert.notEqual(renderCacheKey("v1", ["a", "b"]), renderCacheKey("v1", ["a", "c"]));
    assert.match(renderCacheKey("v1", ["a"]), /^renders\/[0-9a-f]{8}$/);
  });
});

describe("decideVerification", () => {
  it("passes on match, re-renders once, then falls back", () => {
    assert.equal(decideVerification(true, 0), "pass");
    assert.equal(decideVerification(false, 0), "rerender");
    assert.equal(decideVerification(false, 1), "fallback");
    assert.equal(decideVerification(true, 1), "pass");
  });
});

describe("buildAvatarPrompt", () => {
  it("maps each vibe to a pose and expression", () => {
    assert.match(buildAvatarPrompt({ vibe: "playful" }), /bright smile/);
    assert.match(buildAvatarPrompt({ vibe: "minimal" }), /neutral front-facing pose/);
    assert.match(buildAvatarPrompt({ vibe: "edgy" }), /confident smirk/);
    assert.match(buildAvatarPrompt({ vibe: "classic" }), /gentle smile/);
    assert.match(buildAvatarPrompt({}), /NOT a store mannequin/);
  });

  it("folds height, build and hair into the prompt", () => {
    const prompt = buildAvatarPrompt({ height: "tall", build: "athletic", hairNote: "black bob" });
    assert.match(prompt, /tall height/);
    assert.match(prompt, /athletic build/);
    assert.match(prompt, /black bob/);
    assert.match(prompt, /grey fitted base layer/);
    assert.match(RENDER_PROMPT, /ONLY in the provided garment images/);
  });
});

describe("buildSavedLook", () => {
  it("keeps date, time and place on the look", () => {
    assert.deepEqual(
      buildSavedLook(["a", "b"], { date: "2026-11-05", timeOfDay: "evening", place: "Roma", renderUrl: "https://x/y.png" }),
      {
        itemIds: ["a", "b"],
        date: "2026-11-05",
        timeOfDay: "evening",
        place: "Roma",
        renderUrl: "https://x/y.png",
      },
    );
    assert.deepEqual(buildSavedLook([], {}), {
      itemIds: [],
      date: null,
      timeOfDay: null,
      place: null,
      renderUrl: null,
    });
  });
});
