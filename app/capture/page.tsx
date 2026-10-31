"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

const MAX_FILES = 10;
const MAX_DIM = 1600;

interface Photo {
  url: string;
  pathname: string;
}

async function resizeToJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Canvas 2D is not available in this browser.");
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("Could not encode the photo as JPEG.");
  return blob;
}

export default function CapturePage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("No photos yet. Add clothes to start your closet.");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/photos", { cache: "no-store" });
      const body = (await res.json()) as { photos?: Photo[]; error?: string };
      if (body.photos) {
        setPhotos(body.photos);
        if (body.photos.length > 0) setStatus(`Closet has ${body.photos.length} photo(s).`);
      }
    } catch {
      // Listing is best-effort here; upload errors are reported per file below.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/photos", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as { photos?: Photo[] };
        if (!cancelled && body.photos) {
          setPhotos(body.photos);
          if (body.photos.length > 0) setStatus(`Closet has ${body.photos.length} photo(s).`);
        }
      })
      .catch(() => {
        // Listing is best-effort on first paint; upload errors report per file.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0 || busy) return;
    const batch = Array.from(files).slice(0, MAX_FILES);
    if (files.length > MAX_FILES) {
      setStatus(`Taking the first ${MAX_FILES} of ${files.length} photos.`);
    }
    setBusy(true);
    let saved = 0;
    try {
      for (const [index, file] of batch.entries()) {
        setStatus(`Uploading ${index + 1} of ${batch.length}…`);
        try {
          const jpeg = await resizeToJpeg(file);
          await upload(`photos/${Date.now()}-${index}.jpg`, jpeg, {
            access: "public",
            handleUploadUrl: "/api/blob/upload",
            contentType: "image/jpeg",
          });
          saved += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : "Upload failed.";
          setStatus(`Photo ${index + 1} failed: ${message}`);
        }
      }
      await refresh();
      if (saved === batch.length) setStatus(`Saved ${saved} photo(s).`);
      else if (saved > 0) setStatus(`Saved ${saved} of ${batch.length} photo(s).`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-3xl font-bold">Capture</h1>
      <p>Photograph one garment at a time against a plain background.</p>
      <input
        ref={inputRef}
        id="clothes-input"
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="sr-only"
        onChange={(event) => void handleFiles(event.target.files)}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="min-h-16 rounded-2xl bg-black text-xl font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black"
      >
        {busy ? "Uploading…" : "Add clothes"}
      </button>
      <p role="status" aria-live="polite" className="text-lg">
        {status}
      </p>
      {photos.length > 0 && (
        <ul className="grid grid-cols-2 gap-4" aria-label="Uploaded closet photos">
          {photos.map((photo, index) => (
            <li key={photo.pathname} className="overflow-hidden rounded-xl">
              {/* Remote Blob URLs vary per store, so plain img (not next/image). */}
              <img src={photo.url} alt={`Closet photo ${index + 1}`} loading="lazy" className="w-full" />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
