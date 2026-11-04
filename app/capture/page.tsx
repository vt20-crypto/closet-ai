"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

import CropEditor from "./crop-editor";
import ItemEditor, { type EditableItem } from "../item-editor";
import { Sticker, Tape } from "../sticker";
import { tapeLabel } from "@/lib/labels";
import { createNDJSONParser } from "@/lib/ndjson";
import { META_HICCUP_MESSAGE, META_UNAVAILABLE_CODE } from "@/lib/meta/retry";

const MAX_FILES = 20;
const MAX_DIM = 1600;

/** One photo in the bulk add queue. */
interface QueueItem {
  id: string;
  file: Blob;
  name: string;
  thumbUrl: string;
  status: "queued" | "uploading" | "ready" | "scanning" | "done" | "failed";
  photo?: Photo;
  error?: string;
}

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
    formality: number;
    warmth: number;
    fit: string;
    length: string;
    sleeve: string;
    rise: string;
  } | null;
}

/** Sheet defaults for a candidate the tagger never reached. */
function blankEditable(candidate: Candidate): EditableItem {
  return {
    id: candidate.id,
    label: candidateTitle(candidate),
    cutoutUrl: candidate.cutoutUrl,
    tags: {
      nickname: "",
      type: candidate.nouns[0] ?? "garment",
      primary_color: "unknown",
      fit: "n/a",
      length: "n/a",
      sleeve: "n/a",
      rise: "n/a",
      formality: 3,
      warmth: 3,
    },
  };
}

