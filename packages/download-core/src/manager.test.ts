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

function setup(engine = new FakeEngine(), store = new MemoryJobStore(), maxConcurrent?: number) {
  let counter = 0;
  let clock = 42;
  const manager = new DownloadManager({
    store,
    engine,
    storageDir: "/store",
    newId: () => `job${++counter}`,
    // Distinct timestamps, so the queue's oldest-first order is the enqueue order.
    now: () => clock++,
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
  });
  return { manager, engine, store };
}

/** Four different movies, so each enqueue makes its own job. */
function forMovie(id: string): RegisteredSource {
  return {
    ...registered,
    source: { ...source, key: `torrent:${id}:1` },
    media: { ...media, mediaId: id, videoId: id },
  };
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

test("only maxConcurrent jobs run at once; the rest wait as queued", async () => {
  const { manager, engine } = setup(new FakeEngine(), new MemoryJobStore(), 2);
  const jobs = [];
  for (const id of ["tt1", "tt2", "tt3", "tt4"]) jobs.push(await manager.enqueue(forMovie(id)));
  await manager.idle();

  assert.deepEqual(engine.started, ["job1", "job2"], "two transfers, not four");
  assert.equal(manager.running, 2);
  assert.deepEqual(
    (await manager.list()).map((job) => job.status),
    ["queued", "queued", "queued", "queued"],
  );

  // Finishing one frees exactly one slot, and the oldest waiting job takes it.
  engine.events.get("job1")!.complete({ localPath: "/store/a.mkv", totalBytes: 1 });
  await manager.idle();
  assert.deepEqual(engine.started, ["job1", "job2", "job3"]);
  assert.equal(manager.running, 2);
  assert.equal((await manager.get(jobs[0]!.id))?.status, "complete");

  // So does a failure, a pause and a cancel.
  engine.events.get("job2")!.error("no peers");
  await manager.idle();
  assert.deepEqual(engine.started, ["job1", "job2", "job3", "job4"]);

  await manager.pause("job3");
  await manager.idle();
  assert.equal(manager.running, 1, "nothing is left waiting to take the freed slot");
  assert.deepEqual(engine.started, ["job1", "job2", "job3", "job4"]);

  await manager.cancel("job4");
  await manager.idle();
  assert.equal(manager.running, 0);
});

test("a resumed job waits its turn when every slot is busy", async () => {
  const { manager, engine } = setup(new FakeEngine(), new MemoryJobStore(), 1);
  const first = await manager.enqueue(forMovie("tt1"));
  const second = await manager.enqueue(forMovie("tt2"));
  await manager.idle();
  assert.deepEqual(engine.started, [first.id]);

  await manager.pause(first.id);
  await manager.idle();
  assert.deepEqual(engine.started, [first.id, second.id], "the slot goes to the waiting job");

  assert.equal((await manager.resume(first.id))?.status, "queued");
  await manager.idle();
  assert.deepEqual(engine.started, [first.id, second.id], "and the resumed job now waits");
  assert.equal(manager.running, 1);

  engine.events.get(second.id)!.complete({ localPath: "/store/b.mkv", totalBytes: 1 });
  await manager.idle();
  assert.deepEqual(engine.started, [first.id, second.id, first.id]);
});

test("init puts every interrupted job back in the queue and restarts up to the limit", async () => {
  const store = new MemoryJobStore();
  const first = setup(new FakeEngine(), store, 4);
  const ids = [];
  for (const id of ["tt1", "tt2", "tt3"]) ids.push((await first.manager.enqueue(forMovie(id))).id);
  first.engine.events.get(ids[0]!)!.progress({ bytesDownloaded: 500, totalBytes: 1000 });
  first.engine.events.get(ids[2]!)!.complete({ localPath: "/store/c.mkv", totalBytes: 1 });
  await first.manager.idle();
  assert.equal((await store.get(ids[0]!))?.status, "downloading");

  const second = setup(new FakeEngine(), store, 1);
  await second.manager.init();
  await second.manager.idle();
  assert.deepEqual(second.engine.started, [ids[0]], "one slot, oldest first, and never the finished job");
  const restarted = await second.manager.get(ids[0]!);
  assert.equal(restarted?.status, "queued", "nothing is downloading until the engine says so");
  assert.equal(restarted?.bytesDownloaded, 500, "progress is kept, so the engine resumes from it");
  assert.equal((await second.manager.get(ids[1]!))?.status, "queued");
});
