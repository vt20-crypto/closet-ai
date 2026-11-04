"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * First-run Home card for Avatar Studio. Renders nothing while checking,
 * and nothing once an avatar exists.
 */
export default function AvatarCard() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/avatar", { cache: "no-store" });
        const body = (await res.json()) as { avatar?: { url: string } | null };
        if (!cancelled) setShow(res.ok && !body.avatar);
      } catch {
        // Offline or hiccup: stay hidden rather than nag.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;
  return (
    <section
      aria-label="Create your avatar"
      className="flex flex-col gap-3 rounded-[20px] border border-(--border-soft) bg-(--surface) p-5 shadow-[0_10px_24px_var(--shadow)]"
    >
      <h2 className="font-display text-2xl">See looks on you</h2>
      <p className="text-lg">
        Create your avatar once — then every outfit is shown on you, in your style.
      </p>
      <Link
        href="/studio"
        className="flex min-h-14 items-center justify-center rounded-full bg-(--primary) px-6 text-lg font-semibold text-(--primary-text)"
      >
        Create your avatar
      </Link>
    </section>
  );
}