function candidateEditable(candidate: Candidate): EditableItem {
  if (!candidate.tags) return blankEditable(candidate);
  return {
    id: candidate.id,
    label: candidateTitle(candidate),
    cutoutUrl: candidate.cutoutUrl,
    tags: { ...candidate.tags },
  };
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
  source: { kind: "file"; file: File } | { kind: "photo"; photo: Photo } | { kind: "queue"; id: string };
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
  onEdit,
}: {
  candidate: Candidate;
  keepLabel: string;
  locked: boolean;
  onKeep: (id: string) => void;
  onDiscard: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const title = candidateTitle(candidate);
  const tape =
    candidate.tags && candidate.tags.is_single_garment
      ? tapeLabel(candidate.tags)
      : title;
  return (
    <li className="flex gap-4 rounded-[20px] border border-(--border-soft) bg-(--surface-2) p-4 shadow-[0_10px_24px_var(--shadow)]">
      <div className="flex aspect-[3/4] w-36 shrink-0 items-center justify-center">
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
            onClick={() => onEdit(candidate.id)}
            aria-label={`Edit ${title}`}
            className="min-h-14 flex-1 rounded-full border border-(--border) text-lg font-semibold disabled:text-(--disabled-text)"
          >
            Edit
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
  const takeRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("No photos yet. Add clothes to start your closet.");
  /** Bulk add queue: resize + upload, then scan one photo at a time. */
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const queueRef = useRef<QueueItem[]>([]);
  queueRef.current = queue;
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [meta, setMeta] = useState<Record<string, PhotoMeta>>({});
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState(false);
  const [cropTarget, setCropTarget] = useState<CropTarget | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

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
  /** Post-review summary, shown once a review round fully drains. */
  const [doneCard, setDoneCard] = useState<{ added: number } | null>(null);
  /** Items kept since the last drain; the done card reports this count. */
  const roundAdded = useRef(0);
  /** Fresh-closure reads for drain checks (keep/discard race a re-render). */
  const candidatesRef = useRef<Candidate[]>([]);
  candidatesRef.current = candidates;

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
    quiet = false,
  ): Promise<number> {
    // Queue scans stay quiet: the queue progress line is the status.
    const say = (message: string): void => {
      if (!quiet) setStatus(message);
    };
    say(`Finding clothes in ${label}…`);
    setRetryAction(null);
    setDoneCard(null);
    roundAdded.current = 0;
    const hiccupTimer = window.setTimeout(() => say(META_HICCUP_MESSAGE), 8000);
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
          say(META_HICCUP_MESSAGE);
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
        say(
          streamFailed
            ? `${label} failed: the scan ended before any clothes arrived.`
            : `No garments found in ${label}. Try a plainer background and better light.`,
        );
      } else {
        say(`Found ${received} item${received === 1 ? "" : "s"} in ${label}.`);
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
        say(META_HICCUP_MESSAGE);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return scanPhoto(photo, label, parentOverride, true, quiet);
      }
      if ((err as { code?: string }).code === META_UNAVAILABLE_CODE) {
        say("Your stylist is still taking a breather.");
        setRetryAction(() => () => {
          setRetryAction(null);
          void scanPhoto(photo, label, parentOverride);
        });
        await refresh();
        return 0;
      }
      const message = err instanceof Error ? err.message : "Segmentation failed.";
      say(received > 0 ? `Scan incomplete — showing what arrived. ${message}` : `${label} failed: ${message}`);
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
    // Queue thumbs stay alive for the queue list; other URLs are one-shot.
    if (target && target.source.kind !== "queue") URL.revokeObjectURL(target.displayUrl);
    if (!target) return;
    if (target.source.kind === "queue") {
      // Crop only swaps the file; the upload turn picks it up. Never blocks.
      if (cropped) setQueueItem(target.source.id, { file: cropped });
      else setStatus("Crop skipped.");
      return;
    }
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

  function setQueueItem(id: string, patch: Partial<QueueItem>) {
    setQueue((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }

  /** Rear camera: one photo, with the optional crop step before upload. */
  async function handleTakeFile(file: File | undefined) {
    if (!file || busy || cropTarget) return;
    setCropTarget({ displayUrl: URL.createObjectURL(file), source: { kind: "file", file } });
    setStatus("Optional: drag to crop around the garment, then Use crop — or Skip.");
    if (takeRef.current) takeRef.current.value = "";
  }

  /** Upload picker: up to 20 photos into the queue, then upload + scan. */
  async function handleUploadFiles(files: FileList | null) {
    if (!files || files.length === 0 || busy || cropTarget) return;
    const batch = Array.from(files).slice(0, MAX_FILES);
    if (files.length > MAX_FILES) {
      setStatus(`Taking the first ${MAX_FILES} of ${files.length} photos.`);
    }
    if (uploadRef.current) uploadRef.current.value = "";
    const items: QueueItem[] = batch.map((file, index) => ({
      id: `${Date.now()}-${index}`,
      file,
      name: file.name || `Photo ${index + 1}`,
      thumbUrl: URL.createObjectURL(file),
      status: "queued",
    }));
    setQueue(items);
    setBusy(true);
    try {
      // Uploads run in order; a queued photo can still be cropped meanwhile.
      for (const item of items) {
        const current = queueRef.current.find((entry) => entry.id === item.id);
        if (!current || current.status !== "queued") continue;
        setQueueItem(item.id, { status: "uploading", error: undefined });
        try {
          const jpeg = await resizeToJpeg(current.file);
          const photo = await uploadSingle(jpeg, current.name);
          if (!photo) throw new Error("Upload failed.");
          setQueueItem(item.id, { status: "ready", photo });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Upload failed.";
          setQueueItem(item.id, { status: "failed", error: message });
        }
      }
      await refresh();
      // Scans run two at a time; every found piece lands in one review list.
      const ready = queueRef.current.filter((entry) => entry.status === "ready");
      let cursor = 0;
      const scanNext = async (): Promise<void> => {
        for (;;) {
          const index = cursor++;
          if (index >= ready.length) return;
          const entry = ready[index];
          if (!entry?.photo) continue;
          setQueueItem(entry.id, { status: "scanning", error: undefined });
          await scanPhoto(entry.photo, `photo ${index + 1} of ${ready.length}`, undefined, false, true);
          const latest = await refresh();
          const done = !!latest?.meta?.[entry.photo.pathname];
          setQueueItem(entry.id, done ? { status: "done" } : { status: "failed", error: "Scan failed." });
        }
      };
      await Promise.all([scanNext(), scanNext()]);
      setStatus("Queue finished. Tap Keep to add pieces to your closet.");
    } finally {
      setBusy(false);
    }
  }

  /** Retry one failed queue photo (upload first when it never uploaded). */
  async function retryQueueItem(id: string) {
    const entry = queueRef.current.find((item) => item.id === id);
    if (!entry || busy || entry.status === "uploading" || entry.status === "scanning") return;
    setBusy(true);
    try {
      let photo: Photo | undefined = entry.photo;
      if (!photo) {
        setQueueItem(id, { status: "uploading", error: undefined });
        const jpeg = await resizeToJpeg(entry.file);
        const uploaded = await uploadSingle(jpeg, entry.name);
        if (!uploaded) throw new Error("Upload failed.");
        photo = uploaded;
        setQueueItem(id, { status: "ready", photo });
        await refresh();
      }
      setQueueItem(id, { status: "scanning", error: undefined });
      await scanPhoto(photo, entry.name, undefined, false, true);
      const latest = await refresh();
      const done = !!latest?.meta?.[photo.pathname];
      setQueueItem(id, done ? { status: "done" } : { status: "failed", error: "Scan failed." });
      setStatus(done ? "Scan finished. Tap Keep to add pieces to your closet." : "Scan failed again.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed.";
      setQueueItem(id, { status: "failed", error: message });
      setStatus(`Retry failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  /** Crop one queued photo (before its upload turn); never blocks the queue. */
  function openQueueCrop(id: string) {
    const entry = queueRef.current.find((item) => item.id === id);
    if (!entry || entry.status !== "queued") return;
    setCropTarget({ displayUrl: entry.thumbUrl, source: { kind: "queue", id } });
    setStatus("Drag to crop around the garment, then Use crop — or Skip.");
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

  /** After a decision, show the done card when the review round drained. */
  function checkDrained(remaining: Candidate[]) {
    if (remaining.length === 0 && roundAdded.current > 0) {
      setDoneCard({ added: roundAdded.current });
      roundAdded.current = 0;
    }
  }

  async function keep(id: string) {
    const target = candidatesRef.current.find((c) => c.id === id);
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
      const remaining = candidatesRef.current.filter((c) => c.id !== id);
      setCandidates(remaining);
      roundAdded.current += 1;
      decrementPrompt(target);
      checkDrained(remaining);
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
    const target = candidatesRef.current.find((c) => c.id === id);
    clearTagTimer(id);
    setActing(true);
    try {
      const res = await fetch(`/api/closet/candidates/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const remaining = candidatesRef.current.filter((c) => c.id !== id);
      setCandidates(remaining);
      decrementPrompt(target);
      checkDrained(remaining);
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

  /** Persist an edit-sheet draft on a review card; the route re-validates. */
  async function saveCandidateEdit(id: string, draft: Record<string, unknown>) {
    const res = await fetch(`/api/closet/candidates/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    const body = (await res.json()) as { candidate?: Candidate; error?: string };
    if (!res.ok || !body.candidate) throw new Error(body.error ?? `HTTP ${res.status}`);
    setCandidates((prev) => prev.map((c) => (c.id === id ? { ...body.candidate as Candidate, tagging: false } : c)));
    setStatus("Saved. Keep it when it looks right.");
  }

  async function keepAll() {
    const acceptedIds = candidatesRef.current
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
      const remaining = candidatesRef.current.filter((c) => !acceptedIds.includes(c.id));
      setCandidates(remaining);
      roundAdded.current += acceptedIds.length;
      checkDrained(remaining);
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
  /** One clear state at a time: review, done, or the photo lists. */
  const reviewing = candidates.length > 0;
  const listsVisible = !reviewing && !doneCard;
  const editingCandidate = candidates.find((c) => c.id === editingId) ?? null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl md:max-w-[960px] flex-col gap-6 p-6">
      <h1 className="font-display text-4xl">Capture</h1>
      <p>Photograph one garment at a time against a plain background.</p>
      <input
        ref={takeRef}
        id="take-photo-input"
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(event) => void handleTakeFile(event.target.files?.[0])}
      />
      <input
        ref={uploadRef}
        id="upload-photos-input"
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(event) => void handleUploadFiles(event.target.files)}
      />
      <div className="flex flex-col gap-3 min-[480px]:flex-row">
        <button
          type="button"
          disabled={busy}
          onClick={() => takeRef.current?.click()}
          className="min-h-16 flex-1 rounded-full bg-(--primary) px-6 text-xl font-semibold whitespace-nowrap text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
        >
          {busy ? "Working…" : "Take photo"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => uploadRef.current?.click()}
          className="min-h-16 flex-1 rounded-full border border-(--border) px-6 text-xl font-semibold whitespace-nowrap disabled:text-(--disabled-text)"
        >
          Upload photos
        </button>
      </div>
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
      {queue.length > 0 && (
        <section aria-label="Photo queue" className="flex flex-col gap-3">
          <h2 className="font-display text-2xl">Adding photos</h2>
          <p role="status" className="text-lg">
            {queue.some((entry) => entry.status === "uploading")
              ? `Uploading ${queue.filter((entry) => ["ready", "scanning", "done", "failed"].includes(entry.status)).length + 1} of ${queue.length}…`
              : queue.some((entry) => entry.status === "scanning" || entry.status === "ready")
                ? `Scanning ${queue.filter((entry) => entry.status === "done" || entry.status === "failed").length + 1} of ${queue.length}…`
                : `Scanned ${queue.filter((entry) => entry.status === "done").length} of ${queue.length}.`}
          </p>
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {queue.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-2 rounded-2xl border border-(--border-soft) bg-(--surface-2) p-3"
              >
                <img
                  src={entry.thumbUrl}
                  alt={entry.name}
                  loading="lazy"
                  className="aspect-square w-full rounded-xl object-cover"
                />
                <p className="min-h-6 text-base text-(--text-muted)" aria-live="polite">
                  {entry.status === "failed"
                    ? (entry.error ?? "Failed.")
                    : entry.status === "queued"
                      ? "Waiting…"
                      : entry.status === "uploading"
                        ? "Uploading…"
                        : entry.status === "ready"
                          ? "Uploaded."
                          : entry.status === "scanning"
                            ? "Scanning…"
                            : "Done."}
                </p>
                {entry.status === "queued" && (
                  <button
                    type="button"
                    onClick={() => openQueueCrop(entry.id)}
                    aria-label={`Crop ${entry.name}`}
                    className="min-h-11 rounded-full border border-(--border) text-base font-semibold"
                  >
                    Crop
                  </button>
                )}
                {entry.status === "failed" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void retryQueueItem(entry.id)}
                    aria-label={`Retry ${entry.name}`}
                    className="min-h-11 rounded-full border border-(--border) text-base font-semibold disabled:text-(--disabled-text)"
                  >
                    Retry
                  </button>
                )}
              </li>
            ))}
          </ul>
          {queue.every((entry) => entry.status === "done" || entry.status === "failed") && (
            <button
              type="button"
              onClick={() => setQueue([])}
              className="min-h-11 self-start rounded-full border border-(--border) px-6 text-base font-semibold"
            >
              Clear list
            </button>
          )}
        </section>
      )}
      {cropTarget && (
        <CropEditor
          imageUrl={cropTarget.displayUrl}
          onDone={(cropped) => void finishCrop(cropped)}
        />
      )}
      {reviewing && (
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
              onEdit={(id) => setEditingId(id)}
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
                    onEdit={(id) => setEditingId(id)}
                  />
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {listsVisible && photoPrompt && photoPrompt.remaining === 0 && (
        <section aria-label="Photo cleanup" className="flex flex-col gap-4 rounded-2xl border border-(--border) p-4">
          {photoPrompt.found > 0 ? (
            <>
              <h2 className="font-display text-2xl">Get another item from this photo?</h2>
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
              <h2 className="font-display text-2xl">Couldn&apos;t spot it. Draw a box around the item.</h2>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => void openBacklogCrop(photoPrompt.root)}
                  className="min-h-14 flex-1 rounded-full bg-(--primary) text-lg font-semibold whitespace-nowrap text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
                >
                  Draw a box
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
      {!reviewing && doneCard && (
        <section
          aria-label="Scan complete"
          className="flex flex-col gap-4 rounded-2xl border border-(--border-soft) bg-(--surface-2) p-5"
        >
          <h2 className="font-display text-2xl">
            Added {doneCard.added} piece{doneCard.added === 1 ? "" : "s"} to your closet.
          </h2>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                setDoneCard(null);
                takeRef.current?.click();
              }}
              className="min-h-14 flex-1 rounded-full bg-(--primary) text-lg font-semibold whitespace-nowrap text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
            >
              Scan another photo
            </button>
            <Link
              href="/closet"
              onClick={() => setDoneCard(null)}
              className="flex min-h-14 flex-1 items-center justify-center rounded-full border border-(--border) text-lg font-semibold whitespace-nowrap"
            >
              View closet
            </Link>
          </div>
        </section>
      )}
      {listsVisible && (
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
      )}
      {listsVisible && scanned.length > 0 && (
        <section aria-label="Scanned photos" className="flex flex-col gap-4">
          <h2 className="font-display text-2xl">Scanned ({scanned.length})</h2>
          <ul className="flex flex-col gap-3">
            {scanned.map((photo, index) => {
              const kept = meta[photo.pathname]?.keptIds.length ?? 0;
              return (
                <li
                  key={photo.pathname}
                  className="flex items-center gap-3 rounded-2xl border border-(--border) bg-(--surface) p-3"
                >
                  <img
                    src={photo.url}
                    alt={`Scanned closet photo ${index + 1}`}
                    loading="lazy"
                    className="aspect-square w-16 shrink-0 rounded-xl object-cover"
                  />
                  <p className="min-w-0 flex-1 text-lg">
                    {kept === 0
                      ? "No items kept yet."
                      : `${kept} piece${kept === 1 ? "" : "s"} kept.`}
                  </p>
                  <details className="relative shrink-0">
                    <summary
                      aria-label={`Actions for scanned photo ${index + 1}`}
                      className="flex min-h-14 min-w-14 cursor-pointer list-none items-center justify-center rounded-full border border-(--border) text-2xl [&::-webkit-details-marker]:hidden"
                    >
                      ⋯
                    </summary>
                    <div className="absolute right-0 z-10 mt-2 flex min-w-44 flex-col gap-2 rounded-2xl border border-(--border-soft) bg-(--surface) p-3 shadow-[0_10px_24px_var(--shadow)]">
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => {
                          setBusy(true);
                          void scanPhoto(photo, `photo ${index + 1}`).finally(() => setBusy(false));
                        }}
                        className="min-h-14 rounded-full border border-(--border) px-6 text-lg font-semibold whitespace-nowrap disabled:text-(--disabled-text)"
                      >
                        Scan again
                      </button>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => void removePhoto(photo)}
                        aria-label={`Delete scanned photo ${index + 1}`}
                        className="min-h-14 rounded-full border border-(--border) px-6 text-lg font-semibold whitespace-nowrap disabled:text-(--disabled-text)"
                      >
                        Delete
                      </button>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {editingCandidate && (
        <ItemEditor
          item={candidateEditable(editingCandidate)}
          onSave={(id, draft) => saveCandidateEdit(id, draft)}
          onClose={() => setEditingId(null)}
        />
      )}
    </main>
  );
}
