/**
 * Detection filters (pure functions, no I/O): confidence -> area -> dedupe ->
 * footwear-pair merge. Thresholds come from spikes/RESULTS.md round 2:
 * GOOD conf 0.926-0.984 vs JUNK up to 0.922, so confidence alone cannot
 * separate them; the Spark is_single_garment gate does the final cut.
 */

export interface FilterBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FilterDetection {
  noun: string;
  box: FilterBox;
  confidence: number;
}

export const MIN_CONFIDENCE = 0.6;
export const MIN_AREA_FRACTION = 0.02;
export const DEDUPE_IOU = 0.6;

export const FOOTWEAR_NOUNS = new Set(["shoe", "sneaker", "boot"]);

export function boxIoU(a: FilterBox, b: FilterBox): number {
  const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const inter = ix * iy;
  const areaA = Math.max(0, a.right - a.left) * Math.max(0, a.bottom - a.top);
  const areaB = Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Drop overlapping detections across nouns (e.g. "shirt" + "t-shirt" on the
 * same garment): box IoU > 0.6 keeps the highest confidence. Stable order:
 * ties keep their input order.
 */
export function dedupeDetections<T extends FilterDetection>(detections: T[]): T[] {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept: T[] = [];
  for (const det of sorted) {
    if (kept.every((k) => boxIoU(k.box, det.box) <= DEDUPE_IOU)) kept.push(det);
  }
  return kept;
}

function boxHeight(b: FilterBox): number {
  return Math.max(0, b.bottom - b.top);
}

function boxWidth(b: FilterBox): number {
  return Math.max(0, b.right - b.left);
}

/**
 * Side-by-side footwear test: the two boxes overlap vertically by more than
 * half of the shorter box, sit close horizontally (gap < 25% of the average
 * box width; touching/overlapping counts as gap 0), and have similar heights
 * (ratio within 0.7-1.4 either direction).
 */
export function shouldMergeShoePair(a: FilterBox, b: FilterBox): boolean {
  const hA = boxHeight(a);
  const hB = boxHeight(b);
  if (hA <= 0 || hB <= 0) return false;
  const minH = Math.min(hA, hB);
  const maxH = Math.max(hA, hB);
  if (minH / maxH < 0.7 || maxH / minH > 1.4) return false;

  const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  if (overlapY / minH <= 0.5) return false;

  const gap = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
  const avgW = (boxWidth(a) + boxWidth(b)) / 2;
  if (avgW <= 0 || gap >= 0.25 * avgW) return false;

  return true;
}

export interface MergedPair<T extends FilterDetection> {
  nouns: string[];
  box: FilterBox;
  confidence: number;
  sources: T[];
}

function unionBox(a: FilterBox, b: FilterBox): FilterBox {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/**
 * Merge side-by-side shoe/sneaker/boot detections into single pair items.
 * Greedy: each detection joins at most one pair (leftovers from triples stay
 * single). Non-footwear detections pass through untouched. Output order:
 * merged pairs first (input order), then untouched detections (input order).
 */
export function mergeFootwearPairs<T extends FilterDetection>(detections: T[]): {
  merged: MergedPair<T>[];
  singles: T[];
} {
  const merged: MergedPair<T>[] = [];
  const singles: T[] = [];
  const used = new Array<boolean>(detections.length).fill(false);

  for (let i = 0; i < detections.length; i += 1) {
    if (used[i]) continue;
    const det = detections[i] as T;
    if (!FOOTWEAR_NOUNS.has(det.noun)) {
      singles.push(det);
      used[i] = true;
      continue;
    }
    let partner = -1;
    for (let j = i + 1; j < detections.length; j += 1) {
      if (used[j]) continue;
      const other = detections[j] as T;
      if (!FOOTWEAR_NOUNS.has(other.noun)) continue;
      if (shouldMergeShoePair(det.box, other.box)) {
        partner = j;
        break;
      }
    }
    if (partner === -1) {
      singles.push(det);
      used[i] = true;
    } else {
      const other = detections[partner] as T;
      used[i] = true;
      used[partner] = true;
      merged.push({
        nouns: [det.noun, other.noun],
        box: unionBox(det.box, other.box),
        confidence: Math.max(det.confidence, other.confidence),
        sources: [det, other],
      });
    }
  }
  return { merged, singles };
}
