// Pure stage navigation: one look at a time, wrap-around both ends.
// The gesture handler and the Prev/Next buttons share this so swipe and
// tap can never disagree about the landing index.

/** Next stage index for a delta (-1 = prev, +1 = next), wrapping. */
export function stageStep(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/** Forward distance in looks between two stage indices, always non-negative. */
export function stageDistance(from: number, to: number, length: number): number {
  if (length <= 0) return 0;
  return (
    ((to - from) % length + length) % length
  );
}
