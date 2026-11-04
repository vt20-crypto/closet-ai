"use client";

import { useEffect, useRef, useState } from "react";

import { tapeLabel } from "@/lib/labels";

import ItemEditor, { type EditableItem } from "../item-editor";
import GarmentTile from "../garment-tile";

interface ClosetItem {
  id: string;
  cutoutUrl: string;
  nouns: string[];
  confidence: number;
  /** True while the piece is in the laundry. */
  laundry?: boolean;
  tags: {
    is_single_garment: boolean;
    rejection_reason: string | null;
    type: string;
    primary_color: string;
    secondary_colors: string[];
    formality: number;
    warmth: number;
    layer: string;
    fabric_weight: string;
    pattern: string;
    seasons: string[];
    distinguishing_note: string;
    /** Absent on items tagged before nicknames existed. */
    nickname?: string;
    /** Absent on items tagged before fit details existed. */
    fit?: string;
    length?: string;
    sleeve?: string;
    rise?: string;
  };
}

/** Quiet second line under the nickname: fit (when known) + color. */
function tileCaption(item: ClosetItem): string {
  const fit = item.tags.fit && item.tags.fit !== "n/a" ? item.tags.fit : "";
  return [fit, item.tags.primary_color].filter(Boolean).join(" · ");
}

/** Item detail sheet: full tags + Edit / laundry / Delete. Native dialog. */
function ItemDetail({
  item,
  deleting,
  laundryBusy,
  onClose,
  onEdit,
  onToggleLaundry,
  onDelete,
}: {
  item: ClosetItem;
  deleting: string | null;
  laundryBusy: string | null;
  onClose: () => void;
  onEdit: () => void;
  onToggleLaundry: () => void;
  onDelete: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const title = `${item.tags.type} in ${item.tags.primary_color}`;
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="item-detail-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
      className="fixed inset-x-0 bottom-0 m-0 mx-auto max-h-[90dvh] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-t-[20px] border border-(--border-soft) bg-(--surface) p-6 text-(--text) backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <h2 id="item-detail-title" className="min-w-0 flex-1 truncate font-display text-2xl capitalize">
            {title}
          </h2>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="min-h-11 shrink-0 rounded-full border border-(--border) px-5 text-base font-semibold"
          >
            Close
          </button>
        </div>
        {item.laundry && (
          <p className="text-lg text-(--text-muted)">In laundry — sitting out of outfit picks.</p>
        )}
        <dl className="flex flex-col gap-1 text-lg">
          <div className="flex gap-2">
            <dt className="font-semibold">Colors:</dt>
            <dd className="capitalize">{[item.tags.primary_color, ...item.tags.secondary_colors].join(", ")}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold">Formality:</dt>
            <dd>{item.tags.formality} of 5</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold">Warmth:</dt>
            <dd>{item.tags.warmth} of 5</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold">Layer:</dt>
            <dd className="capitalize">{item.tags.layer}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold">Fabric:</dt>
            <dd className="capitalize">{item.tags.fabric_weight}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold">Pattern:</dt>
            <dd className="capitalize">{item.tags.pattern}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold">Seasons:</dt>
            <dd className="capitalize">{item.tags.seasons.join(", ")}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold">Note:</dt>
            <dd>{item.tags.distinguishing_note}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${title}`}
            className="min-h-12 flex-1 rounded-full border border-(--border) px-4 text-lg font-semibold whitespace-nowrap"
          >
            Edit
          </button>
          <button
            type="button"
            disabled={laundryBusy === item.id}
            onClick={onToggleLaundry}
            className="min-h-12 flex-1 rounded-full border border-(--border) px-4 text-lg font-semibold whitespace-nowrap disabled:text-(--disabled-text)"
          >
            {laundryBusy === item.id ? "Saving…" : item.laundry ? "Back from laundry" : "In laundry"}
          </button>
          {confirmDelete ? (
            <>
              <button
                type="button"
                disabled={deleting === item.id}
                onClick={onDelete}
                aria-label={`Confirm delete ${title}`}
                className="min-h-12 flex-1 rounded-full bg-(--danger) px-4 text-lg font-semibold whitespace-nowrap text-(--background) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
              >
                {deleting === item.id ? "Deleting…" : "Yes, delete"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="min-h-12 flex-1 rounded-full border border-(--border) px-4 text-lg font-semibold whitespace-nowrap"
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              aria-label={`Delete ${title}`}
              className="min-h-12 flex-1 rounded-full border border-(--border) px-4 text-lg font-semibold whitespace-nowrap text-(--danger)"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}

function toEditable(item: ClosetItem): EditableItem {
  return {
    id: item.id,
    label: `${item.tags.primary_color} ${item.tags.type}`,
    cutoutUrl: item.cutoutUrl,
    tags: {
      nickname: item.tags.nickname ?? "",
      type: item.tags.type,
      primary_color: item.tags.primary_color,
      fit: item.tags.fit ?? "n/a",
      length: item.tags.length ?? "n/a",
      sleeve: item.tags.sleeve ?? "n/a",
      rise: item.tags.rise ?? "n/a",
      formality: item.tags.formality,
      warmth: item.tags.warmth,
    },
  };
}

const STORAGE_DOWN = "Can't reach your closet right now. Your pieces are safe - try again in a minute.";

export default function ClosetPage() {
  const [items, setItems] = useState<ClosetItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("Loading your closet…");
  const [storageDown, setStorageDown] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [retagging, setRetagging] = useState(false);
  const [editing, setEditing] = useState<ClosetItem | null>(null);
  const [detail, setDetail] = useState<ClosetItem | null>(null);
  const [laundryBusy, setLaundryBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/closet", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as { items?: ClosetItem[]; error?: string; code?: string };
        if (res.status === 503 && body.code === "storage_unavailable") {
          if (!cancelled) {
            setStorageDown(true);
            setStatus(STORAGE_DOWN);
            setLoaded(true);
          }
          return;
        }
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setStorageDown(false);
          setItems(body.items ?? []);
          setLoaded(true);
          setStatus(
            (body.items ?? []).length > 0
              ? `Closet has ${(body.items ?? []).length} item${(body.items ?? []).length === 1 ? "" : "s"}.`
              : "Your closet is empty. Capture some clothes first.",
          );
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Could not load the closet.";
          setStatus(`Could not load the closet: ${message}`);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function remove(id: string, label: string) {
    setDeleting(id);
    try {
      const res = await fetch(`/api/closet/items/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setItems((prev) => prev.filter((item) => item.id !== id));
      setStatus(`Deleted ${label}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Delete failed.";
      setStatus(`Delete failed: ${message}`);
    } finally {
      setDeleting(null);
    }
  }

  /** Re-run the fit-only tagger on items tagged before fit details existed. */
  async function retagFit() {
    const stale = items.filter((item) => !item.tags.fit).length;
    if (stale === 0 || retagging) return;
    setRetagging(true);
    setStatus(`Updating fit details on ${stale} item${stale === 1 ? "" : "s"}…`);
    try {
      const res = await fetch("/api/closet/retag-fit", { method: "POST" });
      const body = (await res.json()) as { updated?: number; failed?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setStatus(
        `Updated ${body.updated ?? 0} piece${(body.updated ?? 0) === 1 ? "" : "s"} — tap any item to review.` +
          ((body.failed ?? 0) > 0 ? ` (${body.failed} failed.)` : ""),
      );
      const fresh = await fetch("/api/closet", { cache: "no-store" });
      const freshBody = (await fresh.json()) as { items?: ClosetItem[] };
      if (fresh.ok && freshBody.items) setItems(freshBody.items);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Retag failed.";
      setStatus(`Fit update failed: ${message}`);
    } finally {
      setRetagging(false);
    }
  }

  /** Toggle laundry: the piece sits out of outfit picks until washed. */
  async function toggleLaundry(item: ClosetItem) {
    if (laundryBusy) return;
    setLaundryBusy(item.id);
    try {
      const res = await fetch(`/api/closet/items/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ laundry: !item.laundry }),
      });
      const body = (await res.json()) as { item?: ClosetItem; error?: string };
      if (!res.ok || !body.item) throw new Error(body.error ?? `HTTP ${res.status}`);
      setItems((prev) => prev.map((entry) => (entry.id === item.id ? (body.item as ClosetItem) : entry)));
      setDetail((prev) => (prev?.id === item.id ? (body.item as ClosetItem) : prev));
      setStatus(body.item.laundry ? "Marked as in laundry — sitting out of picks." : "Back in the closet.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't update laundry.");
    } finally {
      setLaundryBusy(null);
    }
  }

  /** Persist an edit-sheet draft; the route re-validates every field. */
  async function saveEdit(id: string, draft: Record<string, unknown>) {
    const res = await fetch(`/api/closet/items/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    const body = (await res.json()) as { item?: ClosetItem; error?: string };
    if (!res.ok || !body.item) throw new Error(body.error ?? `HTTP ${res.status}`);
    setItems((prev) => prev.map((entry) => (entry.id === id ? body.item as ClosetItem : entry)));
    setStatus("Saved. Outfit picks will use the new details.");
  }

  const needsFit = items.some((item) => !item.tags.fit);

  const groups = new Map<string, ClosetItem[]>();
  for (const item of items) {
    const key = item.tags.type || "other";
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 p-6 md:max-w-[960px]">
      <h1 className="font-display text-4xl">Closet</h1>
      <p role="status" aria-live="polite" className="text-lg">
        {status}
      </p>
      {!storageDown && needsFit && (
        <div className="flex flex-col items-start gap-2">
          <button
            type="button"
            disabled={retagging}
            onClick={() => void retagFit()}
            className="min-h-14 self-start rounded-full border border-(--border) px-6 text-lg font-semibold disabled:text-(--disabled-text)"
          >
            {retagging ? "Detecting fit details…" : "Let AI fill in fit details"}
          </button>
          {!retagging && (
            <p className="text-lg text-(--text-muted)">
              Detects baggy, slim, cropped, high-rise… for each piece. You can edit any item.
            </p>
          )}
        </div>
      )}
      {!storageDown &&
        [...groups.entries()].map(([type, group]) => (
        <section key={type} aria-label={`${type} (${group.length})`} className="flex flex-col gap-3">
          <h2 className="font-display text-2xl capitalize">
            {type} · {group.length}
          </h2>
          <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
            {!loaded
              ? Array.from({ length: 6 }, (_, index) => (
                  <li
                    key={`skeleton-${index}`}
                    aria-hidden="true"
                    className="flex flex-col gap-2 rounded-2xl border border-(--border-soft) bg-(--surface-2) p-3"
                  >
                    <span className="aspect-[3/4] w-full rounded-xl bg-(--surface) motion-safe:animate-pulse" />
                    <span className="h-6 w-2/3 rounded bg-(--surface) motion-safe:animate-pulse" />
                    <span className="h-4 w-1/2 rounded bg-(--surface) motion-safe:animate-pulse" />
                  </li>
                ))
              : group.map((item) => (
                  <li key={item.id}>
                    <GarmentTile
                      id={item.id}
                      title={`${item.tags.type} in ${item.tags.primary_color}`}
                      imageUrl={item.cutoutUrl}
                      tape={tapeLabel(item.tags)}
                      caption={tileCaption(item)}
                      badge={item.laundry ? "In laundry" : undefined}
                      onOpen={() => setDetail(item)}
                    />
                  </li>
                ))}
          </ul>
        </section>
      ))}
      {editing && (
        <ItemEditor
          item={toEditable(editing)}
          onSave={(id, draft) => saveEdit(id, draft)}
          onClose={() => setEditing(null)}
        />
      )}
      {detail && !editing && (
        <ItemDetail
          item={detail}
          deleting={deleting}
          laundryBusy={laundryBusy}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setEditing(detail);
            setDetail(null);
          }}
          onToggleLaundry={() => void toggleLaundry(detail)}
          onDelete={() => {
            setDetail(null);
            void remove(detail.id, detail.tags.type);
          }}
        />
      )}
    </main>
  );
}
