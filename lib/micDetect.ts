/**
 * RMS speech detection for the tap-to-talk button (pure, unit-tested).
 *
 * The button samples microphone blocks via Web Audio; speech is present when
 * the block RMS reaches SPEECH_RMS. Once speech was heard, ~1.5 s of quiet
 * ends the recording so the user doesn't have to tap stop.
 */

export const SPEECH_RMS = 0.008;
export const SILENCE_STOP_MS = 1500;
/** Leading audio ignored (tap thumps, mic settling). */
export const LISTEN_GRACE_MS = 300;

/** Root-mean-square level of one mono sample block, 0 when empty. */
export function rms(block: ArrayLike<number>): number {
  if (block.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < block.length; i += 1) {
    const v = block[i] as number;
    sum += v * v;
  }
  return Math.sqrt(sum / block.length);
}

/**
 * Silence-based auto-stop. Push one RMS level per audio block; returns
 * "stop" once SILENCE_STOP_MS of quiet follows detected speech. The first
 * LISTEN_GRACE_MS never stops.
 */
export class SilenceStopper {
  private firstAt: number | null = null;
  private lastSpeechAt = 0;
  private heard = false;
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  push(level: number): "listening" | "stop" {
    const t = this.now();
    if (this.firstAt === null) this.firstAt = t;
    if (t - this.firstAt < LISTEN_GRACE_MS) return "listening";
    if (level >= SPEECH_RMS) {
      this.heard = true;
      this.lastSpeechAt = t;
      return "listening";
    }
    if (this.heard && t - this.lastSpeechAt >= SILENCE_STOP_MS) return "stop";
    return "listening";
  }

  get speechDetected(): boolean {
    return this.heard;
  }
}
