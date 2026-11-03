import { NextResponse } from "next/server";

import { listItems } from "@/lib/closet";
import type { DressState, DressStep } from "@/lib/dress";
import {
  createRetryBudget,
  isTransientModel404,
  META_HICCUP_MESSAGE,
  META_UNAVAILABLE_CODE,
} from "@/lib/meta/retry";
import { replanOutfit } from "@/lib/meta/spark";
import type { ReplanCandidate } from "@/lib/dressAgent";
import { slotForType } from "@/lib/outfits";

export const maxDuration = 60;

function isStep(value: unknown): value is DressStep {
  if (typeof value !== "object" || value === null) return false;
  const step = value as Record<string, unknown>;
  return (
    typeof step.itemId === "string" &&
    (step.status === "todo" || step.status === "done" || step.status === "skipped")
  );
}

function isDressState(value: unknown): value is DressState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    Array.isArray(state.steps) &&
    state.steps.every(isStep) &&
    typeof state.index === "number" &&
    Array.isArray(state.unavailableIds) &&
    state.unavailableIds.every((id) => typeof id === "string") &&
    typeof state.done === "boolean"
  );
}

/**
 * Voice replan: { state, transcript, weatherLine? } → { say, state, trace,
 * stopped }. Every id the agent loop touches is validated against the closet;
 * the trace holds plain-language tool lines (no images) for the "How I
 * decided" disclosure. Logs timings + steps only, never transcripts.
 */
export async function POST(req: Request) {
  const started = Date.now();
  // 45s shared loop budget inside the 60s route ceiling.
  const budget = createRetryBudget(started + 45_000);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send JSON: state, transcript." }, { status: 400 });
  }
  const { state, transcript, weatherLine } = (body ?? {}) as {
    state?: unknown;
    transcript?: unknown;
    weatherLine?: unknown;
  };
  if (!isDressState(state)) {
    return NextResponse.json({ error: "state must be a dress state." }, { status: 400 });
  }
  if (typeof transcript !== "string" || transcript.trim().length === 0 || transcript.length > 500) {
    return NextResponse.json({ error: "transcript must be 1–500 characters." }, { status: 400 });
  }

  try {
    const items = await listItems();
    const byId = new Map(items.map((item) => [item.id, item]));
    const unknownStep = state.steps.find((step) => !byId.has(step.itemId));
    if (unknownStep) {
      return NextResponse.json({ error: "Outfit holds an unknown closet item." }, { status: 400 });
    }
    const candidates: ReplanCandidate[] = items.map((item) => ({
      id: item.id,
      slot: slotForType(item.tags.type),
      nickname: item.tags.nickname || `${item.tags.primary_color} ${item.tags.type}`,
      primary_color: item.tags.primary_color,
      warmth: item.tags.warmth,
      formality: item.tags.formality,
      layer: item.tags.layer,
    }));
    const outcome = await replanOutfit({
      items: candidates,
      state,
      transcript: transcript.trim(),
      weatherLine: typeof weatherLine === "string" ? weatherLine : null,
      budget,
    });
    const badId = outcome.state.steps.find((step) => !byId.has(step.itemId));
    if (badId) {
      console.log(`dress replan ERROR unknown id after loop`);
      return NextResponse.json({ error: "Replan produced an unknown item." }, { status: 500 });
    }
    console.log(
      `dress replan_ms=${Date.now() - started} steps=${outcome.steps} stopped=${outcome.stopped} trace=${outcome.trace.length}`,
    );
    return NextResponse.json({
      say: outcome.say,
      state: outcome.state,
      trace: outcome.trace,
      stopped: outcome.stopped,
    });
  } catch (err) {
    // Only outage signatures become the friendly hiccup (same rule as /api/outfits).
    const status = (err as { status?: number })?.status;
    const outage =
      isTransientModel404(err) || status === 429 || (typeof status === "number" && status >= 500);
    if (outage) {
      return NextResponse.json(
        { error: META_HICCUP_MESSAGE, code: META_UNAVAILABLE_CODE },
        { status: 500 },
      );
    }
    const message = err instanceof Error ? err.message : "Replan failed.";
    console.log(`dress replan error=${JSON.stringify(message.slice(0, 200))} route_ms=${Date.now() - started}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
