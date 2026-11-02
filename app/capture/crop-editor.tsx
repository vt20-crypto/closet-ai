"use client";

import { useRef, useState } from "react";

/** Selection as fractions (0..1) of the natural image. */
export interface CropSelection {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_SIZE = 0.05;
const KEYBOARD_STEP = 0.02;
const KEYBOARD_BIG_STEP = 0.1;

function clampSelection(sel: CropSelection): CropSelection {
  const w = Math.max(MIN_SIZE, Math.min(1, sel.w));
  const h = Math.max(MIN_SIZE, Math.min(1, sel.h));
  return {
    w,
    h,
    x: Math.max(0, Math.min(1 - w, sel.x)),
    y: Math.max(0, Math.min(1 - h, sel.y)),
  };
}

/** Crop a region out of an image URL to JPEG, in natural pixels. */
export async function cropSelectionToJpeg(imageUrl: string, sel: CropSelection): Promise<Blob> {
  const source = await (await fetch(imageUrl)).blob();
  const bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
  try {
    const sx = Math.round(sel.x * bitmap.width);
    const sy = Math.round(sel.y * bitmap.height);
    const sw = Math.max(1, Math.round(sel.w * bitmap.width));
    const sh = Math.max(1, Math.round(sel.h * bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available in this browser.");
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob) throw new Error("Could not encode the crop as JPEG.");
    return blob;
  } finally {
    bitmap.close();
  }
}

type Corner = "tl" | "tr" | "bl" | "br";

const CORNER_LABELS: Record<Corner, string> = {
  tl: "Move top-left corner",
  tr: "Move top-right corner",
  bl: "Move bottom-left corner",
  br: "Move bottom-right corner",
};

function moveCorner(sel: CropSelection, corner: Corner, dx: number, dy: number): CropSelection {
  switch (corner) {
    case "tl":
      return clampSelection({ x: sel.x + dx, y: sel.y + dy, w: sel.w - dx, h: sel.h - dy });
    case "tr":
      return clampSelection({ x: sel.x, y: sel.y + dy, w: sel.w + dx, h: sel.h - dy });
    case "bl":
      return clampSelection({ x: sel.x + dx, y: sel.y, w: sel.w - dx, h: sel.h + dy });
    case "br":
      return clampSelection({ x: sel.x, y: sel.y, w: sel.w + dx, h: sel.h + dy });
  }
}

function moveBox(sel: CropSelection, dx: number, dy: number): CropSelection {
  return clampSelection({ ...sel, x: sel.x + dx, y: sel.y + dy });
}

interface CropEditorProps {
  imageUrl: string;
  onDone: (cropped: Blob | null) => void;
}

export default function CropEditor({ imageUrl, onDone }: CropEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [working, setWorking] = useState(false);
  const [selection, setSelection] = useState<CropSelection | null>(null);

  function toFraction(clientX: number, clientY: number): { x: number; y: number } {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  }

  function handleKey(event: React.KeyboardEvent, apply: (dx: number, dy: number) => void) {
    const step = event.shiftKey ? KEYBOARD_BIG_STEP : KEYBOARD_STEP;
    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowLeft") dx = -step;
    else if (event.key === "ArrowRight") dx = step;
    else if (event.key === "ArrowUp") dy = -step;
    else if (event.key === "ArrowDown") dy = step;
    else return;
    event.preventDefault();
    apply(dx, dy);
  }

  async function applyCrop() {
    if (!selection || working) return;
    setWorking(true);
    try {
      onDone(await cropSelectionToJpeg(imageUrl, selection));
    } catch {
      onDone(null);
    }
  }

  return (
    <section aria-label="Crop photo" className="flex flex-col gap-4">
      <h2 className="text-2xl font-bold">Crop (optional)</h2>
      <p className="text-lg">Drag on the photo to frame the garment, or skip to use the whole photo.</p>
      <div
        ref={containerRef}
        className="relative w-full touch-none overflow-hidden rounded-2xl border border-neutral-300 dark:border-neutral-700"
        style={{ touchAction: "none" }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button") || working) return;
          (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
          const start = toFraction(event.clientX, event.clientY);
          dragStart.current = start;
          setSelection({ x: start.x, y: start.y, w: 0, h: 0 });
        }}
        onPointerMove={(event) => {
          const start = dragStart.current;
          if (!start) return;
          const current = toFraction(event.clientX, event.clientY);
          setSelection(
            clampSelection({
              x: Math.min(start.x, current.x),
              y: Math.min(start.y, current.y),
              w: Math.abs(current.x - start.x),
              h: Math.abs(current.y - start.y),
            }),
          );
        }}
        onPointerUp={() => {
          dragStart.current = null;
          setSelection((prev) => {
            if (!prev) return prev;
            if (prev.w < MIN_SIZE || prev.h < MIN_SIZE) return null;
            return prev;
          });
        }}
        onPointerCancel={() => {
          dragStart.current = null;
        }}
      >
        {/* Remote Blob URLs vary per store, so plain img (not next/image). */}
        <img
          src={imageUrl}
          alt="Photo to crop"
          onLoad={() => setLoaded(true)}
          className="block w-full"
          draggable={false}
        />
        {loaded && selection && (
          <>
            <div
              className="absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
              style={{
                left: `${selection.x * 100}%`,
                top: `${selection.y * 100}%`,
                width: `${selection.w * 100}%`,
                height: `${selection.h * 100}%`,
              }}
              tabIndex={0}
              role="application"
              aria-label="Crop selection. Arrow keys move it; shift plus arrows moves more."
              onKeyDown={(event) =>
                handleKey(event, (dx, dy) => setSelection((prev) => (prev ? moveBox(prev, dx, dy) : prev)))
              }
            />
            {(Object.keys(CORNER_LABELS) as Corner[]).map((corner) => (
              <button
                key={corner}
                type="button"
                aria-label={CORNER_LABELS[corner]}
                className="absolute z-10 h-11 w-11 rounded-full border-2 border-white bg-black/70"
                style={{
                  left: `calc(${(corner === "tl" || corner === "bl" ? selection.x : selection.x + selection.w) * 100}% - 22px)`,
                  top: `calc(${(corner === "tl" || corner === "tr" ? selection.y : selection.y + selection.h) * 100}% - 22px)`,
                }}
                onKeyDown={(event) =>
                  handleKey(event, (dx, dy) =>
                    setSelection((prev) => (prev ? moveCorner(prev, corner, dx, dy) : prev))
                  )
                }
              />
            ))}
          </>
        )}
      </div>
      <div className="flex gap-3">
        <button
          type="button"
          disabled={!selection || working}
          onClick={() => void applyCrop()}
          className="min-h-14 flex-1 rounded-2xl bg-black text-lg font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {working ? "Cropping…" : "Use crop"}
        </button>
        <button
          type="button"
          disabled={working}
          onClick={() => onDone(null)}
          className="min-h-14 flex-1 rounded-2xl border border-neutral-400 text-lg font-semibold disabled:opacity-50"
        >
          Skip
        </button>
      </div>
    </section>
  );
}
