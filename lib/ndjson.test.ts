import test from "node:test";
import assert from "node:assert/strict";

import { createNDJSONParser } from "./ndjson.ts";

test("parses complete lines and skips blank/invalid ones", () => {
  const events: unknown[] = [];
  const parser = createNDJSONParser((event) => events.push(event));
  parser.feed('{"event":"a"}\n\nnot json\n{"event":"b"}\n');
  assert.deepEqual(events, [{ event: "a" }, { event: "b" }]);
});

test("reassembles lines split across chunks", () => {
  const events: unknown[] = [];
  const parser = createNDJSONParser((event) => events.push(event));
  parser.feed('{"event":"cut');
  assert.deepEqual(events, []);
  parser.feed('out","id":"1"}\n{"event":"tag"');
  assert.deepEqual(events, [{ event: "cutout", id: "1" }]);
  parser.feed(', "id":"1"}\n');
  assert.deepEqual(events, [
    { event: "cutout", id: "1" },
    { event: "tag", id: "1" },
  ]);
});

test("holds a trailing partial line until it completes", () => {
  const events: unknown[] = [];
  const parser = createNDJSONParser((event) => events.push(event));
  parser.feed('{"event":"done"}');
  assert.deepEqual(events, []);
  parser.feed("\n");
  assert.deepEqual(events, [{ event: "done" }]);
});
