import type { CSSProperties } from "react";

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
}

/**
 * A garment cutout as a die-cut sticker: constant-white outline (physical
 * sticker edge, both modes), id-seeded tilt, springy pop-in. Tilt is pure
 * decoration — DOM order and alt text carry the meaning.
 */
export function Sticker({ src, alt, seedId, rich, lazy, className }: StickerProps) {
  const tilt = tiltForId(seedId, 4);
  return (
    <img
      src={src}
      alt={alt}
      loading={lazy ? "lazy" : undefined}
      draggable={false}
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
 * Butter-yellow tape label with dark Caveat ink. Slightly overlaps the tile
 * edge via the caller's negative margin. Short labels only.
 */
export function Tape({ label, seedId, className }: TapeProps) {
  const tilt = tiltForId(`tape:${seedId}`, 3);
  return (
    <span
      className={`tape font-hand inline-block rounded-xs px-3 py-1 text-xl leading-tight font-semibold whitespace-nowrap ${className ?? ""}`}
      style={{ rotate: `${tilt}deg` } as CSSProperties}
    >
      {label}
    </span>
  );
}
