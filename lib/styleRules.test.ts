import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  failsFormality,
  failsShoes,
  failsWeather,
  generateCandidates,
  isBoldPattern,
  OCCASION_RANGES,
  pairAdjustments,
  resolveOccasion,
  ruleReason,
  scoreClimate,
  scoreColor,
  scoreFeedback,
  scoreModesty,
  scoreMood,
  scorePattern,
  scoreProportion,
  scoreRotation,
  scoreUndertone,
  warmthSum,
  type RuleItem,
  type StyleContext,
} from "./styleRules.ts";

function item(partial: Partial<RuleItem> & { id: string }): RuleItem {
  return {
    type: "t-shirt",
    primary_color: "white",
    secondary_colors: [],
    formality: 3,
    warmth: 2,
    layer: "base",
    fabric_weight: "cotton",
    pattern: "solid",
    nickname: "",
    distinguishing_note: "",
    ...partial,
  };
}

function ctx(partial?: Partial<StyleContext>): StyleContext {
  return {
    items: [],
    weather: { highC: 20, lowC: 14, precipPct: 0, humidityPct: 40 },
    occasion: "casual",
    mood: null,
    profile: {},
    pairScores: {},
    wearDays: {},
    seed: "test-seed",
    ...partial,
  };
}

describe("resolveOccasion", () => {
  it("maps chips and lets free-text keywords win", () => {
    assert.equal(resolveOccasion("work", null), "office");
    assert.equal(resolveOccasion("gym", null), "gym");
    assert.equal(resolveOccasion("dinner", null), "casual-date");
    assert.equal(resolveOccasion("work", "job interview downtown"), "interview");
    assert.equal(resolveOccasion(null, "beach wedding"), "wedding");
    assert.equal(resolveOccasion(null, null), "casual");
  });
});

describe("failsWeather", () => {
  const tee = () => item({ id: "t", type: "t-shirt", warmth: 2 });
  const jeans = () => item({ id: "j", type: "jeans", warmth: 3 });
  it("excludes shoes from the warmth sum", () => {
    const boots = item({ id: "b", type: "boots", warmth: 5 });
    assert.equal(warmthSum([tee(), jeans(), boots]), 5);
  });
  it("rejects only 3+ outside the band", () => {
    const mild = ctx();
    assert.equal(failsWeather([tee(), jeans()], mild.weather), null);
    // Sum 5 at high 20 (band 5-9): inside.
    // Sum 2: distance 3 -> reject.
    assert.ok(failsWeather([item({ id: "t", type: "tank", warmth: 2 })], mild.weather));
    // Sum 12: distance 3 -> reject.
    const heavy = [item({ id: "t", type: "sweater", warmth: 6 }), item({ id: "j", type: "jeans", warmth: 6 })];
    assert.ok(failsWeather(heavy, mild.weather));
  });
  it("rejects heavy coats in heat and demands outer in cold or rain", () => {
    const hot = ctx({ weather: { highC: 30, lowC: 24, precipPct: 0, humidityPct: 40 } });
    const coat = item({ id: "c", type: "coat", layer: "outer", warmth: 5 });
    const light = [item({ id: "t", type: "t-shirt", warmth: 1 }), item({ id: "s", type: "shorts", warmth: 1 })];
    assert.ok(failsWeather([...light, coat], hot.weather));
    const cold = ctx({ weather: { highC: 8, lowC: 2, precipPct: 0, humidityPct: 50 } });
    assert.ok(failsWeather([tee(), jeans()], cold.weather));
    assert.equal(failsWeather([tee(), jeans(), coat], cold.weather), null);
  });
  it("rejects known rain-risk shoes only when the material is known", () => {
    const rain = ctx({ weather: { highC: 18, lowC: 14, precipPct: 80, humidityPct: 70 } });
    const shell = item({ id: "o", type: "raincoat", layer: "outer", warmth: 2 });
    const suede = item({ id: "s", type: "shoes", primary_color: "brown", nickname: "Suede Walkers" });
    const plain = item({ id: "p", type: "sneakers", primary_color: "white" });
    assert.ok(failsWeather([tee(), jeans(), shell, suede], rain.weather));
    assert.equal(failsWeather([tee(), jeans(), shell, plain], rain.weather), null);
  });
});

