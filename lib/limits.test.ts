import test from "node:test";
import assert from "node:assert/strict";

import {
  AVATAR_GENERATIONS_PER_WEEK,
  avatarAllowance,
  avatarLimitMessage,
  avatarWeeklyLimit,
  inAvatarWindow,
} from "./limits.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

test("fresh users get all 3 generations", () => {
  assert.deepEqual(avatarAllowance(NOW, []), { allowed: true, remaining: 3, resetAt: null });
});

test("recent generations count down the remainder", () => {
  const allowance = avatarAllowance(NOW, [NOW - DAY, NOW - 2 * DAY]);
  assert.equal(allowance.allowed, true);
  assert.equal(allowance.remaining, 1);
  assert.equal(allowance.resetAt, null);
});

test("three in-window generations block until the oldest rolls off", () => {
  const oldest = NOW - 2 * DAY;
  const allowance = avatarAllowance(NOW, [oldest, NOW - DAY, NOW - 3600_1000]);
  assert.equal(allowance.allowed, false);
  assert.equal(allowance.remaining, 0);
  assert.equal(allowance.resetAt, new Date(oldest + 7 * DAY).toISOString());
});

test("stamps older than 7 days fall out of the window", () => {
  const allowance = avatarAllowance(NOW, [NOW - 8 * DAY, NOW - 9 * DAY, NOW - 10 * DAY]);
  assert.deepEqual(allowance, { allowed: true, remaining: 3, resetAt: null });
});

test("future stamps never count", () => {
  assert.deepEqual(inAvatarWindow(NOW, [NOW + DAY, NaN, NOW - DAY]), [NOW - DAY]);
});

test("limit message names the reset date", () => {
  assert.match(
    avatarLimitMessage(new Date(NOW + 2 * DAY).toISOString()),
    /You can create a new avatar again on November 6\./,
  );
  assert.match(avatarLimitMessage(null), /all 3 avatar generations/);
});

test("weekly cap matches the Free plan", () => {
  assert.equal(AVATAR_GENERATIONS_PER_WEEK, 3);
});

test("AVATAR_WEEKLY_LIMIT overrides the default", () => {
  const prev = process.env.AVATAR_WEEKLY_LIMIT;
  try {
    delete process.env.AVATAR_WEEKLY_LIMIT;
    assert.equal(avatarWeeklyLimit(), 3);
    process.env.AVATAR_WEEKLY_LIMIT = "5";
    assert.equal(avatarWeeklyLimit(), 5);
    assert.deepEqual(avatarAllowance(NOW, [], 5), { allowed: true, remaining: 5, resetAt: null });
    assert.match(avatarLimitMessage(null, 5), /all 5 avatar generations/);
    for (const bad of ["0", "-2", "2.5", "many", ""]) {
      process.env.AVATAR_WEEKLY_LIMIT = bad;
      assert.equal(avatarWeeklyLimit(), 3, `falls back for ${JSON.stringify(bad)}`);
    }
  } finally {
    if (prev === undefined) delete process.env.AVATAR_WEEKLY_LIMIT;
    else process.env.AVATAR_WEEKLY_LIMIT = prev;
  }
});
