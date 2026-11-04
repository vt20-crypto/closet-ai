"use client";

import { useState } from "react";

import { Sticker, Tape } from "./sticker";

interface GarmentTileProps {
  /** Stable id for the tilt seed, keys and labels. */
  id: string;
  /** Accessible name: "Blue denim jacket". */
  title: string;
  imageUrl?: string;
  /** Tape label (nickname or "<color> <type>"); omitted when none. */
  tape?: string;
  /** Quiet second line, e.g. "slim · blue". */
  caption?: string;
  /** Small status pill, e.g. "In laundry". */
  badge?: string;
  /** When set, the whole tile is one big button opening the detail sheet. */
  onOpen?: () => void;
  openLabel?: string;
}

/**
 * One garment tile: fixed-aspect sticker card, one-line nickname, quiet
 * caption. No buttons inside the tile — actions live in the detail sheet or
 * the row below (review list). Fade-in is gated on the image load and press
 * scale + pulse are motion-safe.
 */
export default function GarmentTile({
  id,
  title,
  imageUrl,
  tape,
  caption,
  badge,
  onOpen,
  openLabel,
}: GarmentTileProps) {
  const [loaded, setLoaded] = useState(!imageUrl);
  const body = (
    <>
      <span className="relative flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-xl bg-(--paper) p-3">
        {!loaded && (
          <span aria-hidden="true" className="absolute inset-0 bg-(--surface-2) motion-safe:animate-pulse" />
        )}
        {imageUrl && (
          <Sticker
            src={imageUrl}
            alt={title}
            seedId={id}
            lazy
            onLoad={() => setLoaded(true)}
            className={`p-2 transition-opacity duration-200 ${loaded ? "opacity-100" : "opacity-0"}`}
          />
        )}
        {badge && (
          <span className="absolute top-2 left-2 rounded-full border border-(--border) bg-(--surface) px-2 py-1 text-xs font-semibold">
            {badge}
          </span>
        )}
        {tape && (
          <span className="pointer-events-none absolute inset-x-2 bottom-2 flex justify-center">
            <Tape label={tape} seedId={id} className="max-w-full" />
          </span>
        )}
      </span>
      <span className="block w-full min-w-0 text-lg leading-snug font-semibold break-words line-clamp-2">
        {tape || title}
      </span>
      {caption && (
        <span className="block w-full min-w-0 text-sm break-words text-(--text-muted) line-clamp-2">{caption}</span>
      )}
    </>
  );
  const frame =
    "flex flex-col gap-1 rounded-2xl border border-(--border-soft) bg-(--surface-2) p-3 shadow-[0_10px_24px_var(--shadow)]";
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel ?? `Open details for ${title}`}
        className={`${frame} text-left motion-safe:transition-transform motion-safe:active:scale-[0.98]`}
      >
        {body}
      </button>
    );
  }
  return <div className={frame}>{body}</div>;
}
