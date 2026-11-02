"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

const MAX_FILES = 10;
const MAX_DIM = 1600;

interface Photo {
  url: string;
  pathname: string;
}

interface Candidate {
  id: string;
  cutoutUrl: string;
  nouns: string[];
  confidence: number;
  tags: {
    type: string;
    primary_color: string;
    distinguishing_note: string;
  };
}

const CHECKERBOARD: React.CSSProperties = {
  backgroundColor: "#ffffff",
  backgroundImage:
    "linear-gradient(45deg, #e2e2e2 25%, transparent 25%), " +
    "linear-gradient(-45deg, #e2e2e2 25%, transparent 25%), " +
    "linear-gradient(45deg, transparent 75%, #e2e2e2 75%), " +
    "linear-gradient(-45deg, transparent 75%, #e2e2e2 75%)",
  backgroundSize: "20px 20px",
  backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
};

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
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState(false);

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
    try {
      const uploaded: Photo[] = [];
      for (const [index, file] of batch.entries()) {
        setStatus(`Uploading ${index + 1} of ${batch.length}…`);
        try {
          const jpeg = await resizeToJpeg(file);
          const result = await upload(`photos/${Date.now()}-${index}.jpg`, jpeg, {
            access: "public",
            handleUploadUrl: "/api/blob/upload",
            contentType: "image/jpeg",
          });
          uploaded.push({ url: result.url, pathname: result.pathname });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Upload failed.";
          setStatus(`Photo ${index + 1} failed: ${message}`);
        }
      }
      await refresh();

      // Segment one photo at a time, sequentially.
      let found = 0;
      for (const [index, photo] of uploaded.entries()) {
        setStatus(`Finding clothes in photo ${index + 1} of ${uploaded.length}…`);
        try {
          const res = await fetch("/api/segment", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ photoUrl: photo.url }),
          });
          const body = (await res.json()) as { candidates?: Candidate[]; error?: string };
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          const fresh = body.candidates ?? [];
          found += fresh.length;
          if (fresh.length > 0) setCandidates((prev) => [...fresh, ...prev]);
          setStatus(
            fresh.length > 0
              ? `Found ${found} item${found === 1 ? "" : "s"} so far.`
              : `Found ${found} item${found === 1 ? "" : "s"} so far — photo ${index + 1} had nothing new.`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "Segmentation failed.";
          setStatus(`Photo ${index + 1} failed: ${message}`);
        }
      }
      if (uploaded.length > 0) {
        setStatus(
          found > 0
            ? `Found ${found} item${found === 1 ? "" : "s"}. Tap Keep to add them to your closet.`
            : "No garments found. Try a plainer background and better light.",
        );
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function keep(id: string) {
    setActing(true);
    try {
      const res = await fetch("/api/closet/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateIds: [id] }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setCandidates((prev) => prev.filter((c) => c.id !== id));
      setStatus("Kept! View it in your closet.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Keep failed.";
      setStatus(`Keep failed: ${message}`);
    } finally {
      setActing(false);
    }
  }

  async function discard(id: string) {
    setActing(true);
    try {
      const res = await fetch(`/api/closet/candidates/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setCandidates((prev) => prev.filter((c) => c.id !== id));
      setStatus("Discarded.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Discard failed.";
      setStatus(`Discard failed: ${message}`);
    } finally {
      setActing(false);
    }
  }

  async function keepAll() {
    if (candidates.length === 0) return;
    setActing(true);
    try {
      const res = await fetch("/api/closet/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateIds: candidates.map((c) => c.id) }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setCandidates([]);
      setStatus("Kept everything! View your closet.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Keep all failed.";
      setStatus(`Keep all failed: ${message}`);
    } finally {
      setActing(false);
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
        {busy ? "Working…" : "Add clothes"}
      </button>
      <p role="status" aria-live="polite" className="text-lg">
        {status}
      </p>
      {candidates.length > 0 && (
        <section aria-label="Found garments" className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-2xl font-bold">
              Found {candidates.length} item{candidates.length === 1 ? "" : "s"}
            </h2>
            <button
              type="button"
              disabled={acting || busy}
              onClick={() => void keepAll()}
              className="min-h-14 rounded-2xl bg-black px-6 text-lg font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              Keep all
            </button>
          </div>
          <ul className="grid grid-cols-1 gap-4">
            {candidates.map((candidate) => (
              <li
                key={candidate.id}
                className="flex gap-4 rounded-2xl border border-neutral-300 p-4 dark:border-neutral-700"
              >
                <div style={CHECKERBOARD} className="h-36 w-36 shrink-0 overflow-hidden rounded-xl">
                  {/* Remote Blob URLs vary per store, so plain img (not next/image). */}
                  <img
                    src={candidate.cutoutUrl}
                    alt={`${candidate.tags.type} in ${candidate.tags.primary_color}`}
                    className="h-full w-full object-contain"
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p className="text-xl font-semibold capitalize">{candidate.tags.type}</p>
                  <p className="text-lg capitalize">{candidate.tags.primary_color}</p>
                  <div className="mt-auto flex gap-3">
                    <button
                      type="button"
                      disabled={acting || busy}
                      onClick={() => void keep(candidate.id)}
                      aria-label={`Keep ${candidate.tags.type}`}
                      className="min-h-14 flex-1 rounded-2xl bg-black text-lg font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black"
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      disabled={acting || busy}
                      onClick={() => void discard(candidate.id)}
                      aria-label={`Discard ${candidate.tags.type}`}
                      className="min-h-14 flex-1 rounded-2xl border border-neutral-400 text-lg font-semibold disabled:opacity-50"
                    >
                      Discard
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {photos.length > 0 && (
        <ul className="grid grid-cols-2 gap-4" aria-label="Uploaded closet photos">
          {photos.map((photo, index) => (
            <li key={photo.pathname} className="overflow-hidden rounded-xl">
              <img src={photo.url} alt={`Closet photo ${index + 1}`} loading="lazy" className="w-full" />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
