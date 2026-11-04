"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { beep, unlockBeep } from "@/lib/beep";
import type { ClosetItem } from "@/lib/closet";
import { normalizeTimeOfDay, resolveDateText } from "@/lib/when";
import {
  advance,
  backStep,
  createDressState,
  currentStep,
  orderSteps,
  skipStep,
  toDressItem,
  type DressItem,
  type DressState,
} from "@/lib/dress";
import { speak, unlockSpeech } from "@/lib/speak";
import { META_UNAVAILABLE_CODE } from "@/lib/meta/retry";

import { Sticker } from "../sticker";
import VoiceButton from "../style/voice-button";

/** DressItem (order/slot/nickname) plus the display fields the page speaks. */
interface ClosetView extends DressItem {
  cutoutUrl: string;
  type: string;
  primary_color: string;
  distinguishing_note: string;
}

interface TraceEntry {
  tool: string;
  detail: string;
}

type Phase = "loading" | "need-outfit" | "ready" | "guiding" | "finished";

const LOCAL_COMMANDS = /\b(repeat|back|skip|next)\b/i;
const REPLAN_KEYWORDS = [
  "repeat",
  "back",
  "skip",
  "next",
  "done",
  "laundry",
  "cold",
  "hot",
  "shoes",
  "dress",
  "finish",
  "again",
];
const START_KEYWORDS = [
  "brunch",
  "party",
  "work",
  "date",
  "lazy",
  "cozy",
  "dinner",
  "gym",
  "class",
  "wedding",
  "interview",
  "birthday",
];

/** Spoken + visible instruction for the current step. */
function guidanceFor(state: DressState, items: Record<string, ClosetView>): string {
  const step = currentStep(state);
  if (!step) return "You're ready.";
  const item = items[step.itemId];
  if (!item) return "Find your next item.";
  const total = state.steps.length;
  const detail = item.distinguishing_note ? ` ${item.distinguishing_note}.` : "";
  return (
    `Step ${state.index + 1} of ${total}. Find your ${item.nickname}, ` +
    `the ${item.primary_color} ${item.type}.${detail}`
  );
}