describe("failsFormality and failsShoes", () => {
  it("rejects spread over 2 and items 2+ outside the range", () => {
    const range = OCCASION_RANGES.office;
    const ok = [item({ id: "a", formality: 3 }), item({ id: "b", formality: 4 })];
    assert.equal(failsFormality(ok, range), null);
    assert.ok(failsFormality([item({ id: "a", formality: 1 }), item({ id: "b", formality: 4 })], range));
    assert.ok(failsFormality([item({ id: "a", formality: 1 }), item({ id: "b", formality: 2 })], range));
  });
  it("rejects clashing shoes and sneakers at dressy occasions", () => {
    const outfit = [item({ id: "t", formality: 2 }), item({ id: "j", formality: 2 })];
    const heels = item({ id: "h", type: "heels", formality: 5 });
    assert.ok(failsShoes([...outfit, heels], 3));
    const sneakers = item({ id: "s", type: "sneakers", formality: 3 });
    assert.equal(failsShoes([...outfit, sneakers], 3), null);
    assert.ok(failsShoes([...outfit, sneakers], 4));
  });
});

describe("scoreColor", () => {
  const white = () => item({ id: `w${Math.random()}`, primary_color: "white" });
  const navy = (id: string) => item({ id, primary_color: "navy" });
  it("tones and analogous hues score clean, clashes lose", () => {
    assert.equal(scoreColor([white(), navy("n")], "casual"), 1);
    const red = item({ id: "r", primary_color: "red" });
    const orange = item({ id: "o", primary_color: "orange" });
    assert.equal(scoreColor([white(), red, orange], "casual"), 1);
    const green = item({ id: "g", primary_color: "green" });
    assert.ok(scoreColor([white(), red, green], "casual") < 1);
    const purple = item({ id: "p", primary_color: "purple" });
    assert.equal(scoreColor([white(), red, green, purple], "casual"), 0.2);
  });
  it("rewards office restraint and one social accent", () => {
    const navyTee = navy("n");
    assert.ok(scoreColor([white(), navyTee], "office") >= 1);
    const red = item({ id: "r", primary_color: "red" });
    const neutral = [white(), navy("m"), item({ id: "j", primary_color: "black" })];
    assert.ok(scoreColor([...neutral, red], "party") >= scoreColor([...neutral, red], "casual"));
  });
});

describe("scoreProportion", () => {
  it("rewards loose-over-slim and cropped-over-high-rise, stays neutral when blind", () => {
    const loose = item({ id: "t", fit: "oversized", length: "regular" });
    const slim = item({ id: "j", type: "jeans", fit: "slim" });
    assert.equal(scoreProportion([loose, slim], null), 1);
    const cropped = item({ id: "c", type: "t-shirt", fit: "boxy", length: "cropped" });
    const high = item({ id: "h", type: "jeans", fit: "straight", rise: "high" });
    assert.equal(scoreProportion([cropped, high], null), 1);
    const blind = [item({ id: "t" }), item({ id: "j", type: "jeans" })];
    assert.equal(scoreProportion(blind, null), 0.5);
  });
  it("penalises oversized pairs unless the style is relaxed", () => {
    const pair = [
      item({ id: "t", fit: "oversized" }),
      item({ id: "j", type: "jeans", fit: "baggy" }),
    ];
    assert.ok(scoreProportion(pair, null) < 0.5);
    assert.ok(scoreProportion(pair, "streetwear") > scoreProportion(pair, null));
  });
});

