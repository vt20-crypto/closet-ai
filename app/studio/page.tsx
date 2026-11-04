"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { META_UNAVAILABLE_CODE } from "@/lib/meta/retry";
import type { Vibe } from "@/lib/render";

const HEIGHTS = ["short", "average", "tall"] as const;
const BUILDS = ["slim", "average", "athletic", "curvy", "broad"] as const;
const VIBES: Vibe[] = ["playful", "minimal", "edgy", "classic"];

const STAGES = ["Sketching you…", "Adding your style…", "Finishing touches…"];
const AVATAR_BUSY_MESSAGE = "We couldn't finish your avatar this time. Your photo is still here - tap Try again.";

/** Downscale to a ≤1024px JPEG data URL in the browser; never uploaded as-is. */
async function resizeToDataUrl(source: Blob): Promise<string> {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Canvas 2D is not available in this browser.");
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Could not encode the photo."));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Could not read the photo."));
      reader.readAsDataURL(blob);
    }, "image/jpeg", 0.85);
  });
}

function chipClass(selected: boolean): string {
  return `min-h-14 rounded-full border px-6 py-3 text-lg font-semibold capitalize ${
    selected
      ? "border-(--primary) bg-(--primary) text-(--primary-text)"
      : "border-(--border)"
  }`;
}

