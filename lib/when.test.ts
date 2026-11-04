import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeTimeOfDay, resolveDateText, todayISO, tomorrowISO } from "./when.ts";

// A Monday: 2026-11-02 is a Monday (matches repo dates).
const MONDAY = new Date(2026, 10, 2, 12, 0, 0);

describe("resolveDateText", () => {
  it("passes ISO dates through and handles today/tomorrow", () => {
    assert.equal(resolveDateText("2026-11-09", MONDAY), "2026-11-09");
    assert.equal(resolveDateText("today", MONDAY), todayISO(MONDAY));
    assert.equal(resolveDateText("tomorrow", MONDAY), tomorrowISO(MONDAY));
    assert.equal(resolveDateText(null, MONDAY), null);
    assert.equal(resolveDateText("sometime", MONDAY), null);
  });

  it("resolves weekday names to the next occurrence", () => {
    assert.equal(resolveDateText("monday", MONDAY), "2026-11-02");
    assert.equal(resolveDateText("friday", MONDAY), "2026-11-06");
    assert.equal(resolveDateText("sunday", MONDAY), "2026-11-08");
  });

  it("resolves month+day, rolling past dates to next year", () => {
    assert.equal(resolveDateText("december 25", MONDAY), "2026-12-25");
    assert.equal(resolveDateText("1st january", MONDAY), "2027-01-01");
    assert.equal(resolveDateText("february 30", MONDAY), null);
  });
});

describe("normalizeTimeOfDay", () => {
  it("maps meals and dayparts, rejects the rest", () => {
    assert.equal(normalizeTimeOfDay("dinner"), "evening");
    assert.equal(normalizeTimeOfDay("Evening"), "evening");
    assert.equal(normalizeTimeOfDay("brunch"), "morning");
    assert.equal(normalizeTimeOfDay("lunch"), "afternoon");
    assert.equal(normalizeTimeOfDay("tonight"), "evening");
    assert.equal(normalizeTimeOfDay("later"), null);
    assert.equal(normalizeTimeOfDay(null), null);
  });
});