describe("scorePattern", () => {
  it("allows one bold print, demands quieter shared seconds", () => {
    const solid = item({ id: "s", pattern: "solid" });
    const floral = item({ id: "f", pattern: "floral" });
    assert.equal(scorePattern([solid, floral]), 0.9);
    const pinstripe = item({ id: "p", pattern: "white pinstripe", secondary_colors: ["white"] });
    const floralBlue = item({ id: "g", pattern: "blue floral", secondary_colors: ["white"] });
    void floralBlue;
    const shared = item({ id: "h", pattern: "small floral", secondary_colors: ["white"] });
    assert.ok(scorePattern([pinstripe, shared]) > scorePattern([floral, pinstripe]));
    assert.equal(scorePattern([floral, item({ id: "x", pattern: "leopard" })]), 0.2);
    assert.equal(scorePattern([floral, pinstripe, shared]), 0.1);
  });
});

describe("scoreMood", () => {
  const tee = () => item({ id: `t${Math.random()}`, pattern: "solid", primary_color: "white" });
  it("confident wants exactly one statement, cozy wants warmth and softness", () => {
    const red = item({ id: "r", primary_color: "red", pattern: "solid" });
    assert.equal(scoreMood("confident", [tee(), red]), 1);
    assert.ok(scoreMood("confident", [tee(), tee()]) < 0.5);
    const fleece = item({ id: "f", type: "sweater", warmth: 4, fabric_weight: "fleece" });
    const jeans = item({ id: "j", type: "jeans", warmth: 3, fabric_weight: "denim" });
    assert.ok(scoreMood("cozy", [fleece, jeans]) > scoreMood("cozy", [tee(), tee()]));
    assert.equal(scoreMood("mysterious", [tee()]), 0.5);
    assert.equal(scoreMood(null, [tee()]), 0.5);
  });
  it("calm likes tonal, lazy likes low formality", () => {
    const white = tee();
    assert.equal(scoreMood("calm", [white, white]), 1);
    const red = item({ id: "r", primary_color: "red" });
    const green = item({ id: "g", primary_color: "green" });
    assert.ok(scoreMood("calm", [white, red, green]) < 0.5);
    const easy = [item({ id: "a", formality: 1 }), item({ id: "b", formality: 2 })];
    const stiff = [item({ id: "a", formality: 4 }), item({ id: "b", formality: 5 })];
    assert.ok(scoreMood("lazy", easy) > scoreMood("lazy", stiff));
  });
});

describe("scoreRotation, scoreUndertone, scoreClimate, scoreModesty", () => {
  it("penalises recent wears, halved for jeans and shoes", () => {
    const tee = item({ id: "t" });
    const jeans = item({ id: "j", type: "jeans" });
    assert.equal(scoreRotation([tee], {}), 1);
    assert.equal(scoreRotation([tee], { t: 0 }), 0);
    assert.equal(scoreRotation([jeans], { j: 0 }), 0.5);
    assert.equal(scoreRotation([tee], { t: 8 }), 1);
  });
  it("rewards palette tops, skips when unset", () => {
    const rust = item({ id: "r", primary_color: "rust" });
    assert.equal(scoreUndertone([rust], undefined), 1);
    assert.equal(scoreUndertone([rust], "warm"), 1);
    assert.ok(scoreUndertone([rust], "cool") < 1);
  });
  it("prefers light relaxed fits only when hot and humid", () => {
    const cool = ctx();
    const light = [item({ id: "t", warmth: 1, fit: "relaxed" }), item({ id: "s", type: "shorts", warmth: 1 })];
    assert.equal(scoreClimate(light, cool.weather), 1);
    const hot = { highC: 32, lowC: 26, precipPct: 10, humidityPct: 75 };
    const heavy = [item({ id: "t", warmth: 4 }), item({ id: "j", type: "jeans", warmth: 4 })];
    assert.ok(scoreClimate(light, hot) > scoreClimate(heavy, hot));
  });
  it("conservative prefers coverage, others skip", () => {
    const covered = [
      item({ id: "t", type: "shirt", sleeve: "long", formality: 4 }),
      item({ id: "j", type: "chinos", length: "full", formality: 4 }),
    ];
    const bare = [
      item({ id: "t", type: "tank", sleeve: "sleeveless", formality: 2 }),
      item({ id: "s", type: "shorts", length: "short", formality: 2 }),
    ];
    assert.equal(scoreModesty(covered, "relaxed", [3, 4]), 1);
    assert.ok(scoreModesty(covered, "conservative", [3, 4]) > scoreModesty(bare, "conservative", [3, 4]));
  });
});

