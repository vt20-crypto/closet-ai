"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

import CropEditor from "./crop-editor";

const MAX_FILES = 10;
const MAX_DIM = 1600;

interface Photo {
  url: string;
  pathname: string;
}

interface PhotoMeta {
  photoPathname: string;
  scannedAt: string;
  candidateIds: string[];
  keptIds: string[];
}

interface Candidate {
  id: string;
  cutoutUrl: string;
  nouns: string[];
  confidence: number;
  /** Null when the tag call itself errored (retried); the user judges. */
  tags: {
    type: string;
    primary_color: string;
    distinguishing_note: string;
    is_single_garment: boolean;
    rejection_reason: string | null;
  } | null;
}

interface CropTarget {
  displayUrl: string;
  source: { kind: "file"; file: File } | { kind: "photo"; photo: Photo };
}

function candidateTitle(candidate: Candidate): string {
  return candidate.tags?.type ?? candidate.nouns.join(" + ");
}

function candidateSubtitle(candidate: Candidate): string {
  if (!candidate.tags) return "Tagging failed — you decide.";
  if (!candidate.tags.is_single_garment) return candidate.tags.rejection_reason ?? "Not sure.";
  return candidate.tags.primary_color;
}

function CandidateCard({
  candidate,
  keepLabel,
  locked,
  onKeep,
  onDiscard,
}: {
  candidate: Candidate;
  keepLabel: string;
  locked: boolean;
  onKeep: (id: string) => void;
  onDiscard: (id: string) => void;
}) {
  const title = candidateTitle(candidate);
  return (
    <li className="flex gap-4 rounded-2xl border border-neutral-300 p-4 dark:border-neutral-700">
      <div style={CHECKERBOARD} className="h-36 w-36 shrink-0 overflow-hidden rounded-xl">
        {/* Remote Blob URLs vary per store, so plain img (not next/image). */}
        <img
          src={candidate.cutoutUrl}
          alt={candidate.tags ? `${title} in ${candidate.tags.primary_color}` : `${title} cutout`}
          className="h-full w-full object-contain"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-xl font-semibold capitalize">{title}</p>
        <p className="text-lg capitalize">{candidateSubtitle(candidate)}</p>
        <div className="mt-auto flex gap-3">
          <button
            type="button"
            disabled={locked}
            onClick={() => onKeep(candidate.id)}
            aria-label={`${keepLabel} ${title}`}
            className="min-h-14 flex-1 rounded-2xl bg-black text-lg font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {keepLabel}
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => onDiscard(candidate.id)}
            aria-label={`Discard ${title}`}
            className="min-h-14 flex-1 rounded-2xl border border-neutral-400 text-lg font-semibold disabled:opacity-50"
          >
            Discard
          </button>
        </div>
      </div>
    </li>
  );
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

