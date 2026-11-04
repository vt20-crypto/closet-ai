"use client";

import { useEffect, useState } from "react";

type State =
  | { status: "loading" }
  | { status: "ok"; latencyMs: number; cached: boolean }
  | { status: "error"; message: string };

export default function HealthStatus() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Rechecks bypass the 60s server cache to show the live result.
    fetch(attempt === 0 ? "/api/health" : "/api/health?fresh=1", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as {
          ok: boolean;
          model?: string;
          latencyMs?: number;
          cached?: boolean;
          error?: string;
        };
        if (cancelled) return;
        if (body.ok) {
          setState({
            status: "ok",
            latencyMs: body.latencyMs ?? 0,
            cached: body.cached ?? false,
          });
        } else {
          setState({ status: "error", message: body.error ?? `HTTP ${res.status}` });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: err instanceof Error ? err.message : "Request failed." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="status" className="text-base">
        {state.status === "loading" && "Checking your stylist…"}
        {state.status === "ok" &&
          `Your stylist is ready (${state.latencyMs} ms${state.cached ? ", cached" : ""})`}
        {state.status === "error" && `Your stylist is unreachable (${state.message})`}
      </p>
      {state.status !== "loading" && (
        <button
          type="button"
          onClick={() => {
            setState({ status: "loading" });
            setAttempt((n) => n + 1);
          }}
          className="min-h-11 rounded-full border border-(--border) bg-(--surface) px-4 text-base"
        >
          Recheck
        </button>
      )}
    </div>
  );
}