describe("scoreFeedback and pairAdjustments", () => {
  it("averages votes per pair and boosts liked combos", () => {
    const votes = [
      { key: "a|b", itemIds: ["a", "b"], vote: 1 as const },
      { key: "a|b|c", itemIds: ["a", "b", "c"], vote: -1 as const },
    ];
    const pairs = pairAdjustments(votes);
    assert.equal(pairs["a|b"], 0);
    assert.equal(pairs["a|c"], -1);
    const items = [item({ id: "a" }), item({ id: "b" })];
    assert.equal(scoreFeedback(items, {}), 1);
    assert.ok(scoreFeedback(items, { "a|b": 1 }) > 1 - 1e-9);
    assert.ok(scoreFeedback(items, { "a|b": -1 }) < 1);
  });
});

describe("isBoldPattern", () => {
  it("flags prints, forgives solids and quiet pinstripes", () => {
    assert.equal(isBoldPattern("floral"), true);
    assert.equal(isBoldPattern("solid"), false);
    assert.equal(isBoldPattern("white pinstripe"), false);
    assert.equal(isBoldPattern(""), false);
  });
});

describe("generateCandidates", () => {
  function closet(): RuleItem[] {
    return [
      item({ id: "t1", type: "t-shirt", primary_color: "white", formality: 2, warmth: 2 }),
      item({ id: "t2", type: "shirt", primary_color: "blue", formality: 3, warmth: 2 }),
      item({ id: "j1", type: "jeans", primary_color: "denim", formality: 2, warmth: 3 }),
      item({ id: "j2", type: "chinos", primary_color: "khaki", formality: 3, warmth: 3 }),
      item({ id: "s1", type: "sneakers", primary_color: "white", formality: 2, warmth: 1 }),
      item({ id: "s2", type: "loafers", primary_color: "brown", formality: 4, warmth: 1 }),
    ];
  }
  it("builds, scores and diversifies candidates", () => {
    const c = ctx({ items: closet(), occasion: "casual", seed: "s1" });
    const { candidates, stats } = generateCandidates(c);
    assert.ok(candidates.length > 0 && candidates.length <= 15);
    assert.ok(stats.generated > 0 && stats.sampled <= 400);
    const pairs = candidates.map((cand) => cand.id);
    assert.equal(new Set(pairs).size, pairs.length);
    for (const cand of candidates) {
      assert.ok(cand.reason.length > 10);
      assert.ok(!/\d/.test(cand.reason), `reason must read stylist-like: ${cand.reason}`);
      assert.ok(!/score|filter|warmth|formality/i.test(cand.reason));
    }
  });
  it("never returns empty for a tiny closet, relaxing as needed", () => {
    const tiny = [
      item({ id: "t", type: "hoodie", primary_color: "grey", formality: 1, warmth: 5 }),
      item({ id: "j", type: "jeans", primary_color: "denim", formality: 2, warmth: 3 }),
      item({ id: "s", type: "sneakers", primary_color: "white", formality: 1, warmth: 1 }),
    ];
    const hot = ctx({
      items: tiny,
      occasion: "interview",
      seed: "tiny",
      weather: { highC: 33, lowC: 28, precipPct: 0, humidityPct: 80 },
    });
    const { candidates, stats } = generateCandidates(hot);
    assert.ok(candidates.length >= 1);
    assert.ok(stats.relaxed !== null || stats.afterFilters > 0);
  });
  it("samples deterministically under the cap", () => {
    const many: RuleItem[] = [];
    for (let i = 0; i < 30; i += 1) {
      many.push(item({ id: `t${i}`, type: "t-shirt", primary_color: "white", formality: 2, warmth: 1 }));
      many.push(item({ id: `j${i}`, type: "jeans", primary_color: "denim", formality: 2, warmth: 1 }));
    }
    many.push(item({ id: "s", type: "sneakers", primary_color: "white", formality: 2, warmth: 1 }));
    const run = (seed: string) =>
      generateCandidates(ctx({ items: many, seed })).candidates.map((c) => c.id);
    assert.deepEqual(run("same"), run("same"));
    assert.ok(run("same").length <= 15);
  });
});

