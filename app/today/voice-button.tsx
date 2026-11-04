"use client";

import { useEffect, useRef, useState } from "react";

import { encodeWav, resampleLinear } from "@/lib/wav";
import { stopSpeech, unlockSpeech } from "@/lib/speak";

export interface VoiceSlots {
  mood: string | null;
  occasion: string | null;
  occasion_text: string | null;
  destination: string | null;
  city: string | null;
}

interface VoiceButtonProps {
  disabled: boolean;
  /** Bias words for recognition (mood + occasion chips and friends). */
  keywords: string[];
  onResult: (transcript: string, slots: VoiceSlots) => void;
  /** Status line; speakIt also reads it aloud (errors). */
  report: (message: string, speakIt?: boolean) => void;
  /** Fires when the mic opens/closes so the host can yield shared hardware. */
  onActiveChange?: (active: boolean) => void;
}

type Phase = "idle" | "listening" | "working";

const MAX_LISTEN_MS = 20_000;
const SILENCE_PEAK = 0.02;

interface Recording {
  stream: MediaStream;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  proc: ScriptProcessorNode;
  chunks: Float32Array[];
  rate: number;
  peak: number;
  timer: number;
}

/**
 * Big talk/listen button. Records with getUserMedia + Web Audio (the
 * AudioContext is created inside the tap for iOS), resamples to 16 kHz mono,
 * encodes 16-bit PCM WAV in the browser, and POSTs it to /api/transcribe.
 */
export default function VoiceButton({ disabled, keywords, onResult, report, onActiveChange }: VoiceButtonProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const recRef = useRef<Recording | null>(null);

  // Mic open/close signal for hosts sharing hardware (camera + mic on iOS).
  function setActivePhase(next: Phase) {
    setPhase(next);
    onActiveChange?.(next === "listening");
  }

  // Stop any in-flight recording on unmount; never leave the mic open.
  useEffect(() => {
    return () => {
      const rec = recRef.current;
      recRef.current = null;
      if (rec) {
        window.clearTimeout(rec.timer);
        rec.stream.getTracks().forEach((t) => t.stop());
        void rec.ctx.close().catch(() => undefined);
      }
      stopSpeech();
    };
  }, []);

  async function finish() {
    const rec = recRef.current;
    recRef.current = null;
    if (!rec) return;
    window.clearTimeout(rec.timer);
    rec.stream.getTracks().forEach((t) => t.stop());
    try {
      await rec.ctx.close();
    } catch {
      // Already closed; the captured chunks are still usable.
    }
    if (rec.peak < SILENCE_PEAK || rec.chunks.length === 0) {
      setActivePhase("idle");
      report("I didn't hear anything — try again.", true);
      return;
    }
    setActivePhase("working");
    report("Transcribing…");
    try {
      const total = rec.chunks.reduce((n, c) => n + c.length, 0);
      const mono = new Float32Array(total);
      let offset = 0;
      for (const c of rec.chunks) {
        mono.set(c, offset);
        offset += c.length;
      }
      const wav = encodeWav(resampleLinear(mono, rec.rate, 16000), 16000);
      const res = await fetch(`/api/transcribe?keywords=${encodeURIComponent(keywords.join(","))}`, {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: wav as BodyInit,
      });
      const body = (await res.json()) as {
        transcript?: string;
        slots?: VoiceSlots;
        error?: string;
      };
      if (!res.ok || !body.transcript) throw new Error(body.error ?? `HTTP ${res.status}`);
      setActivePhase("idle");
      onResult(body.transcript, body.slots ?? { mood: null, occasion: null, occasion_text: null, destination: null, city: null });
    } catch (err) {
      setActivePhase("idle");
      const message = err instanceof Error ? err.message : "Transcription failed.";
      report(`Couldn't transcribe: ${message}`, true);
    }
  }

  function cancelTimer(rec: Recording) {
    window.clearTimeout(rec.timer);
  }

  async function toggle() {
    if (phase === "listening") {
      const rec = recRef.current;
      if (rec) cancelTimer(rec);
      await finish();
      return;
    }
    if (phase !== "idle" || disabled) return;
    // User tap chain: prime speech (iOS) and stop any readout first.
    unlockSpeech();
    stopSpeech();
    if (!("mediaDevices" in navigator) || typeof AudioContext === "undefined") {
      report("This browser can't record audio — type your outfit request instead.", true);
      return;
    }
    try {
      report("Listening… tap again to stop.");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const Ctx = window.AudioContext;
      const ctx = new Ctx();
      if (ctx.state === "suspended") await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const rec: Recording = { stream, ctx, source, proc, chunks: [], rate: ctx.sampleRate, peak: 0, timer: 0 };
      proc.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        rec.chunks.push(new Float32Array(input));
        for (let i = 0; i < input.length; i++) {
          const v = Math.abs(input[i]);
          if (v > rec.peak) rec.peak = v;
        }
      };
      source.connect(proc);
      proc.connect(ctx.destination);
      rec.timer = window.setTimeout(() => void finish(), MAX_LISTEN_MS);
      recRef.current = rec;
      setActivePhase("listening");
    } catch (err) {
      setActivePhase("idle");
      const denied = err instanceof Error && err.name === "NotAllowedError";
      report(
        denied
          ? "Microphone is blocked — allow it in the browser, then try again."
          : "Couldn't start recording — type your outfit request instead.",
        true,
      );
    }
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={disabled && phase === "idle"}
      aria-pressed={phase === "listening"}
      aria-label={phase === "listening" ? "Stop listening" : "Talk to plan your outfit"}
      className={`flex min-h-16 items-center justify-center gap-3 rounded-full bg-(--primary) px-6 text-xl font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text) ${
        phase === "listening" ? "animate-mic-pulse" : ""
      }`}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
      {phase === "listening" ? "Listening… tap to stop" : phase === "working" ? "Transcribing…" : "Tap to talk"}
    </button>
  );
}
