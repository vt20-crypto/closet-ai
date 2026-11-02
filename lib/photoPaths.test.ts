import test from "node:test";
import assert from "node:assert/strict";

import { isPhotoPathname, photoMetaPath } from "./photoPaths.ts";

test("isPhotoPathname accepts only single-level photos/ paths", () => {
  assert.equal(isPhotoPathname("photos/123-0.jpg"), true);
  assert.equal(isPhotoPathname("photos/a.png"), true);
  assert.equal(isPhotoPathname("https://evil.example/x.jpg"), false);
  assert.equal(isPhotoPathname("photos/../secret"), false);
  assert.equal(isPhotoPathname("photos/sub/x.jpg"), false);
  assert.equal(isPhotoPathname("items/abc.png"), false);
  assert.equal(isPhotoPathname(""), false);
  assert.equal(isPhotoPathname(null), false);
  assert.equal(isPhotoPathname(42), false);
});

test("photoMetaPath nests the meta under photos-meta/", () => {
  assert.equal(photoMetaPath("photos/123-0.jpg"), "photos-meta/photos/123-0.jpg.json");
});
