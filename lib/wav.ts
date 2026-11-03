// Pure WAV helpers for voice input: resample to 16 kHz mono and encode a
// 16-bit PCM WAV in the browser. No I/O, no AudioContext — testable in node.

/** Linear-interpolation resample. Returns ceil(len * toRate / fromRate) samples. */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples.slice();
  if (fromRate <= 0 || toRate <= 0) throw new Error("sample rates must be positive");
  const outLen = Math.ceil((samples.length * toRate) / fromRate);
  const out = new Float32Array(outLen);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = pos - lo;
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
  }
  return out;
}

/** Encode mono float samples (-1..1) as a 16-bit PCM WAV. Sample rate is the caller's. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error("bad sample rate");
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buf);
}

/** 16-bit PCM byte size for seconds of mono audio at rate. Used for the ~2 MB cap. */
export function wavBytesFor(seconds: number, sampleRate: number): number {
  return 44 + Math.ceil(seconds * sampleRate) * 2;
}
