"use client";

import { useState, type CSSProperties } from "react";

/** Deterministic tilt in -maxDeg..maxDeg from any string id. Stable across renders. */
export function tiltForId(id: string, maxDeg: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % (maxDeg * 2 + 1)) - maxDeg;
}

interface StickerProps {
  src: string;
  alt: string;
  /** Stable seed for the tilt (item or candidate id). */
  seedId: string;
  /** Rich 4× die-cut for Home and /today; lite 2× for grid/capture (perf). */
  rich?: boolean;
  /** Pass lazy for below-the-fold grids (closet, capture candidates). */
  lazy?: boolean;
  className?: string;
  onLoad?: () => void;
}

/**
 * A garment cutout as a die-cut sticker: constant-white outline (physical
 * sticker edge, both modes), id-seeded tilt, springy pop-in. Tilt is pure
 * decoration — DOM order and alt text carry the meaning.
 */
export function Sticker({ src, alt, seedId, rich, lazy, className, onLoad }: StickerProps) {
  const tilt = tiltForId(seedId, 4);
  return (
    <img
      src={src}
      alt={alt}
      loading={lazy ? "lazy" : undefined}
      draggable={false}
      onLoad={onLoad}
      style={{ rotate: `${tilt}deg` } as CSSProperties}
      className={`${rich ? "sticker-rich" : "sticker-lite"} animate-sticker-pop h-full w-full object-contain ${
        className ?? ""
      }`}
    />
  );
}

interface TapeProps {
  label: string;
  /** Stable seed for the -3..3° rotation; pass a distinct seed per label. */
  seedId: string;
  className?: string;
}

/**
 * Butter-yellow tape label with dark Caveat ink. Labels never exceed 2
 * lines (ellipsis after that); long text gets a smaller font and a
 * more/less toggle instead of ever causing horizontal scroll. Tapes always
 * sit fully inside their tile (callers: no negative offsets past tile edges).
 */
export function Tape({ label, seedId, className }: TapeProps) {
  const tilt = tiltForId(`tape:${seedId}`, 3);
  const long = label.length > 60;
  const [open, setOpen] = useState(false);
  const size = label.length > 16 ? "text-base" : label.length > 10 ? "text-lg" : "text-xl";
  return (
    <span
      className={`tape font-hand inline-block max-w-full rounded-xs px-3 py-1 leading-tight font-semibold break-words ${size} ${
        className ?? ""
      }`}
      style={{ rotate: `${tilt}deg` } as CSSProperties}
    >
      <span className={long && open ? undefined : "line-clamp-2"}>{label}</span>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? "Show less of the quote" : "Show the full quote"}
          className="font-sans min-h-11 px-2 text-base underline"
        >
          {open ? "less" : "more"}
        </button>
      )}
    </span>
  );
}
