import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readAvatarPointer, resetAvatarPointerCacheForTests } from "./avatarPointer.ts";
import { readJsonFromStore, type BlobStore } from "./blobStore.ts";
import {
  isStorageUnavailable,
  storageUnavailableResponse,
  StorageUnavailableError,
} from "./storage.ts";

function outageStore(): BlobStore {
  return {
    async listBlobs(prefix: string) {
      return [
        { url: `blob://${prefix}pointer-2.json`, pathname: `${prefix}pointer-2.json`, uploadedAt: new Date(2000).toISOString() },
        { url: `blob://${prefix}pointer-1.json`, pathname: `${prefix}pointer-1.json`, uploadedAt: new Date(1000).toISOString() },
      ];
    },
    async headBlob(pathname: string) {
      return { url: `blob://${pathname}`, pathname, uploadedAt: new Date().toISOString() };
    },
    async putBlob(pathname: string) {
      return `blob://${pathname}`;
    },
    async delBlobs() {},
    async fetchJson() {
      throw new StorageUnavailableError(403, "blob://outage");
    },
  };
}

describe("storage outage visibility", () => {
  it("maps to a 503 with a stable code and friendly message", async () => {
    const res = storageUnavailableResponse();
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string; code?: string };
    assert.equal(body.code, "storage_unavailable");
    assert.match(body.error ?? "", /pieces are safe/);
  });

  it("readJsonFromStore propagates outages instead of a miss", async () => {
    await assert.rejects(readJsonFromStore(outageStore(), "cache/x.json", 60_000), (err: unknown) =>
      isStorageUnavailable(err),
    );
  });

  it("readJsonFromStore misses on 404 null", async () => {
    const store: BlobStore = {
      ...outageStore(),
      async fetchJson() {
        return null;
      },
    };
    const read = await readJsonFromStore(store, "cache/x.json", 60_000);
    assert.equal(read.hit, false);
  });

  it("readAvatarPointer throws when every pointer read fails", async () => {
    resetAvatarPointerCacheForTests();
    await assert.rejects(readAvatarPointer(outageStore()), (err: unknown) =>
      isStorageUnavailable(err),
    );
  });
});
