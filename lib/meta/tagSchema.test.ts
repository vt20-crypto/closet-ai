import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  allowedFitAxes,
  fitCategoryForType,
  normalizeFitTags,
  TAG_SCHEMA,
  type GarmentTags,
} from "./tagSchema.ts";

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
      "fit",
      "length",
      "sleeve",
      "rise",
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
      fit: "n/a",
      length: "n/a",
      sleeve: "n/a",
      rise: "n/a",
    };
    assert.deepEqual(
      Object.keys(tags).sort(),
      [...(TAG_SCHEMA.required as readonly string[])].sort(),
    );
  });
});

describe("fitCategoryForType", () => {
  it("routes free-text types to the right bucket", () => {
    assert.equal(fitCategoryForType("jeans"), "full-bottom");
    assert.equal(fitCategoryForType("Levi's jeans"), "full-bottom");
    assert.equal(fitCategoryForType("chino pants"), "full-bottom");
    assert.equal(fitCategoryForType("denim shorts"), "shorts");
    assert.equal(fitCategoryForType("t-shirt"), "top");
    assert.equal(fitCategoryForType("hoodie"), "top");
    assert.equal(fitCategoryForType("sweater"), "top");
    assert.equal(fitCategoryForType("wrap dress"), "dress");
    assert.equal(fitCategoryForType("pleated skirt"), "skirt");
    assert.equal(fitCategoryForType("denim jacket"), "jacket");
    assert.equal(fitCategoryForType("wool coat"), "jacket");
    assert.equal(fitCategoryForType("sneakers"), "shoes");
    assert.equal(fitCategoryForType("leather boots"), "shoes");
    assert.equal(fitCategoryForType("beanie"), "other");
    assert.equal(fitCategoryForType("mystery wrap"), "top");
  });
});

describe("normalizeFitTags", () => {
  it("passes valid jeans axes and n/as the rest", () => {
    assert.deepEqual(normalizeFitTags("jeans", "baggy", "ankle", "long", "high"), {
      fit: "baggy",
      length: "ankle",
      sleeve: "n/a",
      rise: "high",
    });
  });

  it("rejects wrong-bucket values to n/a", () => {
    assert.deepEqual(normalizeFitTags("jeans", "bodycon", "midi", "long", "low"), {
      fit: "n/a",
      length: "n/a",
      sleeve: "n/a",
      rise: "low",
    });
    assert.deepEqual(normalizeFitTags("hoodie", "oversized", "regular", "long", "high"), {
      fit: "oversized",
      length: "regular",
      sleeve: "long",
      rise: "n/a",
    });
    assert.deepEqual(normalizeFitTags("sneakers", "regular", "regular", "long", "mid"), {
      fit: "n/a",
      length: "n/a",
      sleeve: "n/a",
      rise: "n/a",
    });
  });

  it("treats mini-length dresses as short and blanks as n/a", () => {
    assert.deepEqual(normalizeFitTags("dress", "a-line", "short", null, undefined), {
      fit: "a-line",
      length: "short",
      sleeve: "n/a",
      rise: "n/a",
    });
  });
});

describe("allowedFitAxes", () => {
  it("offers only the values valid for the garment type", () => {
    assert.deepEqual(allowedFitAxes("jeans"), {
      fit: ["skinny","slim","regular","straight","relaxed","loose","baggy","wide-leg","bootcut","flared"],
      length: ["ankle", "full", "cropped"],
      sleeve: [],
      rise: ["low", "mid", "high"],
    });
    assert.deepEqual(allowedFitAxes("sneakers"), { fit: [], length: [], sleeve: [], rise: [] });
    assert.deepEqual(allowedFitAxes("hoodie").sleeve, ["sleeveless", "short", "three-quarter", "long"]);
  });
});
