import { applySwap, finishDress, markUnavailable, type DressState } from "./dress.ts";
import type { OutfitCategory } from "./outfits.ts";

/**
 * Pure replan agent: tool definitions, tool implementations, and the loop
 * driver. No server imports, so node:test can cover the caps and the
 * swap fallback with a fake model. `lib/meta/spark.ts` wires the real
 * Responses API caller around `runAgentLoop`.
 */

export interface ReplanCandidate {
  id: string;
  slot: OutfitCategory;
  nickname: string;
  primary_color: string;
  warmth: number;
  formality: number;
  layer: string;
}

export interface ReplanContext {
  items: ReplanCandidate[];
  weatherLine: string | null;
  state: DressState;
}

export interface AgentToolDef {
  type: "function";
  name: string;
  description: string;
  strict: true;
  parameters: Record<string, unknown>;
}

const strictObject = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export function replanToolDefinitions(): AgentToolDef[] {
  return [
    {
      type: "function",
      strict: true,
      name: "get_outfit_state",
      description: "Read the current outfit plan: steps, statuses, and unavailable items.",
      parameters: strictObject({}, []),
    },
    {
      type: "function",
      strict: true,
      name: "swap_item",
      description:
        "Swap the worn item in a slot for a same-slot candidate by id. " +
        "Pick from the candidates in context; unavailable and already-worn ids are rejected.",
      parameters: strictObject(
        {
          slot: { type: "string" },
          item_id: { type: "string" },
          reason: { type: "string" },
        },
        ["slot", "item_id", "reason"],
      ),
    },
    {
      type: "function",
      strict: true,
      name: "mark_unavailable",
      description: "Mark a closet item unavailable (laundry, lost) so it is never suggested.",
      parameters: strictObject({ item_id: { type: "string" } }, ["item_id"]),
    },
    {
      type: "function",
      strict: true,
      name: "finish",
      description: "End the session: the outfit is complete as it stands.",
      parameters: strictObject({}, []),
    },
  ];
}

export interface ReplanToolResult {
  /** New context (state/unavailable updates). */
  context: ReplanContext;
  /** Machine-readable result fed back to the model. */
  result: string;
  /** Plain-language trace line for the "How I decided" disclosure. No images. */
  trace: string;
}

function candidateLine(c: ReplanCandidate): string {
  return `${c.id} ("${c.nickname}", ${c.primary_color}, warmth ${c.warmth}/5, formality ${c.formality}/5, ${c.layer})`;
}

/** Candidates the model may pick, as context text (ids included). */
export function candidateContext(context: ReplanContext): string {
  const bySlot = new Map<string, ReplanCandidate[]>();
  for (const item of context.items) {
    const list = bySlot.get(item.slot) ?? [];
    list.push(item);
    bySlot.set(item.slot, list);
  }
  const lines: string[] = [];
  for (const [slot, list] of bySlot) {
    lines.push(`${slot}: ${list.map(candidateLine).join("; ")}`);
  }
  if (context.weatherLine) lines.push(`Weather: ${context.weatherLine}.`);
  return lines.join("\n");
}

function wornInSlot(context: ReplanContext, slot: string): string | null {
  const byId = new Map(context.items.map((item) => [item.id, item]));
  for (const step of context.state.steps) {
    if (byId.get(step.itemId)?.slot === slot) return step.itemId;
  }
  return null;
}

function deterministicPick(context: ReplanContext, slot: string): ReplanCandidate | null {
  const worn = new Set(context.state.steps.map((step) => step.itemId));
  const unavailable = new Set(context.state.unavailableIds);
  const options = context.items
    .filter((item) => item.slot === slot && !worn.has(item.id) && !unavailable.has(item.id))
    .sort((a, b) => a.nickname.localeCompare(b.nickname) || a.id.localeCompare(b.id));
  return options[0] ?? null;
}

