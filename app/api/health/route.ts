import { NextResponse } from "next/server";

import { getMetaClient } from "@/lib/meta/client";
import {
  createRetryBudget,
  isOutageError,
  META_HICCUP_MESSAGE,
  META_UNAVAILABLE_CODE,
  withModelFailover,
} from "@/lib/meta/retry";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CACHE_TTL_MS = 60_000;

let cache: { at: number; model: string; latencyMs: number } | null = null;

export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json({ ok: true, model: cache.model, latencyMs: cache.latencyMs, cached: true });
  }
  const started = performance.now();
  try {
    const { result: response, model } = await withModelFailover(
      "health",
      (model) =>
        getMetaClient().responses.create({
          model,
          reasoning: { effort: "low" },
          input: "Reply with the single word: ok",
        }),
      // Date.now-based: sleepWithinBudget compares against Date.now(), so a
      // performance.now() value here would silently disable every retry.
      createRetryBudget(Date.now() + 15_000),
    );
    const latencyMs = Math.round(performance.now() - started);
    const text = response.output_text ?? "";
    if (!/^\s*ok\s*$/i.test(text)) {
      throw new Error(`Unexpected health reply: ${text.slice(0, 80)}`);
    }
    cache = { at: Date.now(), model, latencyMs };
    return NextResponse.json({ ok: true, model, latencyMs, cached: false });
  } catch (err) {
    // Failover exhaustion (503) and other outages become the hiccup, not a raw 500.
    if (isOutageError(err)) {
      return NextResponse.json(
        { ok: false, error: META_HICCUP_MESSAGE, code: META_UNAVAILABLE_CODE },
        { status: 500 },
      );
    }
    const message = err instanceof Error ? err.message : "Health check failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
