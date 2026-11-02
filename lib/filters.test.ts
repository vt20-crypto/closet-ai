import test from "node:test";
import assert from "node:assert/strict";

import {
  boxIoU,
  dedupeDetections,
  mergeFootwearPairs,
  shouldMergeShoePair,
  type FilterDetection,
} from "./filters.ts";

function det(noun: string, box: FilterDetection["box"], confidence: number): FilterDetection {
  return { noun, box, confidence };
}

test("boxIoU is 1 for identical boxes and 0 for disjoint boxes", () => {
  const a = { left: 0, top: 0, right: 10, bottom: 10 };
  assert.equal(boxIoU(a, { ...a }), 1);
  assert.equal(boxIoU(a, { left: 20, top: 20, right: 30, bottom: 30 }), 0);
});

test("dedupeDetections keeps the highest-confidence detection above IoU 0.6", () => {
  const shirt = det("shirt", { left: 0, top: 0, right: 100, bottom: 100 }, 0.95);
  const tshirt = det("t-shirt", { left: 5, top: 5, right: 100, bottom: 100 }, 0.98);
  const pants = det("pants", { left: 0, top: 200, right: 100, bottom: 300 }, 0.97);
  const kept = dedupeDetections([shirt, tshirt, pants]);
  assert.equal(kept.length, 2);
  assert.ok(kept.some((d) => d.noun === "t-shirt"));
  assert.ok(kept.some((d) => d.noun === "pants"));
});

test("dedupeDetections keeps both detections at or below IoU 0.6", () => {
  const a = det("shirt", { left: 0, top: 0, right: 100, bottom: 100 }, 0.95);
  const b = det("jacket", { left: 50, top: 0, right: 150, bottom: 100 }, 0.96);
  assert.ok(boxIoU(a.box, b.box) < 0.6);
  assert.equal(dedupeDetections([a, b]).length, 2);
});

test("shouldMergeShoePair merges side-by-side shoes", () => {
  const left = { left: 10, top: 20, right: 50, bottom: 80 };
  const right = { left: 55, top: 22, right: 95, bottom: 78 };
  assert.equal(shouldMergeShoePair(left, right), true);
});

test("shouldMergeShoePair rejects shoes far apart", () => {
  const left = { left: 10, top: 20, right: 50, bottom: 80 };
  const far = { left: 200, top: 22, right: 240, bottom: 78 };
  assert.equal(shouldMergeShoePair(left, far), false);
});

test("shouldMergeShoePair rejects stacked shoes (no vertical overlap)", () => {
  const top = { left: 10, top: 0, right: 50, bottom: 40 };
  const bottom = { left: 12, top: 60, right: 52, bottom: 100 };
  assert.equal(shouldMergeShoePair(top, bottom), false);
});

test("shouldMergeShoePair rejects mismatched heights", () => {
  const tall = { left: 10, top: 0, right: 50, bottom: 100 };
  const short = { left: 55, top: 60, right: 95, bottom: 100 };
  assert.equal(shouldMergeShoePair(tall, short), false);
});

test("mergeFootwearPairs merges one pair and leaves shirts alone", () => {
  const detections = [
    det("shoe", { left: 10, top: 20, right: 50, bottom: 80 }, 0.95),
    det("shirt", { left: 0, top: 200, right: 100, bottom: 300 }, 0.99),
    det("sneaker", { left: 55, top: 22, right: 95, bottom: 78 }, 0.93),
  ];
  const { merged, singles } = mergeFootwearPairs(detections);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.nouns, ["shoe", "sneaker"]);
  assert.deepEqual(merged[0]?.box, { left: 10, top: 20, right: 95, bottom: 80 });
  assert.equal(merged[0]?.confidence, 0.95);
  assert.equal(merged[0]?.sources.length, 2);
  assert.equal(singles.length, 1);
  assert.equal(singles[0]?.noun, "shirt");
});

test("mergeFootwearPairs leaves lone shoes single", () => {
  const detections = [det("boot", { left: 10, top: 20, right: 50, bottom: 80 }, 0.95)];
  const { merged, singles } = mergeFootwearPairs(detections);
  assert.equal(merged.length, 0);
  assert.equal(singles.length, 1);
});
