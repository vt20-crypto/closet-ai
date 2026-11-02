"use client";

import { useEffect, useState } from "react";

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
  };
}

export default function ClosetPage() {
  const [items, setItems] = useState<ClosetItem[]>([]);
  const [status, setStatus] = useState("Loading your closet…");
  const [deleting, setDeleting] = useState<string | null>(null);

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
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-3xl font-bold">Closet</h1>
      <p role="status" aria-live="polite" className="text-lg">
        {status}
      </p>
      {[...groups.entries()].map(([type, group]) => (
        <section key={type} aria-label={`${type} (${group.length})`} className="flex flex-col gap-4">
          <h2 className="text-2xl font-bold capitalize">
            {type} ({group.length})
          </h2>
          <ul className="grid grid-cols-2 gap-4">
            {group.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-2 rounded-2xl border border-neutral-300 p-3 dark:border-neutral-700"
              >
                <img
                  src={item.cutoutUrl}
                  alt={`${item.tags.type} in ${item.tags.primary_color}`}
                  loading="lazy"
                  className="w-full rounded-xl bg-neutral-100 object-contain dark:bg-neutral-800"
                />
                <p className="text-lg font-semibold capitalize">{item.tags.type}</p>
                <p className="capitalize">{item.tags.primary_color}</p>
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
                </details>
                <button
                  type="button"
                  disabled={deleting === item.id}
                  onClick={() => void remove(item.id, item.tags.type)}
                  aria-label={`Delete ${item.tags.type} in ${item.tags.primary_color}`}
                  className="min-h-14 rounded-2xl border border-neutral-400 text-lg font-semibold disabled:opacity-50"
                >
                  {deleting === item.id ? "Deleting…" : "Delete"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
