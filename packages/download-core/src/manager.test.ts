import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { DownloadJob, JobMedia, NormalizedSource } from "@stremio-offline/models";
import { DownloadManager, type DownloadEngine, type EngineEvents } from "./manager.ts";
import { planLocalPath, sanitizeFilename, withSuffix } from "./paths.ts";
import type { RegisteredSource } from "./source-registry.ts";
import { MemoryJobStore } from "./store.ts";

class FakeEngine implements DownloadEngine {
  started: string[] = [];
  paused: string[] = [];
  cancelled: string[] = [];
  events = new Map<string, EngineEvents>();
  failOnStart = false;

  start(job: DownloadJob, events: EngineEvents): void {
    if (this.failOnStart) throw new Error("engine down");
    this.started.push(job.id);
    this.events.set(job.id, events);
  }

  pause(job: DownloadJob): void {
    this.paused.push(job.id);
  }

  cancel(job: DownloadJob): void {
    this.cancelled.push(job.id);
  }
}

const source: NormalizedSource = {
  key: "torrent:abc:1",
  source: { type: "torrent", infoHash: "abc", fileIdx: 1, filename: "Movie.1080p.mkv" },
  providers: ["Torrentio"],
  label: "1080p WEB-DL",
  quality: "1080p",
  size: 1000,
};
const media: JobMedia = { type: "movie", mediaId: "tt1", videoId: "tt1", title: "Interstellar" };
const registered: RegisteredSource = { token: "t", source, media, createdAt: 0 };

function setup(engine = new FakeEngine(), store = new MemoryJobStore()) {
  let counter = 0;
  const manager = new DownloadManager({ store, engine, storageDir: "/store", newId: () => `job${++counter}`, now: () => 42 });
  return { manager, engine, store };
}

test("enqueue creates a queued job and starts the engine", async () => {
  const { manager, engine } = setup();
  const job = await manager.enqueue(registered);
  assert.equal(job.status, "queued");
  assert.equal(job.totalBytes, 1000);
  assert.equal(job.localPath, join("/store", "Movies", "Interstellar", "Movie.1080p.mkv"));
  assert.deepEqual(engine.started, ["job1"]);
  const again = await manager.enqueue(registered);
  assert.equal(again.id, job.id, "same source is not queued twice");
  assert.deepEqual(engine.started, ["job1"]);
});

test("engine events drive the job through downloading to complete", async () => {
  const { manager, engine } = setup();
  const updates: string[] = [];
  manager.subscribe((event) => updates.push(event.type === "job-updated" ? event.job.status : "removed"));
  const job = await manager.enqueue(registered);
  const events = engine.events.get(job.id)!;

  events.status("resolving");
  events.progress({ bytesDownloaded: 370, totalBytes: 1000 });
  await manager.idle();
  let current = await manager.get(job.id);
  assert.equal(current?.status, "downloading");
  assert.equal(current?.bytesDownloaded, 370);

  events.complete({ localPath: "/store/Movies/Interstellar/final.mkv", totalBytes: 1000 });
  await manager.idle();
  current = await manager.get(job.id);
  assert.equal(current?.status, "complete");
  assert.equal(current?.bytesDownloaded, 1000);
  assert.equal(current?.localPath, "/store/Movies/Interstellar/final.mkv");
  assert.deepEqual(updates, ["queued", "resolving", "downloading", "complete"]);
});

test("pause ignores late progress, resume restarts the engine", async () => {
  const { manager, engine } = setup();
  const job = await manager.enqueue(registered);
  const events = engine.events.get(job.id)!;
  events.progress({ bytesDownloaded: 10, totalBytes: 100 });
  await manager.idle();

  assert.equal((await manager.pause(job.id))?.status, "paused");
  assert.deepEqual(engine.paused, [job.id]);
  events.progress({ bytesDownloaded: 20, totalBytes: 100 });
  await manager.idle();
  assert.equal((await manager.get(job.id))?.bytesDownloaded, 10);

  assert.equal((await manager.resume(job.id))?.status, "queued");
  assert.deepEqual(engine.started, [job.id, job.id]);
  assert.equal((await manager.resume(job.id))?.status, "queued", "resume of a queued job is a no-op");
  assert.equal(engine.started.length, 2);
});

test("errors are recorded and retried via enqueue or resume", async () => {
  const { manager, engine } = setup();
  const job = await manager.enqueue(registered);
  engine.events.get(job.id)!.error("no peers");
  await manager.idle();
  assert.equal((await manager.get(job.id))?.error, "no peers");

  const retried = await manager.enqueue(registered);
  assert.equal(retried.id, job.id);
  assert.equal(retried.status, "queued");
  assert.equal(retried.error, undefined);
  assert.equal(engine.started.length, 2);
});

test("engine start failure marks the job as error", async () => {
  const engine = new FakeEngine();
  engine.failOnStart = true;
  const { manager } = setup(engine);
  await manager.enqueue(registered);
  await manager.idle();
  const [job] = await manager.list();
  assert.equal(job?.status, "error");
  assert.equal(job?.error, "engine down");
});

test("cancel removes the job", async () => {
  const { manager, engine } = setup();
  const job = await manager.enqueue(registered);
  assert.equal(await manager.cancel(job.id), true);
  assert.deepEqual(engine.cancelled, [job.id]);
  assert.equal(await manager.get(job.id), undefined);
  assert.equal(await manager.cancel(job.id), false);
});

test("init restarts active jobs from the store but not finished ones", async () => {
  const store = new MemoryJobStore();
  const first = setup(new FakeEngine(), store);
  const a = await first.manager.enqueue(registered);
  const b = await first.manager.enqueue({ ...registered, media: { ...media, mediaId: "tt2", videoId: "tt2" } });
  first.engine.events.get(b.id)!.complete({ localPath: "/x", totalBytes: 1 });
  await first.manager.idle();

  const second = setup(new FakeEngine(), store);
  await second.manager.init();
  assert.deepEqual(second.engine.started, [a.id]);
});

test("planLocalPath sanitises and avoids collisions", () => {
  assert.equal(sanitizeFilename('Who: Am "I"? <2024>...'), "Who Am I 2024");
  const episode: JobMedia = { type: "series", mediaId: "tt2", videoId: "tt2:2:4", season: 2, episode: 4, title: "Severance" };
  assert.equal(
    planLocalPath("/s", episode, { type: "torrent", infoHash: "x" }, "id1"),
    join("/s", "Series", "Severance", "Severance S02E04 [id1]"),
  );
  assert.equal(
    planLocalPath("/s", media, { type: "http", url: "u", filename: "dir\\file:name.mkv" }, "id1"),
    join("/s", "Movies", "Interstellar", "file name.mkv"),
  );
  assert.equal(withSuffix("/a/b/movie.mkv", "x1"), "/a/b/movie [x1].mkv");
});
