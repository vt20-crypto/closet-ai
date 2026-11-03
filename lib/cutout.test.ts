import test from "node:test";
import assert from "node:assert/strict";

import sharp from "sharp";

import { buildUnionRaster, fillEnclosedHoles, flattenForTag, sampleMask } from "./cutout.ts";

function render(raster: Uint8Array, w: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < raster.length / w; y += 1) {
    let row = "";
    for (let x = 0; x < w; x += 1) row += raster[y * w + x] === 1 ? "#" : ".";
    rows.push(row);
  }
  return rows;
}

test("fillEnclosedHoles fills a fully enclosed hole (logo/tag inside garment)", () => {
  // 7x7 solid garment with a 3x3 hole in the middle.
  const w = 7;
  const h = 7;
  const raster = new Uint8Array(w * h).fill(1);
  for (let y = 2; y <= 4; y += 1) {
    for (let x = 2; x <= 4; x += 1) raster[y * w + x] = 0;
  }
  const filled = fillEnclosedHoles(raster, w, h);
  assert.deepEqual(Array.from(filled), Array.from(new Uint8Array(w * h).fill(1)));
});

test("fillEnclosedHoles turns a hollow ring into a filled disc", () => {
  // 7x7 ring: only the border is garment.
  const w = 7;
  const h = 7;
  const raster = new Uint8Array(w * h);
  for (let x = 0; x < w; x += 1) {
    raster[x] = 1;
    raster[(h - 1) * w + x] = 1;
  }
  for (let y = 0; y < h; y += 1) {
    raster[y * w] = 1;
    raster[y * w + w - 1] = 1;
  }
  const filled = fillEnclosedHoles(raster, w, h);
  assert.deepEqual(
    render(filled, w),
    ["#######", "#######", "#######", "#######", "#######", "#######", "#######"],
  );
});

test("fillEnclosedHoles keeps background connected to the border", () => {
  // U-shape open at the top: interior zeros connect to the border, stay 0.
  const w = 5;
  const h = 5;
  const raster = new Uint8Array([
    1, 0, 0, 0, 1,
    1, 0, 0, 0, 1,
    1, 0, 0, 0, 1,
    1, 0, 0, 0, 1,
    1, 1, 1, 1, 1,
  ]);
  const filled = fillEnclosedHoles(raster, w, h);
  assert.deepEqual(Array.from(filled), Array.from(raster));
});

test("fillEnclosedHoles does not mutate its input", () => {
  const raster = new Uint8Array([1, 1, 1, 1, 0, 1, 1, 1, 1]);
  const before = Array.from(raster);
  fillEnclosedHoles(raster, 3, 3);
  assert.deepEqual(Array.from(raster), before);
});

test("buildUnionRaster unions two side-by-side masks", () => {
  const left = {
    box: { left: 0, top: 0, right: 4, bottom: 4 },
    raster: new Uint8Array(16).fill(1),
    maskWidth: 4,
    maskHeight: 4,
  };
  const right = {
    box: { left: 6, top: 0, right: 10, bottom: 4 },
    raster: new Uint8Array(16).fill(1),
    maskWidth: 4,
    maskHeight: 4,
  };
  const union = { left: 0, top: 0, right: 10, bottom: 4 };
  const out = buildUnionRaster([left, right], union);
  // Gap columns (4,5) stay 0; everything covered by a shoe is 1.
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      const expected = x === 4 || x === 5 ? 0 : 1;
      assert.equal(out[y * 10 + x], expected, `pixel (${x},${y})`);
    }
  }
});

test("flattenForTag shrinks to 512px and outputs JPEG", async () => {
  const big = await sharp({
    create: { width: 1600, height: 1200, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
  const flat = await flattenForTag(big);
  assert.equal(flat[0], 0xff);
  assert.equal(flat[1], 0xd8);
  const meta = await sharp(flat).metadata();
  assert.ok((meta.width ?? 0) <= 512 && (meta.height ?? 0) <= 512);
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 384);
});

test("flattenForTag never enlarges small cutouts", async () => {
  const small = await sharp({
    create: { width: 100, height: 80, channels: 4, background: { r: 30, g: 30, b: 200, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const flat = await flattenForTag(small);
  const meta = await sharp(flat).metadata();
  assert.equal(meta.width, 100);
  assert.equal(meta.height, 80);
});

test("sampleMask maps image pixels into the box", () => {
  // 2x2 mask, only bottom-right set, over a 4x4 image box at (0,0)-(4,4).
  const raster = new Uint8Array([0, 0, 0, 1]);
  const box = { left: 0, top: 0, right: 4, bottom: 4 };
  assert.equal(sampleMask(raster, 2, 2, box, 3, 3), true);
  assert.equal(sampleMask(raster, 2, 2, box, 0, 0), false);
  assert.equal(sampleMask(raster, 2, 2, box, 9, 9), false);
});
