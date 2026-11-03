import type { OutfitCategory } from "./outfits.ts";

/**
 * Pure get-dressed state machine. Dressing order is fixed and deterministic:
 * base-layer tops → bottoms/dresses → mid layers → outer → shoes → other.
 */

export type DressStepStatus = "todo" | "done" | "skipped";

export interface DressStep {
  itemId: string;
  status: DressStepStatus;
}

export interface DressState {
  steps: DressStep[];
  /** Position of the current step. */
  index: number;
  unavailableIds: string[];
  done: boolean;
}

export interface DressItem {
  id: string;
  slot: OutfitCategory;
  layer: string;
  nickname: string;
}

function stepRank(item: DressItem): number {
  if (item.slot === "other") return 5;
  if (item.slot === "shoes") return 4;
  if (item.slot === "outer") return 3;
  if (item.layer === "mid") return 2;
  if (item.slot === "bottom" || item.slot === "dress") return 1;
  return 0;
}

/** Item ids in dressing order (stable: nickname, then id, breaks ties). */
export function orderSteps(items: DressItem[]): string[] {
  return [...items]
    .sort((a, b) => stepRank(a) - stepRank(b) || a.nickname.localeCompare(b.nickname) || a.id.localeCompare(b.id))
    .map((item) => item.id);
}

export function createDressState(orderedIds: string[]): DressState {
  return {
    steps: orderedIds.map((itemId) => ({ itemId, status: "todo" as DressStepStatus })),
    index: 0,
    unavailableIds: [],
    done: orderedIds.length === 0,
  };
}

export function currentStep(state: DressState): DressStep | null {
  if (state.done || state.index >= state.steps.length) return null;
  return state.steps[state.index];
}

function moveNext(state: DressState, status: DressStepStatus): DressState {
  if (state.done) return state;
  const steps = state.steps.map((step, i) => (i === state.index ? { ...step, status } : step));
  const index = state.index + 1;
  return { ...state, steps, index, done: index >= steps.length };
}

/** Mark the current step done and move on; finishing the last step ends. */
export function advance(state: DressState): DressState {
  return moveNext(state, "done");
}

/** Mark the current step skipped and move on. */
export function skipStep(state: DressState): DressState {
  return moveNext(state, "skipped");
}

/** Go back one step so the user can redo it (statuses are kept). */
export function backStep(state: DressState): DressState {
  if (state.index <= 0) return state;
  return { ...state, index: state.index - 1, done: false };
}

/**
 * Replace the step holding oldItemId with newItemId and jump to it.
 * Unknown old ids leave the state untouched.
 */
export function applySwap(state: DressState, oldItemId: string, newItemId: string): DressState {
  const at = state.steps.findIndex((step) => step.itemId === oldItemId);
  if (at < 0 || oldItemId === newItemId) return state;
  const steps = state.steps.map((step, i) =>
    i === at ? { itemId: newItemId, status: "todo" as DressStepStatus } : step,
  );
  return { ...state, steps, index: at, done: false };
}

export function markUnavailable(state: DressState, itemId: string): DressState {
  if (state.unavailableIds.includes(itemId)) return state;
  return { ...state, unavailableIds: [...state.unavailableIds, itemId] };
}

export function finishDress(state: DressState): DressState {
  return { ...state, done: true };
}
