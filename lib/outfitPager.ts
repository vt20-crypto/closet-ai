// Client-side paging over one server response of score-gated outfits.
// Pure reducer: page size 3, no wrap, never repeats a combo this session.
// "More ideas" appends a fresh server response (unseen combos only).

export const PAGE_SIZE = 3;

export interface PagerOutfit {
  key: string;
}

export interface OutfitPagerState<T extends PagerOutfit> {
  list: T[];
  /** Offset of the currently shown page. */
  index: number;
  /** Keys shown this session, in order. */
  seen: string[];
}

export function createPager<T extends PagerOutfit>(list: T[]): OutfitPagerState<T> {
  const state: OutfitPagerState<T> = { list: [...list], index: 0, seen: [] };
  return markSeen(state, currentPage(state).map((o) => o.key));
}

export function currentPage<T extends PagerOutfit>(state: OutfitPagerState<T>): T[] {
  return state.list.slice(state.index, state.index + PAGE_SIZE);
}

/** True while an unseen next page exists (Shuffle advances without an AI call). */
export function hasMore<T extends PagerOutfit>(state: OutfitPagerState<T>): boolean {
  return state.index + PAGE_SIZE < state.list.length;
}

/** Advance to the next page; stays put when exhausted (no wrap). */
export function nextPage<T extends PagerOutfit>(state: OutfitPagerState<T>): OutfitPagerState<T> {
  if (!hasMore(state)) return state;
  const advanced: OutfitPagerState<T> = { ...state, index: state.index + PAGE_SIZE };
  return markSeen(advanced, currentPage(advanced).map((o) => o.key));
}

function markSeen<T extends PagerOutfit>(
  state: OutfitPagerState<T>,
  keys: string[],
): OutfitPagerState<T> {
  const seen = [...state.seen];
  for (const key of keys) {
    if (!seen.includes(key)) seen.push(key);
  }
  return { ...state, seen };
}

/**
 * Append a "More ideas" server response: only combos never listed and never
 * shown. The current page stays put; the next Shuffle reveals the new page.
 */
export function appendMore<T extends PagerOutfit>(
  state: OutfitPagerState<T>,
  extra: T[],
): OutfitPagerState<T> {
  const known = new Set([...state.list.map((o) => o.key), ...state.seen]);
  const fresh = extra.filter((o) => !known.has(o.key));
  if (fresh.length === 0) return state;
  // Jump to the first page holding fresh items so More ideas shows them
  // right away, and mark that page seen.
  const grown: OutfitPagerState<T> = {
    ...state,
    list: [...state.list, ...fresh],
    index: Math.floor(state.list.length / PAGE_SIZE) * PAGE_SIZE,
  };
  return markSeen(grown, currentPage(grown).map((o) => o.key));
}

/** 1-based "Look 4–6" range for the current page. */
export function pageRange<T extends PagerOutfit>(state: OutfitPagerState<T>): { from: number; to: number } {
  const page = currentPage(state);
  return { from: state.index + 1, to: state.index + page.length };
}
