import "server-only";

import { listItems } from "./closet";
import { fitInside } from "./cutout";
import { detectImageFormat, type FitTags, type ImageFormat } from "./render";

/** Garment cutouts shrink to this; the avatar reference to AVATAR_MAX_SIDE. */
export const CUTOUT_MAX_SIDE = 768;
export const AVATAR_MAX_SIDE = 1024;

export interface RenderInputs {
  /** Avatar bytes, shrunk to AVATAR_MAX_SIDE, with sniffed format. */
  avatarBytes: Buffer;
  avatarFormat: ImageFormat;
  /** Data URLs (sniffed mimes) for the shrunk cutouts, in outfit order. */
  cutoutDataUrls: string[];
  /** Total resized bytes sent to images/edits. */
  inputBytes: number;
  /** Per-garment fit tags, in outfit order, for render/verify prompts. */
  garments: FitTags[];
}

/** Per-instance memory cache of fetched+shrunk bytes, keyed by Blob URL. */
const bytesCache = new Map<string, Buffer>();

/**
 * Load + shrink one render's inputs: the avatar (from Blob) and every
 * garment cutout. Throws on unknown ids or an unloadable avatar. Never logs
 * images — callers log counts and byte sizes only.
 */
export async function loadRenderInputs(
  itemIds: string[],
  avatarUrl: string,
): Promise<RenderInputs> {
  const items = await listItems();
  const byId = new Map(items.map((item) => [item.id, item]));
  const missing = itemIds.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error("Unknown closet item.");

  let avatarBytes = bytesCache.get(avatarUrl);
  if (!avatarBytes) {
    const avatarRes = await fetch(avatarUrl, { cache: "no-store" });
    if (!avatarRes.ok) throw new Error("Could not load the avatar.");
    avatarBytes = await fitInside(Buffer.from(await avatarRes.arrayBuffer()), AVATAR_MAX_SIDE);
    bytesCache.set(avatarUrl, avatarBytes);
  }
  const avatarFormat = detectImageFormat(avatarBytes);

  const cutoutDataUrls: string[] = [];
  const garments: FitTags[] = [];
  let inputBytes = avatarBytes.length;
  for (const id of itemIds) {
    const item = byId.get(id)!;
    const cutoutUrl = item.cutoutUrl;
    garments.push({
      type: item.tags.type,
      primary_color: item.tags.primary_color,
      fit: item.tags.fit,
      length: item.tags.length,
      rise: item.tags.rise,
      sleeve: item.tags.sleeve,
    });
    let shrunk = bytesCache.get(cutoutUrl);
    if (!shrunk) {
      const cutoutRes = await fetch(cutoutUrl, { cache: "no-store" });
      if (!cutoutRes.ok) throw new Error("Could not load a garment cutout.");
      shrunk = await fitInside(Buffer.from(await cutoutRes.arrayBuffer()), CUTOUT_MAX_SIDE);
      bytesCache.set(cutoutUrl, shrunk);
    }
    inputBytes += shrunk.length;
    const format = detectImageFormat(shrunk);
    cutoutDataUrls.push(`data:${format.contentType};base64,${shrunk.toString("base64")}`);
  }
  return { avatarBytes, avatarFormat, cutoutDataUrls, inputBytes, garments };
}
