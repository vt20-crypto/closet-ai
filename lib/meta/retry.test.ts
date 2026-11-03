import test from "node:test";
import assert from "node:assert/strict";

import {
  createRetryBudget,
  isTransientModel404,
  model404RetryDelayMs,
  sleepForTransient404,
  sleepWithinBudget,
  withTransient404Retry,
  type ModelRetryCounters,
} from "./retry.ts";

function apiError(status: number, message: string): Error {
  const err = new Error(message);
  (err as { status?: number }).status = status;
  return err;
}

test("404 mentioning the model is transient", () => {
  assert.equal(
    isTransientModel404(apiError(404, "404 The requested model was not found")),
    true,
  );
  assert.equal(isTransientModel404(apiError(404, "Model 'x' does not exist")), true);
});

test("404 about anything else is final", () => {
  assert.equal(isTransientModel404(apiError(404, "Not Found")), false);
  assert.equal(isTransientModel404(apiError(404, "404 blob not found")), false);
  assert.equal(isTransientModel404(new Error("no status at all")), false);
  assert.equal(isTransientModel404(null), false);
});

test("429 and 5xx are untouched by this rule", () => {
  assert.equal(isTransientModel404(apiError(429, "429 rate limited model busy")), false);
  assert.equal(isTransientModel404(apiError(500, "500 model inference failed")), false);
  assert.equal(isTransientModel404(apiError(400, "400 model bad request")), false);
});

test("retry delays are 1s, 2s, 4s, 8s", () => {
  assert.deepEqual(
    [
      model404RetryDelayMs(0),
      model404RetryDelayMs(1),
      model404RetryDelayMs(2),
      model404RetryDelayMs(3),
    ],
    [1000, 2000, 4000, 8000],
  );
});

test("withTransient404Retry retries model-404s then succeeds", async () => {
  let calls = 0;
  const result = await withTransient404Retry(
    "test",
    async () => {
      calls += 1;
      if (calls < 3) throw apiError(404, "404 The requested model was not found");
      return "ok";
    },
    [1, 1, 1],
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withTransient404Retry rethrows other errors immediately", async () => {
  let calls = 0;
  await assert.rejects(
    withTransient404Retry("test", async () => {
      calls += 1;
      throw apiError(404, "404 blob not found");
    }),
    /blob not found/,
  );
  assert.equal(calls, 1);
});

test("withTransient404Retry gives up after 4 retries", async () => {
  let calls = 0;
  await assert.rejects(
    withTransient404Retry(
      "test",
      async () => {
        calls += 1;
        throw apiError(404, "404 The requested model was not found");
      },
      [1, 1, 1, 1],
    ),
    /not found/,
  );
  assert.equal(calls, 5);
});

test("a spent budget stops retries immediately", async () => {
  let calls = 0;
  // Literal past deadline: the constructor itself rejects these now.
  const budget = { deadline: Date.now() - 1 };
  await assert.rejects(
    withTransient404Retry(
      "test",
      async () => {
        calls += 1;
        throw apiError(404, "404 The requested model was not found");
      },
      [1, 1, 1, 1],
      budget,
    ),
    /not found/,
  );
  assert.equal(calls, 1);
});

test("sleepWithinBudget respects the deadline", async () => {
  assert.equal(await sleepWithinBudget(50, { deadline: Date.now() - 1 }), false);
  assert.equal(await sleepWithinBudget(5, createRetryBudget(Date.now() + 5000)), true);
});

function transient404(): Error {
  return apiError(404, "404 The requested model was not found");
}

test("createRetryBudget rejects monotonic-clock deadlines", () => {
  assert.throws(() => createRetryBudget(performance.now()), /Date.now/);
  assert.throws(() => createRetryBudget(NaN), /Date.now/);
  assert.doesNotThrow(() => createRetryBudget(Date.now() + 25_000));
});

test("a 404-model twice then succeeds on attempt 3 after waiting", async () => {
  let calls = 0;
  const started = Date.now();
  const result = await withTransient404Retry(
    "test",
    async () => {
      calls += 1;
      if (calls < 3) throw transient404();
      return "ok";
    },
    undefined,
    createRetryBudget(Date.now() + 30_000),
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  // Default backoff is 1s + 2s: the waits must actually run.
  assert.ok(Date.now() - started >= 2900, `elapsed ${Date.now() - started}ms`);
});

test("a performance.now()-era budget fails fast with one attempt (prod bug)", async () => {
  // This is exactly what shipped: a performance.now()-based deadline sits
  // ~1.7 trillion ms in the past, so no backoff sleep ever runs.
  let calls = 0;
  const started = Date.now();
  await assert.rejects(
    withTransient404Retry(
      "test",
      async () => {
        calls += 1;
        throw transient404();
      },
      undefined,
      // Literal stale deadline: the constructor itself rejects these now.
      { deadline: performance.now() },
    ),
    /not found/,
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 500, `elapsed ${Date.now() - started}ms`);
});

test("shared branch retries for every call path config", async () => {
  // SAM nouns, Spark tags, voice ASR and the outfits/health wrapper all run
  // this exact branch; only the log context differs.
  for (const context of ["spark outfits", "sam noun=shirt", "spark tag", "transcribe"]) {
    let calls = 0;
    const counters: ModelRetryCounters = { retries404: 0 };
    const budget = createRetryBudget(Date.now() + 30_000);
    let result = "fail";
    for (;;) {
      try {
        calls += 1;
        if (calls < 3) throw transient404();
        result = "ok";
        break;
      } catch (err) {
        if (!(await sleepForTransient404({ context, err, counters, budget, delaysMs: [10, 20] }))) {
          break;
        }
      }
    }
    assert.equal(result, "ok", context);
    assert.equal(calls, 3, context);
  }
});

test("shared branch returns false for non-transient errors without sleeping", async () => {
  const started = Date.now();
  const counters: ModelRetryCounters = { retries404: 0 };
  assert.equal(
    await sleepForTransient404({
      context: "test",
      err: apiError(500, "500 inference failed"),
      counters,
      budget: createRetryBudget(Date.now() + 30_000),
    }),
    false,
  );
  assert.equal(counters.retries404, 0);
  assert.ok(Date.now() - started < 200);
});
