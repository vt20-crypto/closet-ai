"use client";

import { useEffect, useRef, useState } from "react";

/** Selection as fractions (0..1) of the natural image. */
export interface CropSelection {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_SIZE = 0.05;
/** The box the editor opens with: inset ~5% from every edge. */
const DEFAULT_BOX: CropSelection = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
const KEYBOARD_STEP = 0.02;
const KEYBOARD_BIG_STEP = 0.1;

type ResizeHandle = "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r";

const HANDLE_LABELS: Record<ResizeHandle, string> = {
  tl: "Resize from top-left corner",
  tr: "Resize from top-right corner",
  bl: "Resize from bottom-left corner",
  br: "Resize from bottom-right corner",
  t: "Resize from top edge",
  b: "Resize from bottom edge",
  l: "Resize from left edge",
  r: "Resize from right edge",
};

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

function applyResize(sel: CropSelection, handle: ResizeHandle, dx: number, dy: number): CropSelection {
  switch (handle) {
    case "tl":
      return clampSelection({ x: sel.x + dx, y: sel.y + dy, w: sel.w - dx, h: sel.h - dy });
    case "tr":
      return clampSelection({ x: sel.x, y: sel.y + dy, w: sel.w + dx, h: sel.h - dy });
    case "bl":
      return clampSelection({ x: sel.x + dx, y: sel.y, w: sel.w - dx, h: sel.h + dy });
    case "br":
      return clampSelection({ x: sel.x, y: sel.y, w: sel.w + dx, h: sel.h + dy });
    case "t":
      return clampSelection({ x: sel.x, y: sel.y + dy, w: sel.w, h: sel.h - dy });
    case "b":
      return clampSelection({ x: sel.x, y: sel.y, w: sel.w, h: sel.h + dy });
    case "l":
      return clampSelection({ x: sel.x + dx, y: sel.y, w: sel.w - dx, h: sel.h });
    case "r":
      return clampSelection({ x: sel.x, y: sel.y, w: sel.w + dx, h: sel.h });
  }
}

function moveBox(sel: CropSelection, dx: number, dy: number): CropSelection {
  return clampSelection({ ...sel, x: sel.x + dx, y: sel.y + dy });
}

interface DragState {
  mode: { kind: "move" } | { kind: "resize"; handle: ResizeHandle };
  startPt: { x: number; y: number };
  startSel: CropSelection;
}

interface CropEditorProps {
  imageUrl: string;
  onDone: (cropped: Blob | null) => void;
}

export default function CropEditor({ imageUrl, onDone }: CropEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [working, setWorking] = useState(false);
  const [selection, setSelection] = useState<CropSelection>(DEFAULT_BOX);

  // Window-level move/up listeners so drags keep tracking outside the photo.
  useEffect(() => {
    function onMove(event: PointerEvent) {
      const drag = dragRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!drag || !rect || rect.width === 0 || rect.height === 0) return;
      const current = {
        x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      };
      const dx = current.x - drag.startPt.x;
      const dy = current.y - drag.startPt.y;
      setSelection(
        drag.mode.kind === "move"
          ? moveBox(drag.startSel, dx, dy)
          : applyResize(drag.startSel, drag.mode.handle, dx, dy),
      );
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  function toFraction(clientX: number, clientY: number): { x: number; y: number } {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  }

  function insideSelection(pt: { x: number; y: number }): boolean {
    return (
      pt.x >= selection.x &&
      pt.x <= selection.x + selection.w &&
      pt.y >= selection.y &&
      pt.y <= selection.y + selection.h
    );
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
    if (!loaded || working) return;
    setWorking(true);
    try {
      onDone(await cropSelectionToJpeg(imageUrl, selection));
    } catch {
      onDone(null);
    }
  }

  function startDrag(
    event: React.PointerEvent,
    mode: DragState["mode"],
  ) {
    if (working) return;
    event.stopPropagation();
    event.preventDefault();
    dragRef.current = { mode, startPt: toFraction(event.clientX, event.clientY), startSel: selection };
  }

  return (
    <section aria-label="Crop photo" className="flex flex-col gap-4">
      <h2 className="font-display text-2xl">Crop (optional)</h2>
      <p className="text-lg">
        Drag inside the box to move it, drag a corner or edge to resize — or skip to use the whole photo.
      </p>
      <div
        ref={containerRef}
        className="relative w-full touch-none overflow-hidden rounded-full border border-(--border) select-none"
        style={{ touchAction: "none" }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button") || working || !loaded) return;
          const pt = toFraction(event.clientX, event.clientY);
          // Drags outside the box do nothing.
          if (!insideSelection(pt)) return;
          dragRef.current = { mode: { kind: "move" }, startPt: pt, startSel: selection };
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
        {loaded && (
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
                handleKey(event, (dx, dy) => setSelection((prev) => moveBox(prev, dx, dy)))
              }
            >
              {/* Rule-of-thirds grid. */}
              <div aria-hidden className="pointer-events-none absolute inset-0">
                <div className="absolute top-0 bottom-0 left-1/3 w-px bg-white/60" />
                <div className="absolute top-0 bottom-0 left-2/3 w-px bg-white/60" />
                <div className="absolute top-1/3 right-0 left-0 h-px bg-white/60" />
                <div className="absolute top-2/3 right-0 left-0 h-px bg-white/60" />
              </div>
            </div>
            {(Object.keys(HANDLE_LABELS) as ResizeHandle[]).map((handle) => (
              <button
                key={handle}
                type="button"
                aria-label={HANDLE_LABELS[handle]}
                className="absolute z-10 h-11 w-11 rounded-full border-2 border-white bg-black/70"
                style={handleStyle(handle, selection)}
                onPointerDown={(event) => startDrag(event, { kind: "resize", handle })}
                onKeyDown={(event) =>
                  handleKey(event, (dx, dy) =>
                    setSelection((prev) => applyResize(prev, handle, dx, dy)),
                  )
                }
              />
            ))}
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!loaded || working}
          onClick={() => void applyCrop()}
          className="min-h-14 flex-1 rounded-full bg-(--primary) text-lg font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
        >
          {working ? "Cropping…" : "Use crop"}
        </button>
        <button
          type="button"
          disabled={working}
          onClick={() => setSelection(DEFAULT_BOX)}
          className="min-h-14 flex-1 rounded-full border border-(--border) text-lg font-semibold disabled:text-(--disabled-text)"
        >
          Reset
        </button>
        <button
          type="button"
          disabled={working}
          onClick={() => onDone(null)}
          className="min-h-14 flex-1 rounded-full border border-(--border) text-lg font-semibold disabled:text-(--disabled-text)"
        >
          Skip
        </button>
      </div>
    </section>
  );
}

function handleStyle(handle: ResizeHandle, sel: CropSelection): React.CSSProperties {
  const cx = handle.includes("l") ? sel.x : handle.includes("r") ? sel.x + sel.w : sel.x + sel.w / 2;
  const cy = handle.includes("t") ? sel.y : handle.includes("b") ? sel.y + sel.h : sel.y + sel.h / 2;
  return {
    left: `calc(${cx * 100}% - 22px)`,
    top: `calc(${cy * 100}% - 22px)`,
  };
}
