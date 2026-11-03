import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TAG_SCHEMA, type GarmentTags } from "./tagSchema.ts";

describe("TAG_SCHEMA", () => {
  it("requires nickname alongside every other tag field (strict)", () => {
    const required = [...(TAG_SCHEMA.required as readonly string[])];
    for (const key of [
      "is_single_garment",
      "rejection_reason",
      "type",
      "primary_color",
      "secondary_colors",
      "formality",
      "warmth",
      "layer",
      "fabric_weight",
      "pattern",
      "seasons",
      "distinguishing_note",
      "nickname",
    ]) {
      assert.ok(required.includes(key), `required misses ${key}`);
    }
    assert.equal(TAG_SCHEMA.additionalProperties, false);
    assert.ok(
      (TAG_SCHEMA.properties as Record<string, unknown>).nickname,
      "properties misses nickname",
    );
  });

  it("a full GarmentTags object carries exactly the required keys", () => {
    const tags: GarmentTags = {
      is_single_garment: true,
      rejection_reason: null,
      type: "sneakers",
      primary_color: "white",
      secondary_colors: [],
      formality: 2,
      warmth: 2,
      layer: "base",
      fabric_weight: "light",
      pattern: "solid",
      seasons: ["summer"],
      distinguishing_note: "Red heel tab.",
      nickname: "Daily Runners",
    };
    assert.deepEqual(
      Object.keys(tags).sort(),
      [...(TAG_SCHEMA.required as readonly string[])].sort(),
    );
  });
});
