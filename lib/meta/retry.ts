/**
 * Shared transient-error rule for Meta Model API calls (used by sam.ts,
 * spark.ts, and /api/health).
 *
 * Production symptom: from Vercel, calls intermittently fail fast (70-350ms)
 * with 404 "model not found" while the same key works from a laptop and again
 * minutes later — a routing/warm-up flake, not a bad key. So a 404 whose
 * message mentions the model is treated as transient and retried; any other
 * 404 (bad path, missing resource) is final. 429/5xx keep their own backoff
 * paths and are untouched by this rule.
 */

export const MODEL_404_RETRY_DELAYS_MS = [500, 1000, 2000];

/** True only for 404s whose message mentions the model. */
export function isTransientModel404(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 404) return false;
  const message = err instanceof Error ? err.message : "";
  return /model/i.test(message);
}

export function model404RetryDelayMs(retryIndex: number): number {
  return MODEL_404_RETRY_DELAYS_MS[Math.min(retryIndex, MODEL_404_RETRY_DELAYS_MS.length - 1)] ?? 2000;
}

function getHeader(err: unknown, name: string): string | null {
  const raw = (err as { headers?: unknown })?.headers;
  if (!raw) return null;
  if (typeof (raw as Headers).get === "function") {
    try {
      return (raw as Headers).get(name);
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    const value = rec[name] ?? rec[name.toLowerCase()];
    return typeof value === "string" ? value : null;
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One log line per transient-404 retry: status, message, request id. Never keys or images. */
export function logModel404Retry(context: string, retryIndex: number, err: unknown): void {
  const status = (err as { status?: number })?.status ?? "?";
  const message = errorMessage(err).slice(0, 200).replace(/\s+/g, " ");
  const requestId = getHeader(err, "x-request-id") ?? "-";
  console.log(
    `meta transient_model_404 context=${context} retry=${retryIndex + 1}/3 ` +
      `status=${status} message=${JSON.stringify(message)} request_id=${requestId}`,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run fn, retrying transient model-404s up to 3 times (500ms, 1s, 2s).
 * Any other error — or exhaustion — is rethrown to the caller's own handling.
 */
export async function withTransient404Retry<T>(
  context: string,
  fn: () => Promise<T>,
  delaysMs: readonly number[] = MODEL_404_RETRY_DELAYS_MS,
): Promise<T> {
  let retries = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientModel404(err) || retries >= delaysMs.length) throw err;
      logModel404Retry(context, retries, err);
      await sleep(delaysMs[Math.min(retries, delaysMs.length - 1)] ?? 2000);
      retries += 1;
    }
  }
}
