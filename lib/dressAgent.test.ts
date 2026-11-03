import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createDressState } from "./dress.ts";
import {
  AGENT_FALLBACK_SAY,
  runAgentLoop,
  runReplanTool,
  type AgentTurn,
  type ReplanCandidate,
  type ReplanContext,
} from "./dressAgent.ts";

function candidate(
  id: string,
  slot: ReplanCandidate["slot"],
  nickname: string,
  layer = "base",
): ReplanCandidate {
  return { id, slot, nickname, primary_color: "blue", warmth: 3, formality: 3, layer };
}

function context(): ReplanContext {
  return {
    items: [
      candidate("tee", "top", "Tee"),
      candidate("oxford", "top", "Oxford", "mid"),
      candidate("flannel", "top", "Flannel"),
      candidate("jeans", "bottom", "Jeans"),
      candidate("sneakers", "shoes", "Sneakers"),
    ],
    weatherLine: null,
    state: createDressState(["tee", "jeans", "sneakers"]),
  };
}

const textTurn = (text: string): AgentTurn => ({ kind: "text", text });

describe("runAgentLoop", () => {
  it("returns model text immediately when no tools are called", async () => {
    const outcome = await runAgentLoop({
      initialContext: context(),
      firstTurn: async () => textTurn("Put on your tee."),
      nextTurn: async () => textTurn("unreachable"),
      onTool: async () => {
        throw new Error("no tools expected");
      },
    });
    assert.equal(outcome.say, "Put on your tee.");
    assert.equal(outcome.stopped, "done");
    assert.deepEqual(outcome.trace, []);
  });

  it("swaps the model-picked valid replacement", async () => {
    let ctx = context();
    const outcome = await runAgentLoop({
      initialContext: ctx,
      firstTurn: async () => ({
        kind: "tools",
        calls: [
          {
            name: "swap_item",
            args: { slot: "top", item_id: "oxford", reason: "it is chilly" },
            callId: "c1",
          },
        ],
      }),
      nextTurn: async () => textTurn("Wear the Oxford instead — it is chilly."),
      onTool: async (name, args) => {
        const applied = runReplanTool(ctx, name, args);
        ctx = applied.context;
        return applied;
      },
    });
    assert.equal(outcome.say, "Wear the Oxford instead — it is chilly.");
    assert.deepEqual(
      outcome.context.state.steps.map((s) => s.itemId),
      ["oxford", "jeans", "sneakers"],
    );
    assert.match(outcome.trace[0].detail, /Oxford/);
  });

  it("falls back to the deterministic pick on an invalid item_id", async () => {
    let ctx = context();
    const outcome = await runAgentLoop({
      initialContext: ctx,
      firstTurn: async () => ({
        kind: "tools",
        calls: [
          { name: "swap_item", args: { slot: "top", item_id: "zzz", reason: "stained" }, callId: "c1" },
        ],
      }),
      nextTurn: async () => textTurn("Wear the Flannel instead."),
      onTool: async (name, args) => {
        const applied = runReplanTool(ctx, name, args);
        ctx = applied.context;
        return applied;
      },
    });
    // Flannel < Oxford alphabetically: the deterministic first valid pick.
    assert.deepEqual(
      outcome.context.state.steps.map((s) => s.itemId),
      ["flannel", "jeans", "sneakers"],
    );
    assert.match(outcome.trace[0].detail, /not valid/);
  });

  it("stops when the same tool call repeats 3 times", async () => {
    let ctx = context();
    const sameCall = async (): Promise<AgentTurn> => ({
      kind: "tools",
      calls: [{ name: "mark_unavailable", args: { item_id: "tee" }, callId: "c1" }],
    });
    const outcome = await runAgentLoop({
      initialContext: ctx,
      firstTurn: sameCall,
      nextTurn: sameCall,
      onTool: async (name, args) => {
        const applied = runReplanTool(ctx, name, args);
        ctx = applied.context;
        return applied;
      },
    });
    assert.equal(outcome.stopped, "repeat");
    assert.equal(outcome.say, AGENT_FALLBACK_SAY);
    assert.match(outcome.trace[outcome.trace.length - 1].detail, /repeated 3 times/);
  });

  it("caps the loop at maxSteps", async () => {
    let n = 0;
    const distinctCall = async (): Promise<AgentTurn> => {
      n += 1;
      return {
        kind: "tools",
        calls: [{ name: "mark_unavailable", args: { item_id: `ghost-${n}` }, callId: `c${n}` }],
      };
    };
    let ctx = context();
    const outcome = await runAgentLoop({
      initialContext: ctx,
      firstTurn: distinctCall,
      nextTurn: distinctCall,
      onTool: async (name, args) => {
        const applied = runReplanTool(ctx, name, args);
        ctx = applied.context;
        return applied;
      },
      maxSteps: 3,
    });
    assert.equal(outcome.stopped, "cap");
    assert.equal(outcome.steps, 3);
    assert.equal(outcome.say, AGENT_FALLBACK_SAY);
  });

  it("rejects swaps into unavailable or already-worn ids", () => {
    let ctx = context();
    ctx = { ...ctx, state: { ...ctx.state, unavailableIds: ["oxford"] } };
    const worn = runReplanTool(ctx, "swap_item", { slot: "top", item_id: "tee", reason: "x" });
    assert.match(worn.result, /fell back/);
    assert.equal(worn.context.state.steps[0].itemId, "flannel");
    const missing = runReplanTool(ctx, "mark_unavailable", { item_id: "ghost" });
    assert.match(missing.result, /unknown item id/);
  });
});