async function resizeToJpeg(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
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
  const [meta, setMeta] = useState<Record<string, PhotoMeta>>({});
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState(false);
  const [cropTarget, setCropTarget] = useState<CropTarget | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/photos", { cache: "no-store" });
      const body = (await res.json()) as { photos?: Photo[]; meta?: Record<string, PhotoMeta> };
      if (body.photos) setPhotos(body.photos);
      if (body.meta) setMeta(body.meta);
      return body;
    } catch {
      // Listing is best-effort here; upload errors are reported per file below.
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/photos", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as { photos?: Photo[]; meta?: Record<string, PhotoMeta> };
        if (!cancelled) {
          if (body.photos) setPhotos(body.photos);
          if (body.meta) setMeta(body.meta);
          if (body.photos?.length) setStatus(`Closet has ${body.photos.length} photo(s).`);
        }
      })
      .catch(() => {
        // Listing is best-effort on first paint; upload errors report per file.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Segment one photo by its Blob pathname; returns how many candidates were found. */
  async function scanPhoto(photo: Photo, label: string): Promise<number> {
    setStatus(`Finding clothes in ${label}…`);
    try {
      const res = await fetch("/api/segment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ photoPathname: photo.pathname }),
      });
      const body = (await res.json()) as { candidates?: Candidate[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const fresh = body.candidates ?? [];
      if (fresh.length > 0) setCandidates((prev) => [...fresh, ...prev]);
      setStatus(
        fresh.length > 0
          ? `Found ${fresh.length} item${fresh.length === 1 ? "" : "s"} in ${label}.`
          : `No garments found in ${label}. Try a plainer background and better light.`,
      );
      await refresh();
      return fresh.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Segmentation failed.";
      setStatus(`${label} failed: ${message}`);
      await refresh();
      return 0;
    }
  }

  /** Upload one JPEG blob as a new photo. Returns null on failure. */
  async function uploadSingle(jpeg: Blob, label: string): Promise<Photo | null> {
    try {
      const result = await upload(`photos/${Date.now()}.jpg`, jpeg, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        contentType: "image/jpeg",
      });
      return { url: result.url, pathname: result.pathname };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed.";
      setStatus(`${label} failed: ${message}`);
      return null;
    }
  }

  /** Crop step result: null means skip (file flow proceeds, backlog closes). */
  async function finishCrop(cropped: Blob | null) {
    const target = cropTarget;
    setCropTarget(null);
    if (target) URL.revokeObjectURL(target.displayUrl);
    if (!target) return;
    if (target.source.kind === "file") {
      setBusy(true);
      try {
        const jpeg = await resizeToJpeg(cropped ?? target.source.file);
        const photo = await uploadSingle(jpeg, "Photo 1");
        await refresh();
        if (photo) await scanPhoto(photo, "photo 1 of 1");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed.";
        setStatus(`Photo 1 failed: ${message}`);
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
      return;
    }
    if (!cropped) {
      setStatus("Crop skipped.");
      return;
    }
    // Backlog photo: the crop becomes a NEW photo; the original stays put.
    setBusy(true);
    try {
      const jpeg = await resizeToJpeg(cropped);
      const photo = await uploadSingle(jpeg, "Cropped photo");
      await refresh();
      if (photo) await scanPhoto(photo, "cropped photo");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed.";
      setStatus(`Cropped photo failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  async function openBacklogCrop(photo: Photo) {
    if (busy || acting) return;
    setStatus("Loading photo for cropping…");
    try {
      const blob = await (await fetch(photo.url)).blob();
      setCropTarget({ displayUrl: URL.createObjectURL(blob), source: { kind: "photo", photo } });
      setStatus("Drag to crop around the garment, then Use crop — or Skip.");
    } catch {
      setStatus("Couldn't load that photo for cropping.");
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0 || busy || cropTarget) return;
    const batch = Array.from(files).slice(0, MAX_FILES);
    if (files.length > MAX_FILES) {
      setStatus(`Taking the first ${MAX_FILES} of ${files.length} photos.`);
    }
    if (batch.length === 1 && batch[0]) {
      // Single photo: offer the optional crop step before upload.
      const file = batch[0];
      setCropTarget({ displayUrl: URL.createObjectURL(file), source: { kind: "file", file } });
      setStatus("Optional: drag to crop around the garment, then Use crop — or Skip.");
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setBusy(true);
    try {
      const uploaded: Photo[] = [];
      for (const [index, file] of batch.entries()) {
        setStatus(`Uploading ${index + 1} of ${batch.length}…`);
        try {
          const jpeg = await resizeToJpeg(file);
          const photo = await uploadSingle(jpeg, `Photo ${index + 1}`);
          if (photo) uploaded.push(photo);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Upload failed.";
          setStatus(`Photo ${index + 1} failed: ${message}`);
        }
      }
      await refresh();

      // New uploads flow straight into segment, one photo at a time.
      for (const [index, photo] of uploaded.entries()) {
        await scanPhoto(photo, `photo ${index + 1} of ${uploaded.length}`);
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function scanAll() {
    const pending = photos.filter((photo) => !meta[photo.pathname]);
    if (pending.length === 0 || busy) return;
    setBusy(true);
    try {
      let found = 0;
      for (const [index, photo] of pending.entries()) {
        found += await scanPhoto(photo, `photo ${index + 1} of ${pending.length}`);
      }
      if (found > 0) setStatus(`Scan all done. Tap Keep to add items to your closet.`);
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto(photo: Photo) {
    setActing(true);
    try {
      const res = await fetch("/api/photos", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pathname: photo.pathname }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setPhotos((prev) => prev.filter((p) => p.pathname !== photo.pathname));
      setMeta((prev) => {
        const next = { ...prev };
        delete next[photo.pathname];
        return next;
      });
      setStatus("Deleted photo. Kept closet items are untouched.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Delete failed.";
      setStatus(`Delete failed: ${message}`);
    } finally {
      setActing(false);
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
    await refresh();
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
    const acceptedIds = candidates
      .filter((c) => !c.tags || c.tags.is_single_garment)
      .map((c) => c.id);
    if (acceptedIds.length === 0) return;
    setActing(true);
    try {
      const res = await fetch("/api/closet/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateIds: acceptedIds }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setCandidates((prev) => prev.filter((c) => !acceptedIds.includes(c.id)));
      setStatus("Kept everything! View your closet.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Keep all failed.";
      setStatus(`Keep all failed: ${message}`);
    } finally {
      setActing(false);
    }
    await refresh();
  }

  const unscanned = photos.filter((photo) => !meta[photo.pathname]);
  const scanned = photos.filter((photo) => meta[photo.pathname]);
  const accepted = candidates.filter((c) => !c.tags || c.tags.is_single_garment);
  const rejected = candidates.filter((c) => c.tags && !c.tags.is_single_garment);
  const locked = busy || acting || cropTarget !== null;

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
      {cropTarget && (
        <CropEditor
          imageUrl={cropTarget.displayUrl}
          onDone={(cropped) => void finishCrop(cropped)}
        />
      )}
      {candidates.length > 0 && (
        <section aria-label="Found garments" className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-2xl font-bold">
              Found {candidates.length} item{candidates.length === 1 ? "" : "s"}
            </h2>
            {accepted.length > 0 && (
              <button
                type="button"
                disabled={locked}
                onClick={() => void keepAll()}
                className="min-h-14 rounded-2xl bg-black px-6 text-lg font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black"
              >
                Keep all
              </button>
            )}
          </div>
          <ul className="grid grid-cols-1 gap-4">
            {accepted.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                keepLabel="Keep"
                locked={locked}
                onKeep={(id) => void keep(id)}
                onDiscard={(id) => void discard(id)}
              />
            ))}
          </ul>
          {rejected.length > 0 && (
            <details>
              <summary className="min-h-14 cursor-pointer py-4 text-lg underline">
                Not sure these are clothes ({rejected.length})
              </summary>
              <ul className="grid grid-cols-1 gap-4">
                {rejected.map((candidate) => (
                  <CandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    keepLabel="Keep anyway"
                    locked={locked}
                    onKeep={(id) => void keep(id)}
                    onDiscard={(id) => void discard(id)}
                  />
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      <section aria-label="Not scanned yet" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-2xl font-bold">
            Not scanned yet ({unscanned.length})
          </h2>
          {unscanned.length > 0 && (
            <button
              type="button"
              disabled={locked}
              onClick={() => void scanAll()}
              className="min-h-14 rounded-2xl bg-black px-6 text-lg font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              Scan all
            </button>
          )}
        </div>
        {unscanned.length > 0 && (
          <ul className="grid grid-cols-2 gap-4">
            {unscanned.map((photo, index) => (
              <li
                key={photo.pathname}
                className="flex flex-col gap-2 rounded-2xl border border-neutral-300 p-3 dark:border-neutral-700"
              >
                <img
                  src={photo.url}
                  alt={`Unscanned closet photo ${index + 1}`}
                  loading="lazy"
                  className="w-full rounded-xl"
                />
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    setBusy(true);
                    void scanPhoto(photo, `photo ${index + 1}`).finally(() => setBusy(false));
                  }}
                  className="min-h-14 rounded-2xl bg-black text-lg font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black"
                >
                  Find clothes
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => void openBacklogCrop(photo)}
                  aria-label={`Crop unscanned photo ${index + 1}`}
                  className="min-h-14 rounded-2xl border border-neutral-400 text-lg font-semibold disabled:opacity-50"
                >
                  Crop
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => void removePhoto(photo)}
                  aria-label={`Delete unscanned photo ${index + 1}`}
                  className="min-h-14 rounded-2xl border border-neutral-400 text-lg font-semibold disabled:opacity-50"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {scanned.length > 0 && (
        <section aria-label="Scanned photos" className="flex flex-col gap-4">
          <h2 className="text-2xl font-bold">Scanned ({scanned.length})</h2>
          <ul className="grid grid-cols-2 gap-4">
            {scanned.map((photo, index) => {
              const kept = meta[photo.pathname]?.keptIds.length ?? 0;
              return (
                <li
                  key={photo.pathname}
                  className="flex flex-col gap-2 rounded-2xl border border-neutral-300 p-3 dark:border-neutral-700"
                >
                  <img
                    src={photo.url}
                    alt={`Scanned closet photo ${index + 1}`}
                    loading="lazy"
                    className="w-full rounded-xl"
                  />
                  <p className="text-lg">
                    {kept === 0 ? "No items kept yet." : `${kept} item${kept === 1 ? "" : "s"} kept.`}
                  </p>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      setBusy(true);
                      void scanPhoto(photo, `photo ${index + 1}`).finally(() => setBusy(false));
                    }}
                    className="min-h-14 rounded-2xl border border-neutral-400 text-lg font-semibold disabled:opacity-50"
                  >
                    Scan again
                  </button>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => void removePhoto(photo)}
                    aria-label={`Delete scanned photo ${index + 1}`}
                    className="min-h-14 rounded-2xl border border-neutral-400 text-lg font-semibold disabled:opacity-50"
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