export default function DressPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [items, setItems] = useState<Record<string, ClosetView>>({});
  const [dress, setDress] = useState<DressState | null>(null);
  const [status, setStatus] = useState("Loading your closet…");
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [wantedIds, setWantedIds] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [skippedIds, setSkippedIds] = useState<string[]>([]);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraFailed, setCameraFailed] = useState(false);
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dressRef = useRef<DressState | null>(null);
  const itemsRef = useRef<Record<string, ClosetView>>({});
  const phaseRef = useRef<Phase>("loading");
  dressRef.current = dress;
  itemsRef.current = items;
  phaseRef.current = phase;

  // iOS can't reliably run the camera and the mic together: stop the camera
  // tracks while recording, then resume the preview when the mic closes.
  function handleVoiceActive(active: boolean) {
    if (active) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraReady(false);
    } else if (phaseRef.current === "guiding") {
      void ensureCamera();
    }
  }

  function say(text: string) {
    setStatus(text);
    speak(text);
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraReady(false);
  }

  useEffect(() => stopCamera, []);

  // Load the closet once; ?ids= starts an outfit, otherwise voice starts one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const ids = (params.get("ids") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      setWantedIds(ids.length > 0 ? ids : null);
      try {
        const res = await fetch("/api/closet", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Real API shape: display fields nested under tags; toDressItem flattens.
        const body = (await res.json()) as { items?: ClosetItem[] };
        const byId: Record<string, ClosetView> = {};
        for (const item of body.items ?? []) {
          if (!item || typeof item.id !== "string") continue;
          const flat = toDressItem(item);
          byId[item.id] = {
            ...flat,
            cutoutUrl: typeof item.cutoutUrl === "string" ? item.cutoutUrl : "",
            type: item.tags?.type ?? "other",
            primary_color: item.tags?.primary_color ?? "",
            distinguishing_note: item.tags?.distinguishing_note ?? "",
          };
        }
        if (cancelled) return;
        setItems(byId);
        if (ids.length === 0) {
          setPhase("need-outfit");
          setStatus("Tell me the occasion and I'll pick an outfit to dress you in.");
          return;
        }
        const usable = ids.filter((id) => Boolean(byId[id]?.type));
        const missing = ids.filter((id) => !byId[id]?.type);
        if (usable.length === 0) {
          setPhase("need-outfit");
          setStatus("That outfit isn't in the closet anymore. Tell me the occasion instead.");
          return;
        }
        if (missing.length > 0) {
          setSkippedIds(missing);
          startWithIds(usable, byId);
          setStatus(
            `Some items in this outfit couldn't be loaded: ${missing.join(", ")}. Starting with the rest. Tap Start getting dressed.`,
          );
          return;
        }
        startWithIds(ids, byId);
      } catch {
        if (!cancelled) {
          setLoadError(true);
          setPhase("need-outfit");
          setStatus("Couldn't load the closet. Check your connection, then reload.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function startWithIds(ids: string[], byId: Record<string, ClosetView>) {
    setDress(createDressState(orderSteps(ids.map((id) => byId[id]))));
    setPhase("ready");
    setStatus("Outfit ready. Tap Start getting dressed, then tap anywhere to check each item.");
  }

  async function ensureCamera(): Promise<boolean> {
    // No overlapping starts: a tap right after voice must not double-open.
    if (startingRef.current) return false;
    startingRef.current = true;
    setCameraFailed(false);
    try {
      if (streamRef.current) {
        setCameraReady(true);
        return true;
      }
      if (!("mediaDevices" in navigator) || !navigator.mediaDevices.getUserMedia) {
        setCameraFailed(true);
        return false;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
        // Wait until frames actually flow; a playing-but-empty stream
        // snapshots black, so the tap target stays shut until ready.
        const t0 = Date.now();
        while (videoRef.current.readyState < 2 && Date.now() - t0 < 4000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const ready =
        !!streamRef.current && !!videoRef.current && videoRef.current.readyState >= 2;
      setCameraReady(ready);
      if (!ready) setCameraFailed(true);
      return ready;
    } catch {
      setCameraFailed(true);
      return false;
    } finally {
      startingRef.current = false;
    }
  }

  // After any transition into guiding, (re)attach once the preview element
  // has mounted — startAgain relies on this (its own call would run first).
  useEffect(() => {
    if (phase === "guiding" && !streamRef.current) void ensureCamera();
  }, [phase]);

  function snapPhoto(): Promise<Blob | null> {
    return new Promise((resolve) => {
      try {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || video.videoWidth === 0) {
          resolve(null);
          return;
        }
        const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85);
      } catch {
        resolve(null);
      }
    });
  }

  function startSession() {
    unlockSpeech();
    unlockBeep();
    beep();
    void ensureCamera();
    const state = dressRef.current;
    if (!state) return;
    setPhase("guiding");
    say(guidanceFor(state, itemsRef.current));
  }

  function isFinalStep(state: DressState): boolean {
    return state.steps.slice(state.index + 1).every((step) => step.status !== "todo");
  }

  async function checkBlob(blob: Blob, state: DressState) {
    const step = currentStep(state);
    if (!step) return;
    setBusy(true);
    setStatus("Checking what you're wearing…");
    try {
      const form = new FormData();
      form.append("snapshot", blob, "snapshot.jpg");
      form.append("targetId", step.itemId);
      form.append(
        "outfitIds",
        JSON.stringify(state.steps.map((s) => s.itemId)),
      );
      form.append("finalStep", isFinalStep(state) ? "1" : "0");
      const res = await fetch("/api/dress/check", { method: "POST", body: form });
      const body = (await res.json()) as {
        verdict?: string;
        say?: string;
        compliment?: string | null;
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        const failure = new Error(body.error ?? `HTTP ${res.status}`);
        (failure as { code?: string }).code = body.code;
        throw failure;
      }
      if (body.verdict === "match") {
        beep(760);
        const next = advance(state);
        setDress(next);
        if (next.done) {
          finishSession(body.compliment ?? null);
        } else {
          say(guidanceFor(next, itemsRef.current));
        }
      } else if (body.verdict === "wrong_item") {
        beep(330);
        say(body.say ?? "That looks like a different item. Try again.");
      } else {
        beep(440);
        say(body.say ?? "I couldn't tell. Try a closer or better-lit photo.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Check failed.";
      if ((err as { code?: string }).code === META_UNAVAILABLE_CODE) {
        say("I couldn't check that one. Tap to try again, or say skip.");
      } else {
        say(`Couldn't check: ${message}`);
      }
    } finally {
      setBusy(false);
    }
  }

  function stopSession() {
    stopCamera();
    setTrace([]);
    setBusy(false);
    const state = dressRef.current;
    if (state) setDress(createDressState(state.steps.map((step) => step.itemId)));
    setPhase("ready");
    setStatus("Stopped. Tap Start getting dressed to begin again, or pick another outfit below.");
  }

  // Back to /style with the same results (session restore): router.back
  // when this page was reached from there, plain navigation otherwise.
  function backToStyle() {
    stopCamera();
    if (window.history.length > 1) {
      router.back();
    } else {
      router.push("/style");
    }
  }

  function startAgain() {
    const state = dressRef.current;
    if (!state) return;
    unlockSpeech();
    unlockBeep();
    beep();
    const fresh = createDressState(state.steps.map((step) => step.itemId));
    setDress(fresh);
    setTrace([]);
    setPhase("guiding");
    say(guidanceFor(fresh, itemsRef.current));
  }

  function finishSession(compliment: string | null) {
    stopCamera();
    setPhase("finished");
    beep(660);
    window.setTimeout(() => beep(880), 180);
    say(`You're ready. ${compliment ?? "Looking sharp."}`);
  }

  async function tapToCheck() {
    const state = dressRef.current;
    if (!state || busy || phase !== "guiding") return;
    if (!cameraReady && !cameraFailed) return;
    const photo = await snapPhoto();
    if (!photo) {
      // No live camera: fall back to the capture picker.
      setStatus("Take a photo of what you're wearing.");
      fileRef.current?.click();
      return;
    }
    await checkBlob(photo, state);
  }

  function afterLocalMove(next: DressState, line: string) {
    setDress(next);
    beep();
    if (next.done) {
      finishSession(null);
    } else {
      say(`${line} ${guidanceFor(next, itemsRef.current)}`);
    }
  }

  async function handleVoiceCommand(transcript: string) {
    const state = dressRef.current;
    if (!state || phase !== "guiding") return;
    const match = transcript.toLowerCase().match(LOCAL_COMMANDS)?.[1]?.toLowerCase();
    if (match === "repeat") {
      say(guidanceFor(state, itemsRef.current));
      return;
    }
    if (match === "back") {
      const next = backStep(state);
      setDress(next);
      beep();
      say(`Back one. ${guidanceFor(next, itemsRef.current)}`);
      return;
    }
    if (match === "skip" || match === "next") {
      afterLocalMove(skipStep(state), "Skipped.");
      return;
    }
    // Anything else goes to the replan agent.
    setBusy(true);
    setStatus("Thinking…");
    try {
      const res = await fetch("/api/dress/replan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, transcript }),
      });
      const body = (await res.json()) as {
        say?: string;
        state?: DressState;
        trace?: TraceEntry[];
        error?: string;
      };
      if (!res.ok || !body.state) {
        const failure = new Error(body.error ?? `HTTP ${res.status}`);
        (failure as { code?: string }).code = (body as { code?: string }).code;
        throw failure;
      }
      // The agent only swaps within known ids; unknown steps would 400 above.
      const validated = body.state.steps.every((s) => itemsRef.current[s.itemId])
        ? body.state
        : state;
      setDress(validated);
      setTrace(body.trace ?? []);
      beep();
      if (validated.done) {
        stopCamera();
        setPhase("finished");
        say(body.say ?? "You're ready.");
      } else {
        say(`${body.say ?? "Done."} ${guidanceFor(validated, itemsRef.current)}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Replan failed.";
      say(
        (err as { code?: string }).code === META_UNAVAILABLE_CODE
          ? "I couldn't think that through. Try again."
          : message,
      );
    } finally {
      setBusy(false);
    }
  }

  async function voiceStart(transcript: string, slots: { mood: string | null; occasion: string | null; occasion_text: string | null; destination: string | null; city: string | null; date_text: string | null; time: string | null }) {
    setStatus(`Getting an outfit for "${transcript}"…`);
    try {
      const res = await fetch("/api/outfits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mood: slots.mood,
          occasion: slots.occasion,
          occasionText: slots.occasion_text ?? undefined,
          destination: slots.destination ?? undefined,
          city: slots.city ?? undefined,
          date: resolveDateText(slots.date_text) ?? undefined,
          timeOfDay: normalizeTimeOfDay(slots.time) ?? undefined,
          exclude: [],
        }),
      });
      const body = (await res.json()) as {
        outfits?: Array<{ item_ids: string[]; key: string }>;
        missing?: string[];
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        const failure = new Error(body.error ?? `HTTP ${res.status}`);
        (failure as { code?: string }).code = body.code;
        throw failure;
      }
      if ((body.missing ?? []).length > 0 || (body.outfits ?? []).length === 0) {
        setStatus("Your closet can't make a full outfit yet. Add clothes first.");
        return;
      }
      const ids = (body.outfits?.[0]?.item_ids ?? []).filter((id) => itemsRef.current[id]?.type);
      if (ids.length === 0) {
        setStatus("That outfit isn't in the closet anymore. Try another occasion.");
        return;
      }
      setSkippedIds([]);
      startWithIds(ids, itemsRef.current);
    } catch (err) {
      setStatus(err instanceof Error ? `Couldn't pick an outfit: ${err.message}` : "Couldn't pick an outfit.");
    }
  }

  const step = dress ? currentStep(dress) : null;
  const finalIds = dress?.steps.map((s) => s.itemId) ?? [];

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 p-6 md:max-w-[960px]">
      <h1 className="font-display text-4xl">Get dressed</h1>

      {phase !== "finished" && (
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="Camera preview"
          className="aspect-[4/3] w-full rounded-2xl bg-(--surface-2) object-cover"
        />
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          const state = dressRef.current;
          if (file && state) void checkBlob(file, state);
        }}
      />

      {phase === "loading" && <p className="text-lg">Loading your closet…</p>}

      {phase === "need-outfit" && loadError && wantedIds ? (
        <section aria-label="Closet failed to load" className="flex flex-col gap-4">
          <p className="text-lg">Couldn&apos;t load the closet. Check your connection, then reload.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="min-h-16 rounded-full bg-(--primary) text-xl font-semibold text-(--primary-text)"
          >
            Reload
          </button>
          <Link href="/style" className="text-lg underline">
            Pick an outfit on Today instead
          </Link>
        </section>
      ) : null}

      {phase === "need-outfit" && !(loadError && wantedIds) && (
        <section aria-label="Pick an outfit by voice" className="flex flex-col gap-4">
          <p className="text-lg">Tell me the occasion and I&apos;ll pick an outfit to dress you in.</p>
          <VoiceButton
            disabled={busy}
            keywords={START_KEYWORDS}
            onActiveChange={handleVoiceActive}
            onResult={(transcript, slots) => void voiceStart(transcript, slots)}
            report={(message, speakIt) => {
              setStatus(message);
              if (speakIt) speak(message);
            }}
          />
          <Link href="/style" className="text-lg underline">
            Or pick an outfit on Style first
          </Link>
        </section>
      )}

      {skippedIds.length > 0 && (phase === "ready" || phase === "guiding") && (
        <p className="text-lg text-(--text-muted)">
          Some items in this outfit couldn&apos;t be loaded: {skippedIds.join(", ")}. Continuing
          with the rest.
        </p>
      )}

      {phase === "ready" && (
        <section aria-label="Start getting dressed" className="flex flex-1 flex-col gap-4">
          <p className="text-lg">
            {wantedIds ? "Outfit ready." : "Outfit picked."} Tap Start, then tap anywhere to check
            each item as you put it on.
          </p>
          <button
            type="button"
            onClick={startSession}
            className="min-h-16 rounded-full bg-(--primary) text-xl font-semibold text-(--primary-text)"
          >
            Start getting dressed
          </button>
          <button
            type="button"
            onClick={backToStyle}
            className="min-h-14 rounded-full border border-(--border) px-6 text-lg font-semibold"
          >
            Pick another outfit
          </button>
        </section>
      )}

      {(phase === "guiding" || phase === "finished") && dress && (
        <>
          <button
            type="button"
            disabled={busy || phase === "finished" || (phase === "guiding" && !cameraReady && !cameraFailed)}
            onClick={() => void tapToCheck()}
            aria-label={
              phase === "finished"
                ? "Outfit complete"
                : busy
                  ? "Checking what you're wearing"
                  : !cameraReady && !cameraFailed
                    ? "Camera starting. Wait before tapping to check."
                    : "Check this step. Tap to take a snapshot."
            }
            className="flex min-h-[40dvh] flex-1 flex-col justify-center gap-4 rounded-[20px] border border-(--border-soft) bg-(--surface) p-6 text-left shadow-[0_10px_24px_var(--shadow)]"
          >
            <span className="font-display text-3xl">
              {phase === "finished"
                ? "You're ready."
                : step
                  ? guidanceFor(dress, items)
                  : "You're ready."}
            </span>
            <span className="text-lg text-(--text-muted)">
              {phase === "finished"
                ? "Outfit complete."
                : busy
                  ? "Checking…"
                  : cameraFailed
                    ? "Tap to choose a photo of this item."
                    : cameraReady
                      ? "Tap anywhere to check this item."
                      : "Camera starting…"}
            </span>
          </button>

          {phase === "guiding" && (
            <div className="flex flex-wrap items-center gap-3">
              <VoiceButton
                disabled={busy}
                keywords={REPLAN_KEYWORDS}
                onActiveChange={handleVoiceActive}
                onResult={(transcript) => void handleVoiceCommand(transcript)}
                report={(message, speakIt) => {
                  setStatus(message);
                  if (speakIt) speak(message);
                }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const state = dressRef.current;
                  if (state) afterLocalMove(skipStep(state), "Skipped.");
                }}
                className="min-h-14 rounded-full border border-(--border) px-6 text-lg font-semibold"
              >
                Skip
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const state = dressRef.current;
                  if (!state) return;
                  const next = backStep(state);
                  setDress(next);
                  beep();
                  say(`Back one. ${guidanceFor(next, itemsRef.current)}`);
                }}
                className="min-h-14 rounded-full border border-(--border) px-6 text-lg font-semibold"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={stopSession}
                className="min-h-14 rounded-full border border-(--border) px-6 text-lg font-semibold"
              >
                Stop
              </button>
            </div>
          )}

          {trace.length > 0 && (
            <details className="rounded-2xl border border-(--border-soft) bg-(--surface) p-4">
              <summary className="min-h-11 cursor-pointer text-lg font-semibold">
                How I decided
              </summary>
              <ul className="mt-2 flex flex-col gap-2">
                {trace.map((entry, i) => (
                  <li key={`${entry.tool}-${i}`} className="text-lg">
                    <span className="font-semibold">{entry.tool}: </span>
                    {entry.detail}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {phase === "finished" && (
            <section aria-label="Final outfit" className="flex flex-col gap-4">
              <ul
                className="grid grid-cols-2 gap-4 rounded-2xl bg-(--surface-2) p-4 md:grid-cols-3"
                aria-label="Outfit you are wearing"
              >
                {finalIds.map((id) => {
                  const item = items[id];
                  if (!item) return null;
                  return (
                    <li key={id} className="flex flex-col items-center gap-1">
                      <span className="flex aspect-[3/4] w-full items-center justify-center">
                        <Sticker src={item.cutoutUrl} alt={item.nickname} seedId={id} />
                      </span>
                      <span className="text-[13px] text-(--text-muted)">{item.nickname}</span>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={startAgain}
                  className="min-h-16 rounded-full bg-(--primary) text-xl font-semibold text-(--primary-text)"
                >
                  Start again
                </button>
                <button
                  type="button"
                  onClick={backToStyle}
                  className="min-h-14 rounded-full border border-(--border) px-6 text-lg font-semibold"
                >
                  Pick another outfit
                </button>
              </div>
              <button
                type="button"
                onClick={backToStyle}
                className="min-h-11 self-start px-1 py-2 text-lg underline"
              >
                Back to Style
              </button>
            </section>
          )}
        </>
      )}

      <p role="status" aria-live="polite" className="text-lg">
        {status}
      </p>

      {phase === "guiding" && (
        <p className="text-lg text-(--text-muted)">
          Eyes-free: everything is spoken. Tap anywhere to check, or talk to change the plan.
        </p>
      )}
    </main>
  );
}
