"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { Vibe } from "@/lib/render";

const HEIGHTS = ["short", "average", "tall"] as const;
const BUILDS = ["slim", "average", "athletic", "curvy", "broad"] as const;
const VIBES: Vibe[] = ["playful", "minimal", "edgy", "classic"];

const STAGES = ["Sketching you…", "Adding your style…", "Finishing touches…"];

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
  const [status, setStatus] = useState("");
  const [showForm, setShowForm] = useState(true);
  const timerRef = useRef<number | null>(null);

  // Show the current avatar (if any) with a Redo option.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/avatar", { cache: "no-store" });
        const body = (await res.json()) as { avatar?: { url: string; version: string } | null };
        if (!cancelled && body.avatar) {
          setAvatarUrl(body.avatar.url);
          setShowForm(false);
        }
      } catch {
        // Studio works without loading the current avatar.
      }
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

  async function pickPhoto(file: File | undefined, set: (url: string | null) => void) {
    if (!file) return;
    try {
      setStatus("");
      set(await resizeToDataUrl(file));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not read that photo.");
    }
  }

  async function createAvatar() {
    if (!selfieUrl || busy) return;
    setBusy(true);
    setStage(0);
    setStatus(STAGES[0]);
    timerRef.current = window.setInterval(() => {
      setStage((s) => {
        const next = Math.min(s + 1, STAGES.length - 1);
        setStatus(STAGES[next]);
        return next;
      });
    }, 4000);
    try {
      const res = await fetch("/api/avatar", {
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
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? `HTTP ${res.status}`);
      setAvatarUrl(body.url);
      setShowForm(false);
      setStatus("Your avatar is ready.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Avatar creation failed.");
    } finally {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 p-6 md:max-w-[960px]">
      <h1 className="font-display text-4xl">Avatar Studio</h1>
      <p className="text-lg text-(--text-muted)">
        Your photos are only used to create your avatar and are never stored.
      </p>

      {avatarUrl && !showForm ? (
        <section aria-label="Your avatar" className="flex flex-col items-center gap-4">
          <span className="flex aspect-[2/3] w-full max-w-xs items-center justify-center overflow-hidden rounded-[20px] border border-(--border-soft) bg-(--surface-2)">
            <img src={avatarUrl} alt="Your stylized avatar" className="h-full w-full object-cover" />
          </span>
          <div className="flex w-full max-w-xs flex-col gap-3">
            <button
              type="button"
              onClick={() => {
                setShowForm(true);
                setStatus("");
              }}
              className="min-h-14 rounded-full border border-(--border) px-6 text-lg font-semibold"
            >
              Redo
            </button>
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
          <label className="flex flex-col gap-2 text-lg font-semibold">
            Front selfie (required)
            <input
              type="file"
              accept="image/*"
              disabled={busy}
              onChange={(event) => {
                void pickPhoto(event.target.files?.[0], setSelfieUrl);
                event.target.value = "";
              }}
              className="min-h-14 rounded-2xl border border-(--border) bg-(--surface) px-4 py-3 text-base font-normal"
            />
          </label>
          <label className="flex flex-col gap-2 text-lg font-semibold">
            Full-body photo (optional, helps proportions)
            <input
              type="file"
              accept="image/*"
              disabled={busy}
              onChange={(event) => {
                void pickPhoto(event.target.files?.[0], setFullBodyUrl);
                event.target.value = "";
              }}
              className="min-h-14 rounded-2xl border border-(--border) bg-(--surface) px-4 py-3 text-base font-normal"
            />
          </label>

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
            disabled={busy || !selfieUrl}
            onClick={() => void createAvatar()}
            className="min-h-16 rounded-full bg-(--primary) text-xl font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
          >
            {busy ? STAGES[stage] : "Create my avatar"}
          </button>
        </section>
      )}

      <p role="status" aria-live="polite" className="text-lg">
        {status}
      </p>
    </main>
  );
}
