import test from "node:test";
import assert from "node:assert/strict";

import { encodeWav, resampleLinear, wavBytesFor } from "./wav.ts";

function ascii(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

test("encodeWav writes a valid 16-bit mono header", () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000);
  assert.equal(wav.length, 44 + 5 * 2);
  const view = new DataView(wav.buffer);
  assert.equal(ascii(view, 0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + 10);
  assert.equal(ascii(view, 8, 4), "WAVE");
  assert.equal(ascii(view, 12, 4), "fmt ");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(view, 36, 4), "data");
  assert.equal(view.getUint32(40, true), 10);
  // Sample values: silence, half, clipped extremes.
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 16384);
  assert.equal(view.getInt16(48, true), -16383); // Math.round(-16383.5)
  assert.equal(view.getInt16(50, true), 32767);
  assert.equal(view.getInt16(52, true), -32767);
});

test("encodeWav clamps out-of-range input", () => {
  const wav = encodeWav(new Float32Array([2, -2]), 16000);
  const view = new DataView(wav.buffer);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32767);
});

test("resampleLinear 48kHz to 16kHz keeps duration", () => {
  const oneSec = new Float32Array(48000).fill(0.25);
  const out = resampleLinear(oneSec, 48000, 16000);
  assert.equal(out.length, 16000);
  assert.ok(out.every((v) => v === 0.25));
});

test("resampleLinear is identity at equal rates", () => {
  const src = new Float32Array([0.1, -0.2, 0.3]);
  assert.deepEqual([...resampleLinear(src, 16000, 16000)], [...src]);
});

test("wavBytesFor sizes the 20s cap under ~2MB", () => {
  assert.ok(wavBytesFor(20, 16000) < 2 * 1024 * 1024);
});
