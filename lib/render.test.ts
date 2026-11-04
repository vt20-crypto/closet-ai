import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildAvatarPrompt,
  buildSavedLook,
  decideVerification,
  detectImageFormat,
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
