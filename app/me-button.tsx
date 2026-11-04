"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import HealthStatus from "./health-status";
import ThemeSwitch from "./theme-switch";

/**
 * Avatar button opening a "Me" sheet (native dialog: focus trapped, Esc to
 * dismiss, focus restored on close). Holds the theme switch, closet count,
 * and the Avatar Studio entry. The circle shows the avatar once created.
 */
export default function MeButton() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

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
    dialogRef.current?.showModal();
    fetch("/api/closet", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as { items?: unknown[] };
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setCount((body.items ?? []).length);
      })
      .catch(() => setCount(null));
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
