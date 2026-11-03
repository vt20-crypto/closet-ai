import { NextResponse } from "next/server";

import { getMetaClient } from "@/lib/meta/client";
import { createRetryBudget, withTransient404Retry } from "@/lib/meta/retry";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MODEL = "muse-spark-1.3";
const CACHE_TTL_MS = 60_000;

let cache: { at: number; model: string; latencyMs: number } | null = null;

export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json({ ok: true, model: cache.model, latencyMs: cache.latencyMs, cached: true });
  }
  const started = performance.now();
  try {
    const response = await withTransient404Retry(
      "health",
      () =>
        getMetaClient().responses.create({
          model: MODEL,
          reasoning: { effort: "low" },
          input: "Reply with the single word: ok",
        }),
      undefined,
      createRetryBudget(started + 15_000),
    );
    const latencyMs = Math.round(performance.now() - started);
    const text = response.output_text ?? "";
    if (!/^\s*ok\s*$/i.test(text)) {
      throw new Error(`Unexpected health reply: ${text.slice(0, 80)}`);
    }
    cache = { at: Date.now(), model: MODEL, latencyMs };
    return NextResponse.json({ ok: true, model: MODEL, latencyMs, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Health check failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
