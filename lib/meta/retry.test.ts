import test from "node:test";
import assert from "node:assert/strict";

import {
  isTransientModel404,
  model404RetryDelayMs,
  withTransient404Retry,
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

test("retry delays are 500ms, 1s, 2s", () => {
  assert.deepEqual(
    [model404RetryDelayMs(0), model404RetryDelayMs(1), model404RetryDelayMs(2)],
    [500, 1000, 2000],
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

test("withTransient404Retry gives up after 3 retries", async () => {
  let calls = 0;
  await assert.rejects(
    withTransient404Retry(
      "test",
      async () => {
        calls += 1;
        throw apiError(404, "404 The requested model was not found");
      },
      [1, 1, 1],
    ),
    /not found/,
  );
  assert.equal(calls, 4);
});
