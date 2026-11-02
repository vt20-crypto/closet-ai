import "server-only";

import { copy, del, list, put } from "@vercel/blob";

import type { GarmentTags } from "./meta/spark";

export interface ClosetBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One garment item. Candidates and confirmed items share this shape. */
export interface ClosetItem {
  id: string;
  cutoutUrl: string;
  nouns: string[];
  confidence: number;
  box: ClosetBox;
  tags: GarmentTags;
  photoUrl: string;
  /** Blob pathname of the source photo (absent on pre-scan-pipeline items). */
  photoPathname?: string;
  createdAt: string;
}

export function newId(): string {
  return crypto.randomUUID();
}

const candidatePng = (id: string) => `candidates/${id}.png`;
const candidateJson = (id: string) => `candidates/${id}.json`;
const itemPng = (id: string) => `items/${id}.png`;
const itemJson = (id: string) => `items/${id}.json`;

async function listAllJson(prefix: string): Promise<ClosetItem[]> {
  const items: ClosetItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor });
    const metas = await Promise.all(
      page.blobs
        .filter((b) => b.pathname.endsWith(".json"))
        .map(async (b) => {
          try {
            const res = await fetch(b.url, { cache: "no-store" });
            if (!res.ok) return null;
            return (await res.json()) as ClosetItem;
          } catch {
            return null;
          }
        }),
    );
    for (const m of metas) if (m) items.push(m);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return items;
}

/** Upload a candidate cutout PNG. Returns its public URL. */
export async function putCandidatePng(id: string, png: Buffer): Promise<string> {
  const blob = await put(candidatePng(id), png, {
    access: "public",
    contentType: "image/png",
    addRandomSuffix: false,
  });
  return blob.url;
}

export async function saveCandidate(item: ClosetItem): Promise<void> {
  await put(candidateJson(item.id), JSON.stringify(item), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
  });
}

export async function listCandidates(): Promise<ClosetItem[]> {
  return listAllJson("candidates/");
}

export async function getCandidate(id: string): Promise<ClosetItem | null> {
  const page = await list({ prefix: `candidates/${id}.` });
  const json = page.blobs.find((b) => b.pathname === candidateJson(id));
  if (!json) return null;
  const res = await fetch(json.url, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as ClosetItem;
}

export async function deleteCandidate(id: string): Promise<void> {
  await del([candidatePng(id), candidateJson(id)]);
}

export async function listItems(): Promise<ClosetItem[]> {
  return listAllJson("items/");
}

/**
 * Move a candidate to items/: copy the PNG, write the item JSON with the new
 * cutout URL, then delete the candidate blobs.
 */
export async function confirmCandidate(id: string): Promise<ClosetItem> {
  const candidate = await getCandidate(id);
  if (!candidate) throw new Error(`Candidate not found: ${id}`);
  const copied = await copy(candidate.cutoutUrl, itemPng(id), { access: "public" });
  const item: ClosetItem = { ...candidate, cutoutUrl: copied.url };
  await put(itemJson(id), JSON.stringify(item), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
  });
  await deleteCandidate(id);
  return item;
}

export async function deleteItem(id: string): Promise<void> {
  await del([itemPng(id), itemJson(id)]);
}
