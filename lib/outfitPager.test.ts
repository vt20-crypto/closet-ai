import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PAGE_SIZE,
  appendMore,
  createPager,
  currentPage,
  hasMore,
  nextPage,
  pageRange,
} from "./outfitPager.ts";

const o = (key: string) => ({ key });
const keys = ["a", "b", "c", "d", "e", "f", "g"].map(o);

describe("outfitPager", () => {
  it("shows the first page of 3 and reports no wrap-around", () => {
    assert.equal(PAGE_SIZE, 3);
    const pager = createPager(keys);
    assert.deepEqual(
      currentPage(pager).map((p) => p.key),
      ["a", "b", "c"],
    );
    assert.equal(hasMore(pager), true);
  });

  it("advances page by page and stops at exhaustion without wrapping", () => {
    let pager = createPager(keys);
    pager = nextPage(pager);
    assert.deepEqual(
      currentPage(pager).map((p) => p.key),
      ["d", "e", "f"],
    );
    assert.equal(hasMore(pager), true);
    pager = nextPage(pager);
    assert.deepEqual(
      currentPage(pager).map((p) => p.key),
      ["g"],
    );
    assert.equal(hasMore(pager), false);
    const stuck = nextPage(pager);
    assert.deepEqual(
      currentPage(stuck).map((p) => p.key),
      ["g"],
    );
  });

  it("tracks every shown key exactly once", () => {
    let pager = createPager(keys);
    pager = nextPage(pager);
    pager = nextPage(pager);
    assert.deepEqual(pager.seen, ["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("more-ideas appends only unseen combos and shows them right away", () => {
    let pager = createPager(keys.slice(0, 4));
    pager = nextPage(pager); // shows ["d"], exhausted
    assert.equal(hasMore(pager), false);
    pager = appendMore(pager, [o("d"), o("b"), o("h"), o("i")]);
    assert.deepEqual(
      currentPage(pager).map((p) => p.key),
      ["d", "h", "i"],
    );
    assert.equal(hasMore(pager), false);
    assert.deepEqual(pager.seen, ["a", "b", "c", "d", "h", "i"]);
  });

  it("appending nothing new leaves the pager untouched", () => {
    const pager = createPager(keys.slice(0, 3));
    const same = appendMore(pager, [o("a"), o("c")]);
    assert.equal(same, pager);
    assert.equal(hasMore(same), false);
  });

  it("reports the 1-based range matching the cards shown", () => {
    let pager = createPager(keys);
    assert.deepEqual(pageRange(pager), { from: 1, to: 3 });
    pager = nextPage(pager);
    pager = nextPage(pager);
    assert.deepEqual(pageRange(pager), { from: 7, to: 7 });
  });

  it("empty list shows an empty page with nothing more", () => {
    const pager = createPager([]);
    assert.deepEqual(currentPage(pager), []);
    assert.equal(hasMore(pager), false);
    assert.deepEqual(pageRange(pager), { from: 1, to: 0 });
  });
});
