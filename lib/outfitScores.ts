// Score gate for AI outfit picks. Pure module (no server imports) so
// node:test can cover it. Scores are 1-10 for style + weather + occasion
// fit; unscored outfits count as a neutral 5.

export interface ScoredOutfit {
  key: string;
  score?: number;
}

// Clamp a model score to 1-10; missing/non-numeric scores count as 5.
export function scoreOf(outfit: { score?: unknown }): number {
  const raw = outfit.score;
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 5;
  return Math.max(1, Math.min(10, n));
}

export interface ThresholdResult<T> {
  picked: T[];
  relaxed: boolean;
}

// Keep outfits at/above threshold, best first. First pass (threshold 7)
// with nothing strong but valid outfits present relaxes to the top 2
// at/above 5 so the result is never empty when valid outfits exist.
export function applyScoreThreshold<T extends ScoredOutfit>(
  all: T[],
  threshold: number,
): ThresholdResult<T> {
  const ranked = [...all].sort((a, b) => scoreOf(b) - scoreOf(a));
  const strong = ranked.filter((o) => scoreOf(o) >= threshold);
  if (strong.length > 0) {
    return { picked: strong, relaxed: false };
  }
  if (ranked.length > 0 && threshold > 5) {
    const decent = ranked.filter((o) => scoreOf(o) >= 5).slice(0, 2);
    return { picked: decent.length > 0 ? decent : ranked.slice(0, 2), relaxed: true };
  }
  return { picked: [], relaxed: false };
}
