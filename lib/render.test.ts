import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { hashKey } from "./hash.ts";
import {
  buildAvatarPrompt,
  buildRenderPrompt,
  buildSavedLook,
  buildVerifyPrompt,
  decideVerification,
  describeGarmentFit,
  detectImageFormat,
  fitCorrection,
  fitSilhouette,
  lengthPhrase,
  RENDER_PROMPT,
  RENDER_PROMPT_VERSION,
  renderCacheKey,
  risePhrase,
  sleevePhrase,
} from "./render.ts";

describe("renderCacheKey", () => {
  it("is order-independent and version-scoped", () => {
    assert.equal(renderCacheKey("v1", ["b", "a"]), renderCacheKey("v1", ["a", "b"]));
    assert.notEqual(renderCacheKey("v1", ["a", "b"]), renderCacheKey("v2", ["a", "b"]));
    assert.notEqual(renderCacheKey("v1", ["a", "b"]), renderCacheKey("v1", ["a", "c"]));
    assert.match(renderCacheKey("v1", ["a"]), /^renders\/[0-9a-f]{8}$/);
  });

  it("invalidates renders cached before prompt versioning", () => {
    const legacy = `renders/${hashKey(["v1", "a", "s1"].join("|"))}`;
    assert.notEqual(renderCacheKey("v1", ["a"], "s1"), legacy);
    assert.ok(Number.isInteger(RENDER_PROMPT_VERSION) && RENDER_PROMPT_VERSION > 0);
  });

  it("changes when the closet stamp changes", () => {
    assert.equal(renderCacheKey("v1", ["a"], "s1"), renderCacheKey("v1", ["a"], "s1"));
    assert.notEqual(renderCacheKey("v1", ["a"], "s1"), renderCacheKey("v1", ["a"], "s2"));
  });
});

