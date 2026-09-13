import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OfflineMeta } from "@stremio-offline/models";
import { JsonDirMetaStore, MemoryMetaStore } from "./meta-store.ts";

const meta: OfflineMeta = { type: "movie", imdbId: "tt1", title: "Interstellar", poster: "p", savedAt: 1 };

test("MemoryMetaStore isolates stored objects", async () => {
  const store = new MemoryMetaStore();
  await store.put(meta);
  const stored = await store.get("movie", "tt1");
  assert.deepEqual(stored, meta);
  if (stored) stored.title = "changed";
  assert.equal((await store.get("movie", "tt1"))?.title, "Interstellar");
  assert.equal(await store.get("series", "tt1"), undefined);
});

test("JsonDirMetaStore round-trips and never lets an id name a path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "so-meta-"));
  try {
    const store = new JsonDirMetaStore(join(dir, "meta"));
    assert.equal(await store.get("movie", "tt1"), undefined);
    await store.put(meta);
    await store.put({ ...meta, type: "series", imdbId: "../x/tt2:1" });
    assert.deepEqual(await store.get("movie", "tt1"), meta);
    assert.equal((await store.get("series", "../x/tt2:1"))?.imdbId, "../x/tt2:1");
    assert.deepEqual((await readdir(join(dir, "meta"))).sort(), ["movie-tt1.json", "series-..%2Fx%2Ftt2%3A1.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
