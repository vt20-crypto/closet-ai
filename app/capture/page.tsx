"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

import CropEditor from "./crop-editor";
import { Sticker, Tape } from "../sticker";
import { tapeLabel } from "@/lib/labels";
import { createNDJSONParser } from "@/lib/ndjson";
import { META_HICCUP_MESSAGE, META_UNAVAILABLE_CODE } from "@/lib/meta/retry";

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
  parentPhoto?: string;
}

interface Candidate {
  id: string;
  cutoutUrl: string;
  nouns: string[];
  confidence: number;
  photoPathname: string;
  /** True while the tag event is still outstanding. Buttons stay disabled. */
  tagging: boolean;
  /** Null when the tag call itself errored (retried); the user judges. */
  tags: {
    type: string;
    primary_color: string;
    distinguishing_note: string;
    is_single_garment: boolean;
    rejection_reason: string | null;
    /** Absent on items tagged before nicknames existed. */
    nickname?: string;
  } | null;
}

/** Cleanup prompt for one photo family once every candidate is decided. */
interface PhotoPrompt {
  root: Photo;
  remaining: number;
  found: number;
}

const TAG_TIMEOUT_MS = 20_000;

interface CropTarget {
  displayUrl: string;
  source: { kind: "file"; file: File } | { kind: "photo"; photo: Photo };
}

function candidateTitle(candidate: Candidate): string {
  return candidate.tags?.type ?? candidate.nouns.join(" + ");
}

