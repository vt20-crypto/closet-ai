import test from "node:test";
import assert from "node:assert/strict";

import { LISTEN_GRACE_MS, rms, SILENCE_STOP_MS, SilenceStopper, SPEECH_RMS } from "./micDetect.ts";

test("rms is 0 for silence and ~0.707 for a full-scale sine", () => {
  assert.equal(rms(new Float32Array(128)), 0);
  assert.equal(rms([] as unknown as Float32Array), 0);
  const sine = new Float32Array(256);
  for (let i = 0; i < sine.length; i += 1) sine[i] = Math.sin((2 * Math.PI * i) / sine.length);
  assert.ok(Math.abs(rms(sine) - Math.SQRT1_2) < 0.01);
});

test("rms of a whisper-quiet block stays below the speech threshold", () => {
  const quiet = new Float32Array(256).fill(0.003);
  assert.ok(rms(quiet) < SPEECH_RMS);
  const voice = new Float32Array(256).fill(0.05);
  assert.ok(rms(voice) >= SPEECH_RMS);
});

test("SilenceStopper ignores the grace period and pre-speech quiet", () => {
  let t = 1000;
  const stopper = new SilenceStopper(() => t);
  assert.equal(stopper.push(0), "listening");
  t += LISTEN_GRACE_MS + SILENCE_STOP_MS + 1000;
  assert.equal(stopper.push(0), "listening");
  assert.equal(stopper.speechDetected, false);
});

test("SilenceStopper stops after sustained silence following speech", () => {
  let t = 0;
  const stopper = new SilenceStopper(() => t);
  assert.equal(stopper.push(0), "listening");
  t += LISTEN_GRACE_MS + 10;
  assert.equal(stopper.push(SPEECH_RMS + 0.01), "listening");
  assert.equal(stopper.speechDetected, true);
  t += SILENCE_STOP_MS - 100;
  assert.equal(stopper.push(0), "listening");
  t += 100;
  assert.equal(stopper.push(0), "stop");
});

test("SilenceStopper keeps listening while speech continues", () => {
  let t = 0;
  const stopper = new SilenceStopper(() => t);
  stopper.push(0);
  for (let i = 0; i < 10; i += 1) {
    t += LISTEN_GRACE_MS;
    assert.equal(stopper.push(SPEECH_RMS + 0.02), "listening");
  }
});