describe("decideVerification", () => {
  it("passes on a clean match", () => {
    assert.equal(decideVerification(true, [], 0), "pass");
    assert.equal(decideVerification(true, [], 1), "pass");
  });

  it("ignores expected base-layer bits and neutral shoes", () => {
    const minor = [
      { item: "plain base layer", major: false },
      { item: "white undershirt", major: false },
      { item: "gray socks", major: false },
      { item: "neutral shoes", major: false },
    ];
    assert.equal(decideVerification(true, minor, 0), "pass");
    assert.equal(decideVerification(true, minor, 1), "pass");
  });

  it("re-renders once on mismatch or a major invented garment, then accepts", () => {
    const major = [{ item: "red jacket", major: true }];
    assert.equal(decideVerification(false, [], 0), "rerender");
    assert.equal(decideVerification(true, major, 0), "rerender");
    assert.equal(decideVerification(false, [], 1), "accept");
    assert.equal(decideVerification(true, major, 1), "accept");
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

describe("detectImageFormat", () => {
  it("sniffs PNG, WEBP and JPEG by magic bytes", () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("payload"),
    ]);
    const webp = Buffer.concat([
      Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
      Buffer.from("payload"),
    ]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("payload")]);
    assert.deepEqual(detectImageFormat(png), { ext: "png", contentType: "image/png" });
    assert.deepEqual(detectImageFormat(webp), { ext: "webp", contentType: "image/webp" });
    assert.deepEqual(detectImageFormat(jpeg), { ext: "jpg", contentType: "image/jpeg" });
  });

  it("falls back to PNG on short or unknown bytes", () => {
    assert.deepEqual(detectImageFormat(Buffer.alloc(0)), {
      ext: "png",
      contentType: "image/png",
    });
    assert.deepEqual(detectImageFormat(Buffer.from("GIF89a....")), {
      ext: "png",
      contentType: "image/png",
    });
    // RIFF without the WEBP marker is not WebP.
    assert.deepEqual(
      detectImageFormat(Buffer.concat([Buffer.from("RIFF\x00\x00\x00\x00AVI "), Buffer.from("x")])),
      { ext: "png", contentType: "image/png" },
    );
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

describe("buildAvatarPrompt likeness", () => {
  it("adds the exact-likeness line only when an appearance brief exists", () => {
    const plain = buildAvatarPrompt({ vibe: "minimal" });
    assert.ok(!plain.includes("Preserve exact likeness"));
    const brief = "skin tone warm beige; hairstyle black bob";
    const prompt = buildAvatarPrompt({ vibe: "minimal", appearance: brief });
    assert.match(prompt, /Preserve exact likeness: skin tone warm beige; hairstyle black bob\./);
    assert.match(prompt, /Same skin tone, hairstyle, facial hair, glasses\./);
    assert.match(prompt, /NOT a store mannequin/);
  });
});

describe("fit phrases", () => {
  it("maps every documented fit to a silhouette phrase", () => {
    assert.match(fitSilhouette("baggy") ?? "", /wide straight leg/);
    assert.match(fitSilhouette("wide-leg") ?? "", /flaring wide from the hip/);
    assert.match(fitSilhouette("skinny") ?? "", /tight to the leg/);
    assert.match(fitSilhouette("oversized") ?? "", /dropped shoulders/);
    assert.match(fitSilhouette("bootcut") ?? "", /below the knee/);
    assert.match(fitSilhouette("a-line") ?? "", /widening toward the hem/);
  });

  it("maps length, rise and sleeve axes", () => {
    assert.equal(lengthPhrase("full"), "full length");
    assert.equal(lengthPhrase("cropped"), "cropped above the ankle");
    assert.equal(risePhrase("high"), "high-rise");
    assert.equal(sleevePhrase("long"), "long sleeves");
  });

  it("returns null for n/a, missing and unknown values", () => {
    for (const bad of ["n/a", "N/A", "", undefined, "balloon"]) {
      assert.equal(fitSilhouette(bad), null);
      assert.equal(lengthPhrase(bad), null);
      assert.equal(risePhrase(bad), null);
      assert.equal(sleevePhrase(bad), null);
    }
  });
});

describe("describeGarmentFit", () => {
  it("puts the fit phrase first, then color and type", () => {
    const line = describeGarmentFit({
      type: "jeans",
      primary_color: "blue",
      fit: "baggy",
      rise: "high",
      length: "full",
    });
    assert.ok(line.startsWith("baggy, very loose"), `fit first, got: ${line}`);
    assert.ok(line.includes("high-rise"), `rise included, got: ${line}`);
    assert.ok(line.endsWith("blue jeans"), `color+type last, got: ${line}`);
  });

  it("falls back to color + type with no fit info", () => {
    assert.equal(
      describeGarmentFit({ type: "shoe", primary_color: "white", fit: "n/a" }),
      "white shoe",
    );
  });
});

describe("buildRenderPrompt", () => {
  it("keeps the base prompt and adds fit lines with the override rule", () => {
    const prompt = buildRenderPrompt([
      { type: "jeans", primary_color: "blue", fit: "baggy", rise: "high", length: "full" },
      { type: "t-shirt", primary_color: "white", fit: "relaxed" },
    ]);
    assert.ok(prompt.startsWith(RENDER_PROMPT));
    assert.ok(prompt.includes("- baggy, very loose"), "baggy line present");
    assert.ok(prompt.includes("FIT described in text overrides"), "override rule present");
  });

  it("is the base prompt alone with no garments", () => {
    assert.equal(buildRenderPrompt([]), RENDER_PROMPT);
  });
});

describe("buildVerifyPrompt", () => {
  it("names fits and flags wrong-fit tops/bottoms as major", () => {
    const prompt = buildVerifyPrompt(["baggy, very loose blue jeans"]);
    assert.ok(prompt.includes("baggy, very loose blue jeans"));
    assert.ok(prompt.includes("wrong fit"), "wrong-fit rule present");
    assert.ok(prompt.includes("major invented item"), "major rule present");
  });

  it("omits the fit section with no fits", () => {
    assert.ok(!buildVerifyPrompt([]).includes("Expected fits"));
  });
});

describe("fitCorrection", () => {
  it("names the expected fit for a garment in the look", () => {
    const correction = fitCorrection("jeans look slim, expected baggy wide-leg", [
      { type: "jeans", primary_color: "blue", fit: "baggy" },
    ]);
    assert.ok(correction?.startsWith("Make the blue jeans clearly baggy"), `got: ${correction}`);
  });

  it("returns null when nothing in the look matches", () => {
    assert.equal(fitCorrection("red jacket", [{ type: "jeans", fit: "baggy" }]), null);
    assert.equal(
      fitCorrection("jeans", [{ type: "jeans", primary_color: "blue", fit: "n/a" }]),
      null,
    );
  });
});
