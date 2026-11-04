"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import HealthStatus from "./health-status";
import ThemeSwitch from "./theme-switch";

export interface StyleProfilePatch {
  style?: string | null;
  undertone?: string | null;
  strictness?: string | null;
}

/** Small chip group for one profile axis; tapping a set chip clears it. */
function ProfileChips(props: {
  label: string;
  options: string[];
  value: string | null | undefined;
  onPick: (value: string | null) => void;
}) {
  return (
    <div role="group" aria-label={props.label} className="flex flex-col gap-2">
      <p className="text-lg font-semibold">{props.label}</p>
      <div className="flex flex-wrap gap-2">
        {props.options.map((option) => {
          const selected = props.value === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={selected}
              onClick={() => props.onPick(selected ? null : option)}
              className={`min-h-11 rounded-full border px-4 text-base font-semibold capitalize ${
                selected
                  ? "border-(--primary) bg-(--primary) text-(--primary-text)"
                  : "border-(--border)"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Avatar button opening a "Me" sheet (native dialog: focus trapped, Esc to
 * dismiss, focus restored on close). Holds the theme switch, closet count,
 * style profile, and the Avatar Studio entry. The circle shows the avatar
 * once created.
 */
export default function MeButton() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [profile, setProfile] = useState<StyleProfilePatch>({});
  const [profileNote, setProfileNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/avatar", { cache: "no-store" });
        const body = (await res.json()) as { avatar?: { url: string } | null };
        if (!cancelled) setAvatarUrl(res.ok ? (body.avatar?.url ?? null) : null);
      } catch {
        if (!cancelled) setAvatarUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function open() {
    setCount(null);
    setProfileNote(null);
    dialogRef.current?.showModal();
    fetch("/api/closet", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as { items?: unknown[] };
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setCount((body.items ?? []).length);
      })
      .catch(() => setCount(null));
    fetch("/api/profile", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as { profile?: StyleProfilePatch };
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setProfile(body.profile ?? {});
      })
      .catch(() => setProfileNote("Couldn't load the style profile."));
  }

  /** Save one profile change; revert the chip on failure. */
  async function saveProfile(next: StyleProfilePatch) {
    const prev = profile;
    setProfile(next);
    setProfileNote(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setProfileNote("Saved.");
    } catch {
      setProfile({
        style: prev.style ?? null,
        undertone: prev.undertone ?? null,
        strictness: prev.strictness ?? null,
      });
      setProfileNote("Couldn't save — try again.");
    }
  }

  function close() {
    dialogRef.current?.close();
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        aria-label="Open profile and settings"
        className="font-display flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-(--border-soft) bg-(--surface-2) text-2xl"
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="Your avatar" className="h-full w-full object-cover" />
        ) : (
          "C"
        )}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby="me-title"
        onClick={(event) => {
          if (event.target === dialogRef.current) close();
        }}
        className="m-auto w-[min(90vw,24rem)] rounded-[20px] border border-(--border-soft) bg-(--surface) p-6 text-(--text) shadow-[0_10px_24px_var(--shadow)] backdrop:bg-black/50"
      >
        <div className="flex flex-col gap-4">
          <h2 id="me-title" className="font-display text-3xl">
            Me
          </h2>
          <ThemeSwitch />
          <p className="text-lg">
            {count === null ? "Counting closet…" : `${count} item${count === 1 ? "" : "s"} in your closet.`}
          </p>
          <section aria-label="Style profile" className="flex flex-col gap-4 rounded-2xl border border-(--border) p-4">
            <h3 className="font-display text-2xl">Style profile</h3>
            <ProfileChips
              label="Style"
              options={["classic", "minimal", "streetwear", "relaxed", "smart", "bold"]}
              value={profile.style}
              onPick={(style) => void saveProfile({ ...profile, style })}
            />
            <ProfileChips
              label="Skin undertone"
              options={["warm", "cool", "neutral", "not sure"]}
              value={profile.undertone}
              onPick={(undertone) => void saveProfile({ ...profile, undertone })}
            />
            <ProfileChips
              label="Venue strictness"
              options={["relaxed", "standard", "conservative"]}
              value={profile.strictness}
              onPick={(strictness) => void saveProfile({ ...profile, strictness })}
            />
            {profileNote && (
              <p role="status" className="text-base text-(--text-muted)">
                {profileNote}
              </p>
            )}
          </section>
          <HealthStatus />
          <p className="text-sm text-(--text-muted)">
            About: Outfit suggestions by Muse Spark via Meta&apos;s Model API. Garment cutouts by
            SAM 3.1. Voice by Muse Voice Transcribe.
          </p>
          <Link
            href="/studio"
            onClick={close}
            className="flex min-h-14 items-center justify-center rounded-full border border-(--border) px-6 text-lg font-semibold"
          >
            {avatarUrl ? "Redo my avatar" : "Create my avatar"}
          </Link>
          <button
            type="button"
            onClick={close}
            className="min-h-14 rounded-full bg-(--primary) px-6 text-lg font-semibold text-(--primary-text)"
          >
            Close
          </button>
        </div>
      </dialog>
    </>
  );
}