function candidateSubtitle(candidate: Candidate): string {
  if (candidate.tagging) return "Tagging…";
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
  const tape =
    candidate.tags && candidate.tags.is_single_garment
      ? tapeLabel(candidate.tags)
      : title;
  return (
    <li className="flex gap-4 rounded-[20px] border border-(--border-soft) bg-(--surface-2) p-4 shadow-[0_10px_24px_var(--shadow)]">
      <div className="flex h-36 w-36 shrink-0 items-center justify-center">
        {/* Remote Blob URLs vary per store, so plain img (not next/image). */}
        <Sticker
          src={candidate.cutoutUrl}
          alt={candidate.tags ? `${title} in ${candidate.tags.primary_color}` : `${title} cutout`}
          seedId={candidate.id}
          lazy
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="self-start">
          <Tape label={tape} seedId={candidate.id} />
        </p>
        <p className="text-lg capitalize">{candidateSubtitle(candidate)}</p>
        <div className="mt-auto flex gap-3">
          <button
            type="button"
            disabled={locked || candidate.tagging}
            onClick={(event) => {
              // Fire-and-forget stamp visual; the confirm flow is unchanged.
              event.currentTarget.classList.add("animate-stamp");
              onKeep(candidate.id);
            }}
            aria-label={`${keepLabel} ${title}`}
            className="min-h-14 flex-1 rounded-full bg-(--primary) text-lg font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
          >
            {keepLabel}
          </button>
          <button
            type="button"
            disabled={locked || candidate.tagging}
            onClick={() => onDiscard(candidate.id)}
            aria-label={`Discard ${title}`}
            className="min-h-14 flex-1 rounded-full border border-(--border) text-lg font-semibold disabled:text-(--disabled-text)"
          >
            Discard
          </button>
        </div>
      </div>
    </li>
  );
}

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

  const tagTimers = useRef(new Map<string, number>());
  const [photoPrompt, setPhotoPrompt] = useState<PhotoPrompt | null>(null);
  const [retryAction, setRetryAction] = useState<null | (() => void)>(null);

  // Tag-timeout timers must not outlive the page.
  useEffect(() => {
    const timers = tagTimers.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  function clearTagTimer(id: string) {
    const timer = tagTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      tagTimers.current.delete(id);
    }
  }

  /** Flip a still-tagging card to untagged (timer fired or stream ended). */
  function markUntagged(id: string) {
    clearTagTimer(id);
    setCandidates((prev) =>
      prev.map((c) => (c.id === id && c.tagging ? { ...c, tagging: false } : c)),
    );
  }

  function armTagTimer(id: string) {
    clearTagTimer(id);
    tagTimers.current.set(id, window.setTimeout(() => markUntagged(id), TAG_TIMEOUT_MS));
  }

  /** Root ancestor pathname for prompt/family tracking (crops nest flat). */
  function rootOf(pathname: string): string {
    return meta[pathname]?.parentPhoto ?? pathname;
  }

  function trackPrompt(root: Photo, freshCount: number) {
    setPhotoPrompt((prev) =>
      prev && prev.root.pathname === root.pathname
        ? { ...prev, remaining: prev.remaining + freshCount, found: prev.found + freshCount }
        : { root, remaining: freshCount, found: freshCount },
    );
  }

  /**
   * Segment one photo by its Blob pathname; streams cards progressively.
   * On a Meta outage the whole action auto-retries once after 10s, then
   * offers a manual Try again. The raw API error never reaches the screen.
   */
  async function scanPhoto(
    photo: Photo,
    label: string,
    parentOverride?: string,
    isRetry = false,
  ): Promise<number> {
    setStatus(`Finding clothes in ${label}…`);
    setRetryAction(null);
    const hiccupTimer = window.setTimeout(
      () => setStatus(`${META_HICCUP_MESSAGE} Retrying…`),
      8000,
    );
    const rootPath = parentOverride ?? rootOf(photo.pathname);
    const rootPhoto = photos.find((p) => p.pathname === rootPath) ?? photo;
    let received = 0;
    let streamFailed = false;
    try {
      const res = await fetch("/api/segment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          parentOverride && parentOverride !== photo.pathname
            ? { photoPathname: photo.pathname, parentPhoto: parentOverride }
            : { photoPathname: photo.pathname },
        ),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          code?: string;
        } | null;
        const failure = new Error(body?.error ?? `HTTP ${res.status}`);
        (failure as { code?: string }).code = body?.code;
        throw failure;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createNDJSONParser((event: unknown) => {
        const typed = event as {
          event?: string;
          status?: string;
          candidate?: Omit<Candidate, "tagging" | "tags">;
          id?: string;
          tags?: Candidate["tags"];
          error?: string;
        };
        if (typed.event === "status" && typed.status === "retrying") {
          setStatus(`${META_HICCUP_MESSAGE} Retrying…`);
          return;
        }
        if (typed.event === "error") {
          streamFailed = true;
          return;
        }
        if (typed.event === "cutout" && typed.candidate) {
          const c = typed.candidate;
          received += 1;
          armTagTimer(c.id);
          setCandidates((prev) => [{ ...c, tagging: true, tags: null }, ...prev]);
        } else if (typed.event === "tag" && typeof typed.id === "string") {
          clearTagTimer(typed.id);
          setCandidates((prev) =>
            prev.map((c) =>
              c.id === typed.id ? { ...c, tagging: false, tags: typed.tags ?? null } : c,
            ),
          );
        }
      });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      window.clearTimeout(hiccupTimer);
      // Any card still tagging (timeout or truncated stream) becomes untagged.
      setCandidates((prev) => {
        prev.filter((c) => c.tagging).forEach((c) => clearTagTimer(c.id));
        return prev.map((c) => (c.tagging ? { ...c, tagging: false } : c));
      });
      if (received === 0) {
        setStatus(
          streamFailed
            ? `${label} failed: the scan ended before any clothes arrived.`
            : `No garments found in ${label}. Try a plainer background and better light.`,
        );
      } else {
        setStatus(`Found ${received} item${received === 1 ? "" : "s"} in ${label}.`);
      }
      trackPrompt(rootPhoto, received);
      await refresh();
      return received;
    } catch (err) {
      window.clearTimeout(hiccupTimer);
      setCandidates((prev) => {
        prev.filter((c) => c.tagging).forEach((c) => clearTagTimer(c.id));
        return prev.map((c) => (c.tagging ? { ...c, tagging: false } : c));
      });
      if ((err as { code?: string }).code === META_UNAVAILABLE_CODE && !isRetry) {
        setStatus(`${META_HICCUP_MESSAGE} Retrying…`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return scanPhoto(photo, label, parentOverride, true);
      }
      if ((err as { code?: string }).code === META_UNAVAILABLE_CODE) {
        setStatus("Meta's AI is still having trouble.");
        setRetryAction(() => () => {
          setRetryAction(null);
          void scanPhoto(photo, label, parentOverride);
        });
        await refresh();
        return 0;
      }
      const message = err instanceof Error ? err.message : "Segmentation failed.";
      setStatus(received > 0 ? `Scan incomplete — showing what arrived. ${message}` : `${label} failed: ${message}`);
      await refresh();
      return received;
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
    // The crop records the root ancestor so cleanup tracks the whole family.
    const parent =
      meta[target.source.photo.pathname]?.parentPhoto ?? target.source.photo.pathname;
    setBusy(true);
    try {
      const jpeg = await resizeToJpeg(cropped);
      const photo = await uploadSingle(jpeg, "Cropped photo");
      await refresh();
      if (photo) await scanPhoto(photo, "cropped photo", parent);
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

  function decrementPrompt(candidate: Candidate | undefined) {
    if (!candidate) return;
    const root = rootOf(candidate.photoPathname);
    setPhotoPrompt((prev) =>
      prev && prev.root.pathname === root
        ? { ...prev, remaining: Math.max(0, prev.remaining - 1) }
        : prev,
    );
  }

  async function keep(id: string) {
    const target = candidates.find((c) => c.id === id);
    clearTagTimer(id);
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
      decrementPrompt(target);
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
    const target = candidates.find((c) => c.id === id);
    clearTagTimer(id);
    setActing(true);
    try {
      const res = await fetch(`/api/closet/candidates/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setCandidates((prev) => prev.filter((c) => c.id !== id));
      decrementPrompt(target);
      setStatus("Discarded.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Discard failed.";
      setStatus(`Discard failed: ${message}`);
    } finally {
      setActing(false);
    }
  }

  async function removeFamily(root: Photo) {
    setActing(true);
    try {
      const res = await fetch("/api/photos", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pathname: root.pathname, deleteFamily: true }),
      });
      const body = (await res.json()) as { deleted?: string[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const gone = new Set(body.deleted ?? [root.pathname]);
      setPhotos((prev) => prev.filter((p) => !gone.has(p.pathname)));
      setMeta((prev) => {
        const next = { ...prev };
        gone.forEach((pathname) => delete next[pathname]);
        return next;
      });
      setPhotoPrompt(null);
      setStatus("Photo and its crops deleted. Kept closet items are untouched.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Delete failed.";
      setStatus(`Delete failed: ${message}`);
    } finally {
      setActing(false);
    }
    await refresh();
  }

  async function keepAll() {
    const acceptedIds = candidates
      .filter((c) => !c.tagging && (!c.tags || c.tags.is_single_garment))
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
  const accepted = candidates.filter(
    (c) => c.tagging || !c.tags || c.tags.is_single_garment,
  );
  const rejected = candidates.filter((c) => !c.tagging && c.tags && !c.tags.is_single_garment);
  const locked = busy || acting || cropTarget !== null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl md:max-w-[960px] flex-col gap-6 p-6">
      <h1 className="font-display text-4xl">Capture</h1>
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
        className="min-h-16 rounded-full bg-(--primary) text-xl font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
      >
        {busy ? "Working…" : "Add clothes"}
      </button>
      <p role="status" aria-live="polite" className="text-lg">
        {status}
      </p>
      {retryAction && (
        <button
          type="button"
          onClick={() => {
            const rerun = retryAction;
            setRetryAction(null);
            rerun();
          }}
          className="min-h-14 rounded-full bg-(--primary) text-lg font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
        >
          Try again
        </button>
      )}
      {cropTarget && (
        <CropEditor
          imageUrl={cropTarget.displayUrl}
          onDone={(cropped) => void finishCrop(cropped)}
        />
      )}
      {candidates.length > 0 && (
        <section aria-label="Found garments" className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-display text-2xl">
              Found {candidates.length} item{candidates.length === 1 ? "" : "s"}
            </h2>
            {accepted.length > 0 && (
              <button
                type="button"
                disabled={locked}
                onClick={() => void keepAll()}
                className="min-h-14 rounded-full bg-(--primary) px-6 text-lg font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
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
      {photoPrompt && photoPrompt.remaining === 0 && (
        <section aria-label="Photo cleanup" className="flex flex-col gap-4 rounded-full border border-(--border) p-4">
          {photoPrompt.found > 0 ? (
            <>
              <h2 className="font-display text-2xl">Get another item from this photo?</h2>
              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => void openBacklogCrop(photoPrompt.root)}
                  className="min-h-14 flex-1 rounded-full bg-(--primary) text-lg font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
                >
                  Crop another
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => void removeFamily(photoPrompt.root)}
                  className="min-h-14 flex-1 rounded-full border border-(--border) text-lg font-semibold disabled:text-(--disabled-text)"
                >
                  Done
                </button>
              </div>
              <p className="text-base">Done deletes the photo and its crops. Kept items stay in your closet.</p>
            </>
          ) : (
            <>
              <h2 className="font-display text-2xl">No garments found in this photo.</h2>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => void openBacklogCrop(photoPrompt.root)}
                  className="min-h-14 flex-1 rounded-full bg-(--primary) text-lg font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
                >
                  Crop another
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    setBusy(true);
                    void scanPhoto(photoPrompt.root, "photo").finally(() => setBusy(false));
                  }}
                  className="min-h-14 flex-1 rounded-full border border-(--border) text-lg font-semibold disabled:text-(--disabled-text)"
                >
                  Scan again
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => void removePhoto(photoPrompt.root)}
                  aria-label="Delete this photo"
                  className="min-h-14 flex-1 rounded-full border border-(--border) text-lg font-semibold disabled:text-(--disabled-text)"
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </section>
      )}
      <section aria-label="Not scanned yet" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-2xl">
            Not scanned yet ({unscanned.length})
          </h2>
          {unscanned.length > 0 && (
            <button
              type="button"
              disabled={locked}
              onClick={() => void scanAll()}
              className="min-h-14 rounded-full bg-(--primary) px-6 text-lg font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
            >
              Scan all
            </button>
          )}
        </div>
        {unscanned.length > 0 && (
          <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
            {unscanned.map((photo, index) => (
              <li
                key={photo.pathname}
                className="flex flex-col gap-2 rounded-full border border-(--border) p-3"
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
                  className="min-h-14 rounded-full bg-(--primary) text-lg font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
                >
                  Find clothes
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => void openBacklogCrop(photo)}
                  aria-label={`Crop unscanned photo ${index + 1}`}
                  className="min-h-14 rounded-full border border-(--border) text-lg font-semibold disabled:text-(--disabled-text)"
                >
                  Crop
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => void removePhoto(photo)}
                  aria-label={`Delete unscanned photo ${index + 1}`}
                  className="min-h-14 rounded-full border border-(--border) text-lg font-semibold disabled:text-(--disabled-text)"
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
          <h2 className="font-display text-2xl">Scanned ({scanned.length})</h2>
          <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
            {scanned.map((photo, index) => {
              const kept = meta[photo.pathname]?.keptIds.length ?? 0;
              return (
                <li
                  key={photo.pathname}
                  className="flex flex-col gap-2 rounded-full border border-(--border) p-3"
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
                    className="min-h-14 rounded-full border border-(--border) text-lg font-semibold disabled:text-(--disabled-text)"
                  >
                    Scan again
                  </button>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => void removePhoto(photo)}
                    aria-label={`Delete scanned photo ${index + 1}`}
                    className="min-h-14 rounded-full border border-(--border) text-lg font-semibold disabled:text-(--disabled-text)"
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
