import test from "node:test";
import assert from "node:assert/strict";

import {
  createRetryBudget,
  isModelDead,
  isOutageError,
  isTransientModel404,
  markModelDead,
  MODEL_BREAKER_MS,
  model404RetryDelayMs,
  resetModelBreaker,
  sleepForTransient404,
  sleepWithinBudget,
  SPARK_MODELS,
  withModelFailover,
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

test("failover rotates past dead ids immediately to the first live model", async () => {
  resetModelBreaker();
  const tried: string[] = [];
  const started = Date.now();
  const out = await withModelFailover("test", async (model) => {
    tried.push(model);
    if (model !== "muse-spark-1.1") throw apiError(404, "404 The requested model was not found");
    return "ok";
  });
  assert.equal(out.result, "ok");
  assert.equal(out.model, "muse-spark-1.1");
  assert.deepEqual(tried, ["muse-spark-1.3", "muse-spark-1.2", "muse-spark-1.1"]);
  // No backoff sleeps on the dead ids: two rotations happen in well under 1s.
  assert.ok(Date.now() - started < 900);
  assert.equal(isModelDead("muse-spark-1.3"), true);
  assert.equal(isModelDead("muse-spark-1.2"), true);
  assert.equal(isModelDead("muse-spark-1.1"), false);
});

test("breaker skips dead ids and releases them after 90s", async () => {
  resetModelBreaker();
  markModelDead("muse-spark-1.3");
  const tried: string[] = [];
  const out = await withModelFailover("test", async (model) => {
    tried.push(model);
    return "ok";
  });
  assert.equal(out.model, "muse-spark-1.2");
  assert.deepEqual(tried, ["muse-spark-1.2"]);
  assert.equal(isModelDead("muse-spark-1.3"), true);
  assert.equal(isModelDead("muse-spark-1.3", Date.now() + MODEL_BREAKER_MS + 1000), false);
  assert.deepEqual(SPARK_MODELS, ["muse-spark-1.3", "muse-spark-1.2", "muse-spark-1.1", "muse-wonder-1.0"]);
});

test("failover rethrows 429/5xx and non-model 404s without marking ids dead", async () => {
  for (const err of [
    apiError(429, "429 rate limited"),
    apiError(500, "500 inference failed"),
    apiError(404, "404 Not Found"),
  ]) {
    resetModelBreaker();
    let calls = 0;
    await assert.rejects(
      withModelFailover("test", async () => {
        calls += 1;
        throw err;
      }),
      (thrown: unknown) => thrown === err,
    );
    assert.equal(calls, 1);
    for (const model of SPARK_MODELS) assert.equal(isModelDead(model), false);
  }
});

test("all-breaker-dead exhaustion carries 503 for the hiccup mapping", async () => {
  resetModelBreaker();
  for (const model of SPARK_MODELS) markModelDead(model);
  let calls = 0;
  let err: unknown = null;
  try {
    await withModelFailover(
      "test",
      async () => {
        calls += 1;
        return "ok";
      },
      createRetryBudget(Date.now() - 1000),
    );
  } catch (e) {
    err = e;
  }
  assert.equal(calls, 0);
  assert.equal((err as { status?: number })?.status, 503);
  assert.equal(isOutageError(err), true);
});

test("whole-chain 404 is an outage: no marks, chain retried, 404 rethrown", async () => {
  resetModelBreaker();
  const tried: string[] = [];
  let err: unknown = null;
  try {
    await withModelFailover(
      "test",
      async (model) => {
        tried.push(model);
        throw apiError(404, "404 The requested model was not found");
      },
      // ~2.5s: first full pass, 1s sleep, second pass, then the budget gives out.
      createRetryBudget(Date.now() + 2500),
    );
  } catch (e) {
    err = e;
  }
  assert.ok(err, "outage must throw");
  // At least one full pass over the chain, starting from 1.3.
  assert.deepEqual(tried.slice(0, 4), SPARK_MODELS);
  // Outage marks nothing dead.
  for (const model of SPARK_MODELS) assert.equal(isModelDead(model), false);
  // The rethrown 404 maps to the hiccup like any model outage.
  assert.equal(isTransientModel404(err), true);
  assert.equal(isOutageError(err), true);
});

test("isOutageError maps 503/429/5xx/model-404 to the hiccup, nothing else", () => {
  const outage = (status: number, message: string) => {
    const err = new Error(message) as Error & { status?: number };
    err.status = status;
    return err;
  };
  assert.equal(isOutageError(outage(503, "no live spark model")), true);
  assert.equal(isOutageError(apiError(429, "429 rate limited")), true);
  assert.equal(isOutageError(apiError(500, "500 inference failed")), true);
  assert.equal(isOutageError(apiError(404, "404 The requested model was not found")), true);
  assert.equal(isOutageError(apiError(400, "400 bad request")), false);
  assert.equal(isOutageError(apiError(404, "404 Not Found")), false);
  assert.equal(isOutageError(null), false);
});

test("failover respects a spent budget without calling", async () => {
  resetModelBreaker();
  let calls = 0;
  await assert.rejects(
    withModelFailover(
      "test",
      async () => {
        calls += 1;
        return "ok";
      },
      createRetryBudget(Date.now() + 30_000 - 60_000),
    ),
  );
  assert.equal(calls, 0);
});