export function runReplanTool(
  context: ReplanContext,
  name: string,
  args: Record<string, unknown>,
): ReplanToolResult {
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  if (name === "get_outfit_state") {
    const summary = context.state.steps
      .map((step, i) => `${i === context.state.index ? ">" : " "}${step.itemId}:${step.status}`)
      .join(" ");
    return {
      context,
      result: `steps ${summary}; unavailable: ${context.state.unavailableIds.join(",") || "none"}`,
      trace: "Checked the outfit plan.",
    };
  }
  if (name === "mark_unavailable") {
    const itemId = str(args.item_id);
    const item = context.items.find((c) => c.id === itemId);
    if (!item) {
      return { context, result: `error: unknown item id "${itemId}"`, trace: `Ignored an unknown item ("${itemId}").` };
    }
    return {
      context: { ...context, state: markUnavailable(context.state, itemId) },
      result: `ok: "${item.nickname}" marked unavailable`,
      trace: `Marked "${item.nickname}" unavailable.`,
    };
  }
  if (name === "swap_item") {
    const slot = str(args.slot);
    const itemId = str(args.item_id);
    const reason = str(args.reason) || "no reason given";
    const picked = context.items.find((c) => c.id === itemId);
    const worn = new Set(context.state.steps.map((step) => step.itemId));
    const invalid =
      !picked ||
      picked.slot !== slot ||
      context.state.unavailableIds.includes(itemId) ||
      worn.has(itemId);
    const oldId = wornInSlot(context, slot);
    if (!invalid && oldId) {
      return {
        context: { ...context, state: applySwap(context.state, oldId, itemId) },
        result: `ok: swapped "${oldId}" for "${picked.nickname}" (${reason})`,
        trace: `Swapped in "${picked.nickname}" — ${reason}.`,
      };
    }
    const fallback = deterministicPick(context, slot);
    if (!fallback || !oldId) {
      return {
        context,
        result: `error: no valid swap for slot "${slot}"`,
        trace: `Could not find a swap for the ${slot || "unknown slot"}.`,
      };
    }
    return {
      context: { ...context, state: applySwap(context.state, oldId, fallback.id) },
      result:
        `invalid item_id "${itemId}"; fell back to "${fallback.nickname}" ` +
        `(${fallback.id}) for slot "${slot}"`,
      trace:
        `The suggested swap was not valid, so I picked "${fallback.nickname}" instead — ${reason}.`,
    };
  }
  if (name === "finish") {
    return {
      context: { ...context, state: finishDress(context.state) },
      result: "ok: finished",
      trace: "Wrapped up the outfit.",
    };
  }
  return { context, result: `error: unknown tool "${name}"`, trace: `Ignored an unknown request ("${name}").` };
}

// --- Loop driver (model calls injected) ---

export interface AgentToolCall {
  name: string;
  args: Record<string, unknown>;
  callId: string;
}

export type AgentTurn =
  | { kind: "text"; text: string }
  | { kind: "tools"; calls: AgentToolCall[] };

export interface AgentTraceEntry {
  tool: string;
  detail: string;
}

export interface AgentOutcome {
  say: string;
  context: ReplanContext;
  trace: AgentTraceEntry[];
  steps: number;
  stopped: "done" | "cap" | "repeat";
}

export const AGENT_FALLBACK_SAY =
  "Let's keep this simple — say skip to move on, or tap to check this item.";

export async function runAgentLoop(opts: {
  initialContext: ReplanContext;
  firstTurn: () => Promise<AgentTurn>;
  nextTurn: (outputs: Array<{ callId: string; output: string }>) => Promise<AgentTurn>;
  onTool: (name: string, args: Record<string, unknown>) => Promise<ReplanToolResult>;
  maxSteps?: number;
}): Promise<AgentOutcome> {
  const maxSteps = opts.maxSteps ?? 5;
  const trace: AgentTraceEntry[] = [];
  let context: ReplanContext = opts.initialContext;
  const seen = new Map<string, number>();
  let turn = await opts.firstTurn();
  for (let step = 1; step <= maxSteps; step += 1) {
    if (turn.kind === "text") {
      return { say: turn.text, context, trace, steps: step, stopped: "done" };
    }
    const outputs: Array<{ callId: string; output: string }> = [];
    for (const call of turn.calls) {
      const key = `${call.name}:${JSON.stringify(call.args)}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count >= 3) {
        trace.push({ tool: call.name, detail: "Stopped: same request repeated 3 times." });
        return { say: AGENT_FALLBACK_SAY, context, trace, steps: step, stopped: "repeat" };
      }
      const applied = await opts.onTool(call.name, call.args);
      context = applied.context;
      trace.push({ tool: call.name, detail: applied.trace });
      outputs.push({ callId: call.callId, output: applied.result });
    }
    if (step >= maxSteps) break;
    turn = await opts.nextTurn(outputs);
  }
  return { say: AGENT_FALLBACK_SAY, context, trace, steps: maxSteps, stopped: "cap" };
}
