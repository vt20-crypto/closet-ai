"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Captions shown while a look renders; plain "Styling…" under reduced motion. */
const RENDER_CAPTIONS = ["Picking your pieces…", "Styling…", "Final touches…"];

interface StageProps {
  /** Base avatar URL (neutral outfit) or null when the user has none yet. */
  avatarUrl: string | null;
  /** Dressed-look render URL; null while it renders or when flat-lay stands in. */
  dressedUrl: string | null;
  /** True while the look is still rendering (shimmer + cycling captions). */
  rendering: boolean;
  /** Outage fallback: flat-lay + note + retry, shown instead of the render. */
  flatLay?: ReactNode;
  /** Screen-reader announcement, e.g. "Look 1 of 3: navy blazer…". */
  announce: string;
  /** Visible position label, e.g. "1 of 3". */
  position: string;
  /** Current look index + page size for the dots; tapping a dot jumps. */
  index: number;
  total: number;
  onJump: (index: number) => void;
  hasMany: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** After results the stage shrinks (~60dvh → ~50dvh, smooth 300ms). */
  compact?: boolean;
  /** Shown under the silhouette when there is no avatar yet. */
  silhouetteCta?: ReactNode;
}

/**
 * The spotlight stage: base avatar always underneath (never a blank box),
 * dressed render crossfading in over 300ms, shimmer + garment captions while
 * a look renders. One pointer gesture drives both tilt (follows the finger,
 * max 10–12°, springs back) and swipe (|dx| > 50px or a fast flick changes
 * the look; vertical drags scroll the page via touch-action: pan-y). Tilt is
 * off under prefers-reduced-motion; swipe still works.
 */
