"use client";

import { useEffect, useState } from "react";

const DISMISSED_KEY = "closet-ai-install-tip";

/**
 * "Add to Home Screen" tip. iOS Safari only (navigator.standalone exists
 * only there) and never in standalone mode. Dismissal persists.
 */
export default function InstallTip() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Deferred past the first paint so the tip never shifts the layout.
    const timer = window.setTimeout(() => {
      try {
        if (window.localStorage.getItem(DISMISSED_KEY)) return;
        const nav = window.navigator as Navigator & { standalone?: boolean };
        const inApp =
          window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
        if (!("standalone" in nav) || inApp) return;
        setShow(true);
      } catch {
        // Private mode: no tip, no crash.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Private mode: dismissal simply isn't remembered.
    }
    setShow(false);
  }

  if (!show) return null;
  return (
    <section
      aria-label="Install tip"
      className="flex items-center gap-3 rounded-[20px] border border-(--border-soft) bg-(--surface) p-4 shadow-[0_10px_24px_var(--shadow)]"
    >
      <p className="flex-1 text-base">
        Add to Home Screen for the full-screen app (in Safari: Share → Add to Home Screen).
      </p>
      <button
        type="button"
        onClick={dismiss}
        className="min-h-11 shrink-0 rounded-full border border-(--border) px-4 text-base font-semibold"
      >
        Dismiss
      </button>
    </section>
  );
}
