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
/** User-facing line for stylist outages. Never include raw API error text. */
export const META_HICCUP_MESSAGE = "Your stylist is taking a breather. Try again in a minute.";

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
  // The deadline is compared against Date.now(). A performance.now() value
  // is ~1.7 trillion ms in the past and would silently disable every retry
  // (this exact bug shipped in /api/outfits, /api/segment and /api/health).
  if (!Number.isFinite(deadlineMs) || deadlineMs < 1_000_000_000_000) {
    throw new Error(
      `createRetryBudget needs a Date.now()-based deadline, got ${deadlineMs}. ` +
        `performance.now() timestamps are in the past and disable all retries.`,
    );
  }
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
    `meta transient_model_404 context=${context} retry=${retryIndex + 1}/${MODEL_404_RETRY_DELAYS_MS.length} ` +
      `status=${status} message=${JSON.stringify(message)} request_id=${requestId}`,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spark model failover chain (each id verified live with strict json_schema,
 * input_image, and function tools). On a 404 whose message mentions the
 * model, that id is dead: move to the next id immediately with NO backoff
 * and mark it dead for 90s (in-memory circuit breaker). 429/5xx are
 * untouched by this rule — callers keep their own backoff on the same id.
 */
export const SPARK_MODELS = ["muse-spark-1.3", "muse-spark-1.2", "muse-spark-1.1", "muse-wonder-1.0"];
export const MODEL_BREAKER_MS = 90_000;

const modelDeadUntil = new Map<string, number>();

/** Test seam: clear all breaker marks. */
export function resetModelBreaker(): void {
  modelDeadUntil.clear();
}

export function isModelDead(model: string, now: number = Date.now()): boolean {
  const until = modelDeadUntil.get(model);
  if (until === undefined) return false;
  if (now >= until) {
    modelDeadUntil.delete(model);
    return false;
  }
  return true;
}

export function markModelDead(model: string, now: number = Date.now()): void {
  modelDeadUntil.set(model, now + MODEL_BREAKER_MS);
}

/**
 * Outage signatures that map to the friendly hiccup (never raw 500s): model
 * 404s, 429, and 5xx — including 503 from failover exhaustion below.
 */
export function isOutageError(err: unknown): boolean {
  if (isTransientModel404(err)) return true;
  const status = (err as { status?: number })?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

/** Exhaustion error carrying a 503 so routes map it to the hiccup. */
function failoverExhausted(): unknown {
  const err = new Error("no live spark model (all ids breaker-dead or outage)");
  (err as { status?: number }).status = 503;
  return err;
}

/**
 * Run fn against the failover chain, skipping breaker-dead ids. Returns the
 * result with the id that answered (log it as model_used). A 404-model
 * rotates immediately with no backoff; anything else — 429/5xx included —
 * rethrows to the caller. Strict-JSON replies may carry whitespace;
 * JSON.parse handles that normally.
 *
 * Breaker rule: ids that 404 within one call are marked dead ONLY when
 * another id in the same call answers. If every live id 404s, that is an
 * outage, not dead models — nothing is marked and the chain retries from
 * the first id with 1s/2s/4s backoff inside the budget.
 */
export async function withModelFailover<T>(
  context: string,
  fn: (model: string) => Promise<T>,
  budget?: RetryBudget,
  now: () => number = Date.now,
): Promise<{ result: T; model: string }> {
  const OUTAGE_BACKOFFS_MS = [1000, 2000, 4000];
  let outageRounds = 0;
  let lastErr: unknown = null;
  for (;;) {
    if (budget && now() > budget.deadline) throw lastErr ?? failoverExhausted();
    const live = SPARK_MODELS.filter((m) => !isModelDead(m, now()));
    if (live.length === 0) {
      // Every id is breaker-dead from earlier calls: wait for one to release.
      if (outageRounds >= OUTAGE_BACKOFFS_MS.length) throw failoverExhausted();
      const delay = OUTAGE_BACKOFFS_MS[outageRounds];
      outageRounds += 1;
      console.log(`${context} all ids breaker-dead, retrying in ${delay}ms`);
      if (budget && !(await sleepWithinBudget(delay, budget))) throw failoverExhausted();
      if (!budget) await sleep(delay);
      continue;
    }
    const failed404: string[] = [];
    for (const model of live) {
      try {
        const result = await fn(model);
        for (const dead of failed404) {
          markModelDead(dead, now());
          console.log(`${context} model_dead=${dead} (sibling ${model} answered)`);
        }
        console.log(`${context} model_used=${model}`);
        return { result, model };
      } catch (err) {
        if (isTransientModel404(err)) {
          failed404.push(model);
          lastErr = err;
          continue; // no backoff on the dead id
        }
        throw err;
      }
    }
    // The whole pass 404'd: outage, not dead models — retry the chain.
    if (outageRounds >= OUTAGE_BACKOFFS_MS.length) throw lastErr ?? failoverExhausted();
    const delay = OUTAGE_BACKOFFS_MS[outageRounds];
    outageRounds += 1;
    console.log(`${context} all live ids 404'd (outage), retrying chain in ${delay}ms`);
    if (budget && !(await sleepWithinBudget(delay, budget))) throw lastErr ?? failoverExhausted();
    if (!budget) await sleep(delay);
  }
}

/** Persistent per-call 404 counter shared by every Meta call path. */
export interface ModelRetryCounters {
  retries404: number;
}

/**
 * The one transient-404 branch every Meta call path uses (outfits/health via
 * withTransient404Retry, SAM nouns, Spark tags, voice ASR). On a 404 whose
 * message mentions the model: log, sleep 1s/2s/4s/8s inside the shared
 * budget, and return true so the caller retries. Anything else — a
 * different error, exhausted retries, or a spent budget — returns false so
 * the caller fails now. Never sleeps past the budget deadline.
 */
export async function sleepForTransient404(opts: {
  context: string;
  err: unknown;
  counters: ModelRetryCounters;
  budget?: RetryBudget;
  maxRetries?: number;
  delaysMs?: readonly number[];
}): Promise<boolean> {
  const max = opts.maxRetries ?? (opts.delaysMs ?? MODEL_404_RETRY_DELAYS_MS).length;
  if (!isTransientModel404(opts.err) || opts.counters.retries404 >= max) return false;
  logModel404Retry(opts.context, opts.counters.retries404, opts.err);
  const delays = opts.delaysMs ?? MODEL_404_RETRY_DELAYS_MS;
  const delay = delays[Math.min(opts.counters.retries404, delays.length - 1)] ?? 8000;
  if (opts.budget && !(await sleepWithinBudget(delay, opts.budget))) return false;
  if (!opts.budget) await sleep(delay);
  opts.counters.retries404 += 1;
  return true;
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
  const counters: ModelRetryCounters = { retries404: 0 };
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!(await sleepForTransient404({ context, err, counters, budget, delaysMs }))) throw err;
    }
  }
}