describe("ruleReason", () => {
  it("reads like a stylist, not debug output", () => {
    const c = ctx({ occasion: "office" });
    const outfit = [
      item({ id: "t", type: "t-shirt", primary_color: "navy", nickname: "Evening Navy", fit: "relaxed" }),
      item({ id: "j", type: "jeans", primary_color: "denim", fit: "slim" }),
    ];
    const reason = ruleReason(outfit, c);
    assert.ok(reason.length > 10 && reason.length < 200);
    assert.ok(!/\d/.test(reason), reason);
    assert.ok(!/score|filter|warmth|formality|band|spread/i.test(reason), reason);
  });
});

describe("generateCandidates structure", () => {
  const jeans = () => item({ id: "j", type: "jeans", warmth: 3, formality: 2 });
  const shoes = () => item({ id: "s", type: "sneakers", warmth: 1, formality: 2 });
  it("never emits two base tops, even when one is tagged as a mid layer", () => {
    const tops = [
      item({ id: "sh", type: "shirt", layer: "mid", warmth: 2, formality: 2 }),
      item({ id: "po", type: "polo", warmth: 2, formality: 2 }),
      item({ id: "te", type: "t-shirt", warmth: 2, formality: 2 }),
    ];
    const c = ctx({ items: [...tops, jeans(), shoes()], occasion: "casual" });
    const { candidates } = generateCandidates(c);
    assert.ok(candidates.length > 0);
    const topIds = new Set(["sh", "po", "te"]);
    for (const cand of candidates) {
      const n = cand.itemIds.filter((id) => topIds.has(id)).length;
      assert.equal(n, 1, `candidate ${cand.id} has ${n} base tops`);
    }
  });
  it("layers a cardigan and jacket over a tee, never a shirt tagged as outer", () => {
    const tee = item({ id: "te", type: "t-shirt", warmth: 2, formality: 2 });
    const cardigan = item({ id: "ca", type: "cardigan", layer: "mid", warmth: 2, formality: 2 });
    const jacket = item({ id: "ja", type: "jacket", layer: "outer", warmth: 3, formality: 2 });
    const tagged = item({ id: "sh", type: "shirt", layer: "outer", warmth: 2, formality: 2 });
    const c = ctx({
      items: [tee, cardigan, jacket, tagged, jeans(), shoes()],
      occasion: "casual",
      weather: { highC: 18, lowC: 10, precipPct: 0, humidityPct: 40 },
    });
    const { candidates } = generateCandidates(c);
    const full = candidates.find(
      (cand) =>
        cand.itemIds.includes("te") &&
        cand.itemIds.includes("ca") &&
        cand.itemIds.includes("ja"),
    );
    assert.ok(full, "expected a tee + cardigan + jacket candidate");
    for (const cand of candidates) {
      if (cand.itemIds.includes("sh")) {
        assert.ok(!cand.itemIds.includes("te"), `tagged shirt shares a look with the tee: ${cand.id}`);
      }
    }
  });
});
