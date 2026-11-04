import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deleteOldPointers,
  pointerPath,
  readAvatarPointer,
  writeAvatarPointer,
  type AvatarPointer,
} from "./avatarPointer.ts";
import { readJsonFromStore, writeJsonToStore, type BlobStore } from "./blobStore.ts";

/**
 * In-memory Blob that enforces the real contract: put on an existing key
 * throws unless allowOverwrite is true. uploadedAt is a manual clock so
 * ordering tests are deterministic.
 */
function makeFakeStore() {
  const files = new Map<string, { body: string; uploadedAt: number }>();
  let clock = Date.now();
  const puts: { pathname: string; opts?: { allowOverwrite?: boolean; cacheControlMaxAge?: number } }[] = [];
  const deleted: string[] = [];
  const store: BlobStore = {
    async listBlobs(prefix: string) {
      return [...files.entries()]
        .filter(([pathname]) => pathname.startsWith(prefix))
        .map(([pathname, file]) => ({
          url: `blob://${pathname}`,
          pathname,
          uploadedAt: new Date(file.uploadedAt).toISOString(),
        }));
    },
    async putBlob(pathname: string, body: string | Buffer, _contentType: string, opts?: { allowOverwrite?: boolean; cacheControlMaxAge?: number }) {
      if (files.has(pathname) && opts?.allowOverwrite !== true) {
        throw new Error("This blob already exists");
      }
      clock += 1;
      files.set(pathname, { body: String(body), uploadedAt: clock });
      puts.push({ pathname, opts });
      return `blob://${pathname}`;
    },
    async delBlobs(pathnames: string[]) {
      for (const pathname of pathnames) {
        files.delete(pathname);
        deleted.push(pathname);
      }
    },
    async fetchJson<T>(url: string) {
      const match = /^blob:\/\/(.+)$/.exec(url);
      const file = match ? files.get(match[1]) : undefined;
      if (!file) return null;
      return JSON.parse(file.body) as T;
    },
  };
  return { store, files, puts, deleted };
}

function pointer(version: string): AvatarPointer {
  return {
    url: `blob://avatar/${version}.webp`,
    path: `avatar/${version}.webp`,
    version,
    createdAt: new Date(0).toISOString(),
  };
}

describe("writeJsonToStore", () => {
  it("overwrites an existing key with allowOverwrite + short cache", async () => {
    const { store, puts } = makeFakeStore();
    await writeJsonToStore(store, "cache/x.json", { v: 1 });
    await writeJsonToStore(store, "cache/x.json", { v: 2 });
    const read = await readJsonFromStore<{ v: number }>(store, "cache/x.json", 60_000);
    assert.equal(read.hit, true);
    assert.equal(read.data?.v, 2);
    assert.equal(puts[1]?.opts?.allowOverwrite, true);
    assert.equal(puts[1]?.opts?.cacheControlMaxAge, 60);
  });

  it("still throws when the store itself rejects", async () => {
    const { store } = makeFakeStore();
    const failing: BlobStore = {
      ...store,
      putBlob: async () => {
        throw new Error("store down");
      },
    };
    await assert.rejects(writeJsonToStore(failing, "cache/x.json", { v: 1 }), /store down/);
  });
});

describe("avatar pointer redo", () => {
  it("reads back the newest version after a redo", async () => {
    const { store } = makeFakeStore();
    await writeAvatarPointer(store, pointer("v1"));
    await writeAvatarPointer(store, pointer("v2"));
    const current = await readAvatarPointer(store);
    assert.equal(current?.version, "v2");
  });

  it("deleteOldPointers keeps only the current pointer file", async () => {
    const { store, files } = makeFakeStore();
    await writeAvatarPointer(store, pointer("v1"));
    await writeAvatarPointer(store, pointer("v2"));
    await deleteOldPointers(store, pointerPath("v2"));
    assert.deepEqual(
      [...files.keys()].sort(),
      [pointerPath("v2")],
    );
  });

  it("a failed pointer write deletes nothing (previous avatar stays)", async () => {
    const { store, deleted } = makeFakeStore();
    await writeAvatarPointer(store, pointer("v1"));
    const failing: BlobStore = {
      ...store,
      putBlob: async (pathname: string) => {
        if (pathname.startsWith("avatar/pointer-")) throw new Error("pointer write failed");
        return store.putBlob(pathname, "", "application/json");
      },
    };
    await assert.rejects(writeAvatarPointer(failing, pointer("v2")), /pointer write failed/);
    assert.deepEqual(deleted, []);
    const current = await readAvatarPointer(store);
    assert.equal(current?.version, "v1");
  });

  it("ignores non-pointer blobs and malformed JSON", async () => {
    const { store } = makeFakeStore();
    await store.putBlob("avatar/v1.webp", "raw", "image/webp");
    await store.putBlob(pointerPath("v9"), "not-json", "application/json", { allowOverwrite: true });
    assert.equal(await readAvatarPointer(store), null);
    await writeAvatarPointer(store, pointer("v1"));
    assert.equal((await readAvatarPointer(store))?.version, "v1");
  });
});
