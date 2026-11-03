"use client";

import { useEffect, useState } from "react";

import { tapeLabel } from "@/lib/labels";

import { Sticker, Tape } from "../sticker";

interface ClosetItem {
  id: string;
  cutoutUrl: string;
  nouns: string[];
  confidence: number;
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
  };
}

export default function ClosetPage() {
  const [items, setItems] = useState<ClosetItem[]>([]);
  const [status, setStatus] = useState("Loading your closet…");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/closet", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as { items?: ClosetItem[]; error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setItems(body.items ?? []);
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
      {[...groups.entries()].map(([type, group]) => (
        <section key={type} aria-label={`${type} (${group.length})`} className="flex flex-col gap-3">
          <h2 className="font-display text-2xl capitalize">
            {type} · {group.length}
          </h2>
          <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
            {group.map((item) => (
              <li
                key={item.id}
                className="flex flex-col rounded-[20px] border border-(--border-soft) bg-(--surface-2) p-3 shadow-[0_10px_24px_var(--shadow)]"
              >
                <div className="flex aspect-[3/4] w-full items-center justify-center px-2 pt-2">
                  <Sticker
                    src={item.cutoutUrl}
                    alt={`${item.tags.type} in ${item.tags.primary_color}`}
                    seedId={item.id}
                    lazy
                  />
                </div>
                <p className="mt-1 mb-1 self-center">
                  <Tape label={tapeLabel(item.tags)} seedId={item.id} />
                </p>
                <details>
                  <summary className="min-h-11 cursor-pointer py-2 text-lg underline">
                    Details
                  </summary>
                  <dl className="flex flex-col gap-1 text-base">
                    <div className="flex gap-2">
                      <dt className="font-semibold">Colors:</dt>
                      <dd className="capitalize">
                        {[item.tags.primary_color, ...item.tags.secondary_colors].join(", ")}
                      </dd>
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
                  <div className="flex gap-2 pt-2">
                    {confirming === item.id ? (
                      <>
                        <button
                          type="button"
                          disabled={deleting === item.id}
                          onClick={() => {
                            setConfirming(null);
                            void remove(item.id, item.tags.type);
                          }}
                          aria-label={`Confirm delete ${item.tags.type} in ${item.tags.primary_color}`}
                          className="min-h-12 flex-1 rounded-full bg-(--danger) px-4 text-lg font-semibold text-(--background) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
                        >
                          {deleting === item.id ? "Deleting…" : "Yes, delete"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirming(null)}
                          className="min-h-12 flex-1 rounded-full border border-(--border) px-4 text-lg font-semibold"
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirming(item.id)}
                        aria-label={`Delete ${item.tags.type} in ${item.tags.primary_color}`}
                        className="min-h-12 flex-1 rounded-full border border-(--border) px-4 text-lg font-semibold text-(--danger)"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