/** One photo slot: file input, then a thumbnail with a Change button. */
function PhotoPicker(props: {
  inputId: string;
  label: string;
  url: string | null;
  alt: string;
  processing: boolean;
  disabled: boolean;
  onPick: (file: File | undefined) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={props.inputId} className="text-lg font-semibold">
        {props.label}
      </label>
      {props.url ? (
        <div className="flex items-center gap-4">
          <span className="flex aspect-square w-28 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-(--border-soft) bg-(--surface-2)">
            <img src={props.url} alt={props.alt} className="h-full w-full object-cover" />
          </span>
          <button
            type="button"
            disabled={props.disabled}
            onClick={props.onClear}
            className="min-h-14 rounded-full border border-(--border) px-6 text-lg font-semibold disabled:text-(--disabled-text)"
          >
            Change photo
          </button>
        </div>
      ) : (
        <>
          <input
            id={props.inputId}
            type="file"
            accept="image/*"
            disabled={props.disabled || props.processing}
            onChange={(event) => {
              props.onPick(event.target.files?.[0]);
              // Reset so picking the same file again still fires onChange;
              // the choice stays visible as a thumbnail once processed.
              event.target.value = "";
            }}
            className="min-h-14 rounded-2xl border border-(--border) bg-(--surface) px-4 py-3 text-base"
          />
          {props.processing && (
            <p role="status" className="text-base text-(--text-muted)">
              Processing photo…
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function StudioPage() {
  const [selfieUrl, setSelfieUrl] = useState<string | null>(null);
  const [fullBodyUrl, setFullBodyUrl] = useState<string | null>(null);
  const [height, setHeight] = useState<string | null>(null);
  const [build, setBuild] = useState<string | null>(null);
  const [hairNote, setHairNote] = useState("");
  const [vibe, setVibe] = useState<Vibe | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState("");
  const [processing, setProcessing] = useState<"selfie" | "fullbody" | null>(null);
  const [showForm, setShowForm] = useState(true);
  /** Redo mode: Create generates a candidate for the compare screen. */
  const [redoMode, setRedoMode] = useState(false);
  const [candidate, setCandidate] = useState<{ url: string; path: string } | null>(null);
  const [usage, setUsage] = useState<{ remaining: number; total: number; resetAt: string | null } | null>(null);
  const timerRef = useRef<number | null>(null);
  const confirmRef = useRef<HTMLDialogElement | null>(null);

  /** Usage is a hint; the server enforces the cap. Null when unreadable. */
  async function fetchUsage(): Promise<{
    remaining: number;
    total: number;
    resetAt: string | null;
  } | null> {
    try {
      const res = await fetch("/api/avatar/usage", { cache: "no-store" });
      if (!res.ok) return null;
      const body = (await res.json()) as { remaining?: number; total?: number; resetAt?: string | null };
      return { remaining: body.remaining ?? 3, total: body.total ?? 3, resetAt: body.resetAt ?? null };
    } catch {
      return null;
    }
  }

  async function refreshUsage() {
    const next = await fetchUsage();
    if (next) setUsage(next);
  }

  // Show the current avatar (if any) with a Redo option.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/avatar", { cache: "no-store" });
        const contentType = res.headers.get("content-type") ?? "";
        if (!res.ok || !contentType.includes("application/json")) return;
        const body = (await res.json()) as { avatar?: { url: string; version: string } | null };
        if (!cancelled && body.avatar) {
          setAvatarUrl(body.avatar.url);
          setShowForm(false);
        }
      } catch {
        // Studio works without loading the current avatar.
      }
    })();
    (async () => {
      const next = await fetchUsage();
      if (!cancelled && next) setUsage(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    },
    [],
  );

  async function pickPhoto(
    file: File | undefined,
    kind: "selfie" | "fullbody",
    set: (url: string | null) => void,
  ) {
    if (!file) return;
    setProcessing(kind);
    setError("");
    try {
      set(await resizeToDataUrl(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that photo.");
    } finally {
      setProcessing(null);
    }
  }

  function formatResetDate(resetAt: string): string {
    return new Date(resetAt).toLocaleDateString("en-US", { month: "long", day: "numeric" });
  }

  /** Create directly, or into a candidate when redoing (compare screen). */
  async function createAvatar(asCandidate: boolean) {
    if (!selfieUrl || busy) return;
    setBusy(true);
    setStage(0);
    setError("");
    // Photos stay in memory: after a failure the same tap retries the resend.
    timerRef.current = window.setInterval(() => {
      setStage((s) => Math.min(s + 1, STAGES.length - 1));
    }, 4000);
    try {
      const res = await fetch(asCandidate ? "/api/avatar/candidate" : "/api/avatar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selfie: selfieUrl,
          ...(fullBodyUrl ? { fullBody: fullBodyUrl } : {}),
          ...(height ? { height } : {}),
          ...(build ? { build } : {}),
          ...(hairNote.trim() ? { hairNote: hairNote.trim().slice(0, 120) } : {}),
          ...(vibe ? { vibe } : {}),
        }),
      });
      const contentType = res.headers.get("content-type") ?? "";
      const body = (
        contentType.includes("application/json")
          ? await res.json()
          : null
      ) as { url?: string; path?: string; error?: string; code?: string } | null;
      if (!res.ok || !body?.url) {
        if (body?.code === META_UNAVAILABLE_CODE) throw new Error(AVATAR_BUSY_MESSAGE);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      if (asCandidate && body.path) {
        setCandidate({ url: body.url, path: body.path });
      } else {
        setAvatarUrl(body.url);
        setShowForm(false);
        setRedoMode(false);
      }
      void refreshUsage();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Avatar creation failed.");
    } finally {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      setBusy(false);
    }
  }

  /** Keep new: swap the pointer, then the old avatar file is deleted server-side. */
  async function keepCandidate() {
    if (!candidate || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/avatar/keep", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: candidate.path, url: candidate.url }),
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? `HTTP ${res.status}`);
      setAvatarUrl(body.url);
      setCandidate(null);
      setRedoMode(false);
      setShowForm(false);
      void refreshUsage();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the new avatar.");
    } finally {
      setBusy(false);
    }
  }

  /** Cancel: delete the candidate, keep the current avatar. */
  async function cancelCandidate() {
    if (candidate) {
      try {
        await fetch("/api/avatar/candidate", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: candidate.path }),
        });
      } catch {
        // The next Studio load cleans orphans anyway.
      }
    }
    setCandidate(null);
    setRedoMode(false);
    setShowForm(false);
    setError("");
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 p-6 md:max-w-[960px]">
      <h1 className="font-display text-4xl">Avatar Studio</h1>
      <p className="text-lg text-(--text-muted)">
        Your photos are only used to create your avatar and are never stored.
      </p>

      {candidate && avatarUrl ? (
        <section aria-label="Choose your avatar" className="flex flex-col gap-4">
          <h2 className="font-display text-2xl">Keep the new look?</h2>
          <div className="grid grid-cols-2 gap-4">
            <figure className="flex flex-col gap-2">
              <span className="flex aspect-[2/3] w-full items-center justify-center overflow-hidden rounded-[20px] border border-(--border-soft) bg-(--surface-2)">
                <img src={avatarUrl} alt="Your current avatar" className="h-full w-full object-cover" />
              </span>
              <figcaption className="text-center text-lg text-(--text-muted)">Current</figcaption>
            </figure>
            <figure className="flex flex-col gap-2">
              <span className="flex aspect-[2/3] w-full items-center justify-center overflow-hidden rounded-[20px] border border-(--border-soft) bg-(--surface-2)">
                <img src={candidate.url} alt="New avatar candidate" className="h-full w-full object-cover" />
              </span>
              <figcaption className="text-center text-lg text-(--text-muted)">New</figcaption>
            </figure>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void keepCandidate()}
            className="min-h-16 rounded-full bg-(--primary) text-xl font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
          >
            {busy ? "Saving…" : "Keep new"}
          </button>
          <div className="flex gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void createAvatar(true)}
              className="min-h-14 flex-1 rounded-full border border-(--border) px-6 text-lg font-semibold disabled:text-(--disabled-text)"
            >
              Try again
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void cancelCandidate()}
              className="min-h-14 flex-1 rounded-full border border-(--border) px-6 text-lg font-semibold disabled:text-(--disabled-text)"
            >
              Cancel
            </button>
          </div>
          {error && (
            <p role="alert" className="text-lg">
              {error}
            </p>
          )}
        </section>
      ) : avatarUrl && !showForm ? (
        <section aria-label="Your avatar" className="flex flex-col items-center gap-4">
          <span className="flex aspect-[2/3] w-full max-w-xs items-center justify-center overflow-hidden rounded-[20px] border border-(--border-soft) bg-(--surface-2)">
            <img src={avatarUrl} alt="Your stylized avatar" className="h-full w-full object-cover" />
          </span>
          <div className="flex w-full max-w-xs flex-col gap-3">
            <button
              type="button"
              onClick={() => {
                void refreshUsage();
                confirmRef.current?.showModal();
              }}
              className="min-h-14 rounded-full border border-(--border) px-6 text-lg font-semibold"
            >
              Redo
            </button>
            {usage && (
              <p className="text-center text-base text-(--text-muted)">
                {usage.remaining} of {usage.total} new avatars left this week.
              </p>
            )}
            <Link
              href="/style"
              className="flex min-h-14 items-center justify-center rounded-full bg-(--primary) px-6 text-lg font-semibold text-(--primary-text)"
            >
              See it styled
            </Link>
          </div>
        </section>
      ) : (
        <section aria-label="Create your avatar" className="flex flex-col gap-6">
          <PhotoPicker
            inputId="photo-selfie"
            label="Front selfie (required)"
            url={selfieUrl}
            alt="Selected selfie thumbnail"
            processing={processing === "selfie"}
            disabled={busy}
            onPick={(file) => void pickPhoto(file, "selfie", setSelfieUrl)}
            onClear={() => setSelfieUrl(null)}
          />
          <PhotoPicker
            inputId="photo-fullbody"
            label="Full-body photo (optional, helps proportions)"
            url={fullBodyUrl}
            alt="Selected full-body thumbnail"
            processing={processing === "fullbody"}
            disabled={busy}
            onPick={(file) => void pickPhoto(file, "fullbody", setFullBodyUrl)}
            onClear={() => setFullBodyUrl(null)}
          />

          <div className="flex flex-col gap-3">
            <h2 className="text-xl font-semibold">Height</h2>
            <div className="flex flex-wrap gap-3" role="group" aria-label="Height">
              {HEIGHTS.map((h) => (
                <button
                  key={h}
                  type="button"
                  disabled={busy}
                  aria-pressed={height === h}
                  onClick={() => setHeight(height === h ? null : h)}
                  className={chipClass(height === h)}
                >
                  {h}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="text-xl font-semibold">Build</h2>
            <div className="flex flex-wrap gap-3" role="group" aria-label="Build">
              {BUILDS.map((b) => (
                <button
                  key={b}
                  type="button"
                  disabled={busy}
                  aria-pressed={build === b}
                  onClick={() => setBuild(build === b ? null : b)}
                  className={chipClass(build === b)}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-2 text-lg font-semibold">
            Hair note
            <input
              type="text"
              value={hairNote}
              disabled={busy}
              maxLength={120}
              placeholder="e.g. black bob, curly red hair"
              onChange={(event) => setHairNote(event.target.value)}
              className="min-h-14 rounded-2xl border border-(--border) bg-(--surface) px-4 text-lg font-normal"
            />
          </label>

          <div className="flex flex-col gap-3">
            <h2 className="text-xl font-semibold">Vibe</h2>
            <div className="flex flex-wrap gap-3" role="group" aria-label="Vibe">
              {VIBES.map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={busy}
                  aria-pressed={vibe === v}
                  onClick={() => setVibe(vibe === v ? null : v)}
                  className={chipClass(vibe === v)}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            disabled={busy || !selfieUrl || processing !== null}
            onClick={() => void createAvatar(redoMode)}
            className="min-h-16 rounded-full bg-(--primary) text-xl font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
          >
            {busy ? STAGES[stage] : redoMode ? "Create new avatar" : "Create my avatar"}
          </button>
          {busy && (
            <span role="status" aria-live="polite" className="sr-only">
              {STAGES[stage]}
            </span>
          )}
          {error && (
            <p role="alert" className="text-lg">
              {error}
            </p>
          )}
        </section>
      )}
      <dialog
        ref={confirmRef}
        aria-labelledby="redo-title"
        onClick={(event) => {
          if (event.target === confirmRef.current) confirmRef.current?.close();
        }}
        className="m-auto w-[min(90vw,24rem)] rounded-[20px] border border-(--border-soft) bg-(--surface) p-6 text-(--text) shadow-[0_10px_24px_var(--shadow)] backdrop:bg-black/50"
      >
        <div className="flex flex-col gap-4">
          <h2 id="redo-title" className="font-display text-2xl">
            Create a new avatar?
          </h2>
          {usage && usage.remaining > 0 ? (
            <p className="text-lg">
              This replaces your current one. You have {usage.remaining} of {usage.total} redos left
              this week.
            </p>
          ) : (
            <p className="text-lg">
              {usage?.resetAt
                ? `You can create a new avatar again on ${formatResetDate(usage.resetAt)}.`
                : "You've used this week's redos."}
            </p>
          )}
          <div className="flex gap-3">
            {usage && usage.remaining > 0 && (
              <button
                type="button"
                onClick={() => {
                  confirmRef.current?.close();
                  setRedoMode(true);
                  setShowForm(true);
                  setError("");
                }}
                className="min-h-14 flex-1 rounded-full bg-(--primary) px-6 text-lg font-semibold text-(--primary-text)"
              >
                Continue
              </button>
            )}
            <button
              type="button"
              onClick={() => confirmRef.current?.close()}
              className="min-h-14 flex-1 rounded-full border border-(--border) px-6 text-lg font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      </dialog>
    </main>
  );
}
