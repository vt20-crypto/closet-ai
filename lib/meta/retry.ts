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

export const MODEL_404_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

/** Machine-readable code for Meta-caused failures (UI shows friendly text). */
export const META_UNAVAILABLE_CODE = "meta_unavailable";
/** User-facing line for Meta outages. Never include raw API error text. */
export const META_HICCUP_MESSAGE = "Meta's AI is having a hiccup.";

/** True for errors raised by the Meta Model API (numeric SDK status). */
export function isMetaApiError(err: unknown): boolean {
  return typeof (err as { status?: unknown })?.status === "number";
}

/**
 * A shared retry deadline. One budget per scan/request: every retrying call
 * draws from the same clock so retries can't multiply (14 nouns × 4 sleeps).
 */
export interface RetryBudget {
  deadline: number;
}

export function createRetryBudget(deadlineMs: number): RetryBudget {
  return { deadline: deadlineMs };
}

/**
 * Sleep up to ms without passing the budget deadline. Returns false when the
 * budget is already spent (caller must give up, not retry).
 */
export async function sleepWithinBudget(ms: number, budget: RetryBudget): Promise<boolean> {
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) return false;
  await sleep(Math.min(ms, remaining));
  return Date.now() < budget.deadline;
}

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
 * Run fn, retrying transient model-404s (1s, 2s, 4s, 8s by default).
 * A shared budget caps total retry sleeping; when it is spent the error is
 * rethrown. Any other error — or exhaustion — is rethrown to the caller.
 */
export async function withTransient404Retry<T>(
  context: string,
  fn: () => Promise<T>,
  delaysMs: readonly number[] = MODEL_404_RETRY_DELAYS_MS,
  budget?: RetryBudget,
): Promise<T> {
  let retries = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientModel404(err) || retries >= delaysMs.length) throw err;
      logModel404Retry(context, retries, err);
      const delay = delaysMs[Math.min(retries, delaysMs.length - 1)] ?? 8000;
      if (budget && !(await sleepWithinBudget(delay, budget))) throw err;
      if (!budget) await sleep(delay);
      retries += 1;
    }
  }
}