export default function Stage({
  avatarUrl,
  dressedUrl,
  rendering,
  flatLay,
  announce,
  position,
  index,
  total,
  onJump,
  hasMany,
  onPrev,
  onNext,
  compact,
  silhouetteCta,
}: StageProps) {
  const figureRef = useRef<HTMLElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; t: number; horiz: boolean | null } | null>(null);
  const [reduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [baseReady, setBaseReady] = useState(false);
  // URL the dressed layer has decoded. A new dressedUrl starts transparent
  // and fades in on decode; the check below (no reset effect) keeps the old
  // pixels out of the way without a cascading render.
  const [dressedShown, setDressedShown] = useState<string | null>(null);
  const dressedVisible = dressedShown !== null && dressedShown === dressedUrl;
  const [caption, setCaption] = useState(RENDER_CAPTIONS[0]);
  const showShimmer = rendering && !dressedVisible && !flatLay;

  // Cycle calm captions while a look renders (static under reduced motion).
  useEffect(() => {
    if (!showShimmer || reduced) return;
    let index = 0;
    const timer = window.setInterval(() => {
      index = (index + 1) % RENDER_CAPTIONS.length;
      setCaption(RENDER_CAPTIONS[index] as string);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [showShimmer, reduced]);

  function resetTilt(animated: boolean) {
    const node = tiltRef.current;
    if (!node) return;
    node.style.transition = animated ? "transform 300ms ease-out" : "none";
    node.style.transform = "none";
  }

  function handlePointerDown(event: React.PointerEvent) {
    drag.current = { x: event.clientX, y: event.clientY, t: performance.now(), horiz: null };
    const node = tiltRef.current;
    if (node) node.style.transition = "none";
  }

  function handlePointerMove(event: React.PointerEvent) {
    const state = drag.current;
    if (!state || state.horiz === false) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (state.horiz === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
      state.horiz = Math.abs(dx) > Math.abs(dy);
      if (!state.horiz) {
        drag.current = null;
        return;
      }
    }
    if (reduced) return;
    const tilt = Math.max(-12, Math.min(12, dx / 12));
    const node = tiltRef.current;
    if (node) node.style.transform = `perspective(800px) rotateY(${tilt}deg)`;
  }

  function handlePointerUp(event: React.PointerEvent) {
    const state = drag.current;
    drag.current = null;
    if (!state || state.horiz !== true) {
      resetTilt(false);
      return;
    }
    const dx = event.clientX - state.x;
    const dt = performance.now() - state.t;
    const flick = dt < 400 && Math.abs(dx) > 24;
    if (Math.abs(dx) > 50 || flick) {
      if (dx < 0) onNext();
      else onPrev();
    }
    resetTilt(true);
  }

  return (
    <section aria-label="Stage" className="flex flex-col gap-3">
      <figure
        ref={figureRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          drag.current = null;
          resetTilt(true);
        }}
        className={`relative w-full touch-pan-y overflow-hidden rounded-[20px] border border-(--border-soft) bg-(--surface) shadow-[0_10px_24px_var(--shadow)] transition-[height] duration-300 select-none ${
          compact ? "h-[50dvh]" : "h-[60dvh]"
        }`}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--pop)_30%,transparent),transparent)]"
        />
        {!avatarUrl ? (
          <div className="relative flex h-full flex-col items-center justify-center gap-4 p-6">
            <svg
              width="96"
              height="144"
              viewBox="0 0 96 144"
              fill="var(--surface-2)"
              stroke="var(--border)"
              strokeWidth="2"
              aria-hidden="true"
              focusable="false"
            >
              <circle cx="48" cy="34" r="22" />
              <path d="M14 142c4-34 18-50 34-50s30 16 34 50z" />
            </svg>
            {silhouetteCta}
          </div>
        ) : (
          <div ref={tiltRef} className="relative mx-auto h-full w-fit will-change-transform">
            <img
              key={avatarUrl}
              src={avatarUrl}
              alt=""
              draggable={false}
              onLoad={() => setBaseReady(true)}
              className={`h-full aspect-[2/3] rounded-2xl object-cover transition-all duration-300 ${
                baseReady ? "opacity-100 blur-none" : "opacity-70 blur-md"
              }`}
            />
            {dressedUrl && !flatLay && (
              <img
                key={dressedUrl}
                src={dressedUrl}
                alt=""
                draggable={false}
                onLoad={() => setDressedShown(dressedUrl)}
                className={`absolute inset-0 h-full aspect-[2/3] rounded-2xl object-cover transition-opacity duration-300 ${
                  dressedVisible ? "opacity-100" : "opacity-0"
                }`}
              />
            )}
            {showShimmer && (
              <div
                aria-hidden="true"
                className="animate-stage-shimmer pointer-events-none absolute inset-0 rounded-2xl"
              />
            )}
          </div>
        )}
        {flatLay}
        {hasMany && avatarUrl && (
          <>
            <button
              type="button"
              onClick={onPrev}
              aria-label="Previous look"
              className="absolute top-1/2 left-3 flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-full border border-(--border) bg-(--surface)/90 text-2xl font-semibold"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={onNext}
              aria-label="Next look"
              className="absolute top-1/2 right-3 flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-full border border-(--border) bg-(--surface)/90 text-2xl font-semibold"
            >
              ›
            </button>
          </>
        )}
      </figure>
      <div className="flex items-center justify-center gap-3">
        {hasMany && (
          <div className="flex items-center gap-2" role="group" aria-label="Choose a look">
            {Array.from({ length: total }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onJump(i)}
                aria-label={`Show look ${i + 1}`}
                aria-current={i === index}
                className="flex min-h-11 min-w-11 items-center justify-center"
              >
                <span
                  aria-hidden="true"
                  className={`h-2.5 w-2.5 rounded-full ${i === index ? "bg-(--primary)" : "bg-(--border)"}`}
                />
              </button>
            ))}
          </div>
        )}
        <p className="text-lg text-(--text-muted)">{position}</p>
        {rendering && !reduced && <p className="text-lg text-(--text-muted)">{caption}</p>}
        {rendering && reduced && <p className="text-lg text-(--text-muted)">Styling…</p>}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
    </section>
  );
}
