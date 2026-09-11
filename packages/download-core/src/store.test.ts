import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DownloadJob } from "@stremio-offline/models";
import { JsonFileJobStore, MemoryJobStore } from "./store.ts";

function job(id: string): DownloadJob {
  return {
    id,
    media: { type: "movie", mediaId: "tt1", videoId: "tt1", title: "Movie" },
    source: { type: "http", url: "https://x/y.mkv" },
    sourceKey: "http:https://x/y.mkv",
    label: "1080p",
    status: "queued",
    bytesDownloaded: 0,
    localPath: "/tmp/y.mkv",
    createdAt: 1,
    updatedAt: 1,
  };
}

test("MemoryJobStore isolates stored objects from callers", async () => {
  const store = new MemoryJobStore();
  const original = job("a");
  await store.put(original);
  original.status = "error";
  assert.equal((await store.get("a"))?.status, "queued");
  await store.delete("a");
  assert.equal(await store.get("a"), undefined);
});

test("JsonFileJobStore persists across instances and survives concurrent writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "so-store-"));
  const path = join(dir, "nested", "jobs.json");
  try {
    const store = new JsonFileJobStore(path);
    await store.init();
    await Promise.all([store.put(job("a")), store.put(job("b")), store.put({ ...job("c"), status: "paused" })]);
    await store.delete("b");

    const file = JSON.parse(await readFile(path, "utf8")) as { version: number; jobs: DownloadJob[] };
    assert.equal(file.version, 1);
    assert.deepEqual(file.jobs.map((j) => j.id).sort(), ["a", "c"]);

    const reopened = new JsonFileJobStore(path);
    await reopened.init();
    assert.equal((await reopened.all()).length, 2);
    assert.equal((await reopened.get("c"))?.status, "paused");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonFileJobStore starts empty when the file is missing", async () => {
  const store = new JsonFileJobStore(join(tmpdir(), "so-does-not-exist", "jobs.json"));
  await store.init();
  assert.deepEqual(await store.all(), []);
});
