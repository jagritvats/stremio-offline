import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobMedia, NormalizedSource } from "@stremio-offline/models";
import {
  HttpEngine,
  isTransientFailure,
  isTransientStatus,
  parseContentRange,
  partPath,
  suggestedExtension,
} from "./http-engine.ts";
import { DownloadManager } from "./manager.ts";
import type { RegisteredSource } from "./source-registry.ts";
import { MemoryJobStore } from "./store.ts";

const DATA = randomBytes(256 * 1024);
const CHUNK = 64 * 1024;

interface ContentServer {
  url: string;
  /** Range header of every request, in order. */
  seen: Array<string | undefined>;
  /** Stop sending after this many bytes of the current response until release() is called. */
  holdAfter(bytes: number): void;
  release(): void;
  close(): Promise<void>;
}

interface ServerOptions {
  ranges?: boolean;
  disposition?: string;
  /** Answer the first N requests with this status instead of the file. */
  failFirst?: { times: number; status: number };
  /** Cut the connection after this many bytes, once. */
  dropAfter?: number;
  /** Pause between chunks, so the client has read some of them before a drop. */
  chunkDelayMs?: number;
}

async function contentServer(options: ServerOptions = {}): Promise<ContentServer> {
  const seen: Array<string | undefined> = [];
  let hold: { after: number; promise: Promise<void>; release: () => void } | undefined;
  let failures = options.failFirst?.times ?? 0;
  let drops = options.dropAfter === undefined ? 0 : 1;
  const server = createServer(async (req, res) => {
    res.on("error", () => {});
    seen.push(req.headers.range);
    if (req.url === "/missing") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (failures > 0) {
      failures -= 1;
      res.writeHead(options.failFirst?.status ?? 503);
      res.end();
      return;
    }
    const headers: Record<string, string> = { "content-type": "video/mp4", etag: '"v1"' };
    if (options.disposition) headers["content-disposition"] = options.disposition;
    let start = 0;
    const end = DATA.length - 1;
    const match = options.ranges === false ? null : /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (match) {
      start = Number(match[1]);
      if (start >= DATA.length) {
        res.writeHead(416, { "content-range": `bytes */${DATA.length}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${DATA.length}`,
        "content-length": String(end - start + 1),
      });
    } else {
      res.writeHead(200, { ...headers, "content-length": String(DATA.length) });
    }
    let sent = 0;
    for (let pos = start; pos <= end; pos += CHUNK) {
      if (res.destroyed) return;
      const chunk = DATA.subarray(pos, Math.min(pos + CHUNK, end + 1));
      // Await the write callback: the drop below must lose the connection, not the bytes already sent.
      await new Promise<void>((resolve) => res.write(chunk, () => resolve()));
      sent += chunk.length;
      if (options.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, options.chunkDelayMs));
      if (drops > 0 && options.dropAfter !== undefined && sent >= options.dropAfter) {
        drops -= 1;
        res.destroy();
        return;
      }
      if (hold && sent >= hold.after) await hold.promise;
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/file`,
    seen,
    holdAfter(bytes) {
      let release = (): void => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { after: bytes, promise, release };
    },
    release() {
      hold?.release();
      hold = undefined;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function registered(url: string): RegisteredSource {
  const source: NormalizedSource = { key: `http:${url}`, source: { type: "http", url }, providers: ["Test"], label: "1080p" };
  const media: JobMedia = { type: "movie", mediaId: "tt1", videoId: "tt1", title: "Movie" };
  return { token: "t", source, media, createdAt: 0 };
}

function setup(dir: string, engineOptions: ConstructorParameters<typeof HttpEngine>[0] = {}) {
  const engine = new HttpEngine({ progressIntervalMs: 0, retryDelayMs: 1, ...engineOptions });
  const manager = new DownloadManager({ store: new MemoryJobStore(), engine, storageDir: dir });
  const statuses: string[] = [];
  manager.subscribe((event) => {
    if (event.type === "job-updated") statuses.push(event.job.status);
  });
  return { engine, manager, statuses };
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const untilStatus = (manager: DownloadManager, id: string, status: string) =>
  waitFor(async () => {
    const job = await manager.get(id);
    return job?.status === status ? job : undefined;
  });

const untilBytes = (manager: DownloadManager, id: string, bytes: number) =>
  waitFor(async () => {
    const job = await manager.get(id);
    return job && job.bytesDownloaded >= bytes ? job : undefined;
  });

async function withServer(
  options: ServerOptions,
  run: (server: ContentServer, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "so-http-"));
  const server = await contentServer(options);
  try {
    await run(server, dir);
  } finally {
    server.release();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("downloads a file, names it from the server's content type and reports progress", () =>
  withServer({}, async (server, dir) => {
    const { manager, statuses } = setup(dir);
    const job = await manager.enqueue(registered(server.url));
    assert.equal(job.localPath, join(dir, "Movies", "Movie", `Movie [${job.id}]`));

    const done = await untilStatus(manager, job.id, "complete");
    assert.equal(done.localPath, `${job.localPath}.mp4`);
    assert.equal(done.totalBytes, DATA.length);
    assert.equal(done.bytesDownloaded, DATA.length);
    assert.ok(Buffer.from(await readFile(done.localPath)).equals(DATA));
    await assert.rejects(stat(partPath(done.localPath)), "the partial file is gone once the download completes");
    assert.deepEqual(statuses.slice(0, 3), ["queued", "resolving", "downloading"]);
    assert.equal(statuses.at(-1), "complete");
    assert.deepEqual(server.seen, [undefined]);
  }));

test("Content-Disposition wins over the content type for the extension", () =>
  withServer({ disposition: 'attachment; filename="Real.Name.MKV"' }, async (server, dir) => {
    const { manager } = setup(dir);
    const job = await manager.enqueue(registered(server.url));
    const done = await untilStatus(manager, job.id, "complete");
    assert.equal(done.localPath, `${job.localPath}.mkv`);
  }));

test("pause keeps the partial file; resume continues from it with a Range request", () =>
  withServer({}, async (server, dir) => {
    const { manager } = setup(dir);
    server.holdAfter(CHUNK);
    const job = await manager.enqueue(registered(server.url));
    await untilBytes(manager, job.id, CHUNK);

    const paused = await manager.pause(job.id);
    assert.equal(paused?.status, "paused");
    assert.equal((await stat(partPath(paused?.localPath ?? ""))).size, CHUNK);

    server.release();
    assert.equal((await manager.resume(job.id))?.status, "queued");
    const done = await untilStatus(manager, job.id, "complete");
    assert.deepEqual(server.seen, [undefined, `bytes=${CHUNK}-`]);
    assert.ok(Buffer.from(await readFile(done.localPath)).equals(DATA));
    assert.equal(done.bytesDownloaded, DATA.length);
  }));

test("a server that ignores Range makes the resume start over, without duplicating bytes", () =>
  withServer({ ranges: false }, async (server, dir) => {
    const { manager } = setup(dir);
    server.holdAfter(CHUNK);
    const job = await manager.enqueue(registered(server.url));
    await untilBytes(manager, job.id, CHUNK);
    await manager.pause(job.id);
    server.release();
    await manager.resume(job.id);
    const done = await untilStatus(manager, job.id, "complete");
    assert.equal(server.seen[1], `bytes=${CHUNK}-`);
    assert.ok(Buffer.from(await readFile(done.localPath)).equals(DATA));
  }));

test("an upstream error fails the job with a message that never carries the url", () =>
  withServer({}, async (server, dir) => {
    const { manager } = setup(dir);
    const job = await manager.enqueue(registered(server.url.replace("/file", "/missing")));
    const failed = await untilStatus(manager, job.id, "error");
    assert.equal(failed.error, "upstream responded 404");
  }));

test("cancel aborts the transfer and deletes the partial file", () =>
  withServer({}, async (server, dir) => {
    const { manager } = setup(dir);
    server.holdAfter(CHUNK);
    const job = await manager.enqueue(registered(server.url));
    const running = await untilBytes(manager, job.id, CHUNK);
    assert.equal(await manager.cancel(job.id), true);
    await assert.rejects(stat(partPath(running.localPath)));
    assert.equal(await manager.get(job.id), undefined);
  }));

test("suggestedExtension and parseContentRange", () => {
  assert.equal(suggestedExtension('attachment; filename="Movie.2014.MKV"', "https://x/y", null), ".mkv");
  assert.equal(suggestedExtension("attachment; filename*=UTF-8''Big%20Buck.webm", "https://x/y", null), ".webm");
  assert.equal(suggestedExtension(null, "https://cdn.example/path/movie.mp4?token=1", null), ".mp4");
  assert.equal(suggestedExtension(null, "https://cdn.example/stream/1234", "video/x-matroska; charset=binary"), ".mkv");
  assert.equal(suggestedExtension(null, "https://cdn.example/stream/1234", "application/octet-stream"), "");
  assert.deepEqual(parseContentRange("bytes 100-199/200"), { start: 100, end: 199, total: 200 });
  assert.deepEqual(parseContentRange("bytes 0-9/*"), { start: 0, end: 9 });
  assert.equal(parseContentRange("nope"), undefined);
});

test("a transient upstream failure is retried with backoff, and the file still lands intact", () =>
  withServer({ failFirst: { times: 2, status: 503 } }, async (server, dir) => {
    const { manager } = setup(dir);
    const job = await manager.enqueue(registered(server.url));
    const done = await untilStatus(manager, job.id, "complete");
    assert.equal(server.seen.length, 3, "two rejections, then the transfer");
    assert.ok(Buffer.from(await readFile(done.localPath)).equals(DATA));
  }));

test("a dropped connection is retried and resumes from the bytes that landed", () =>
  // Node's fetch discards body chunks it has queued but not yet handed to the
  // reader when a connection errors, so the resume offset is "what reached the
  // disk", not "what the server sent". That is exactly what .part records.
  withServer({ dropAfter: 3 * CHUNK, chunkDelayMs: 10 }, async (server, dir) => {
    const { manager } = setup(dir);
    const job = await manager.enqueue(registered(server.url));
    const done = await untilStatus(manager, job.id, "complete");

    assert.equal(server.seen.length, 2, "one drop, one retry");
    const resumed = /^bytes=(\d+)-$/.exec(server.seen[1] ?? "");
    assert.ok(resumed, `the retry resumes with a Range header, got ${String(server.seen[1])}`);
    assert.ok(Number(resumed[1]) > 0, "and picks up from the bytes already on disk");
    assert.ok(Buffer.from(await readFile(done.localPath)).equals(DATA), "the reassembled file is byte-identical");
    assert.equal(done.bytesDownloaded, DATA.length);
  }));

test("retries are bounded, and a permanent failure is never retried", async () => {
  await withServer({ failFirst: { times: 99, status: 503 } }, async (server, dir) => {
    const { manager } = setup(dir, { retries: 2 });
    const job = await manager.enqueue(registered(server.url));
    const failed = await untilStatus(manager, job.id, "error");
    assert.equal(failed.error, "upstream responded 503");
    assert.equal(server.seen.length, 3, "the first attempt plus two retries");
  });
  await withServer({ failFirst: { times: 99, status: 403 } }, async (server, dir) => {
    const { manager } = setup(dir);
    const job = await manager.enqueue(registered(server.url));
    const failed = await untilStatus(manager, job.id, "error");
    assert.equal(failed.error, "upstream responded 403");
    assert.equal(server.seen.length, 1, "a 403 will not get better by asking again");
  });
});

test("pausing during a retry backoff stops it immediately", () =>
  withServer({ failFirst: { times: 99, status: 503 } }, async (server, dir) => {
    const { manager } = setup(dir, { retries: 50, retryDelayMs: 60_000 });
    const job = await manager.enqueue(registered(server.url));
    await waitFor(async () => (server.seen.length > 0 ? true : undefined));
    const paused = await manager.pause(job.id);
    assert.equal(paused?.status, "paused");
    const attempts = server.seen.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(server.seen.length, attempts, "no attempt survives the pause");
    assert.equal((await manager.get(job.id))?.status, "paused", "and it never flips to error");
  }));

test("failure classification", () => {
  assert.ok(isTransientStatus(503) && isTransientStatus(429) && isTransientStatus(408));
  assert.ok(!isTransientStatus(404) && !isTransientStatus(403) && !isTransientStatus(416));
  assert.ok(isTransientFailure(new Error("fetch failed")), "a network error is worth another try");
  assert.ok(!isTransientFailure(Object.assign(new Error("no space"), { code: "ENOSPC" })));
  assert.ok(!isTransientFailure(Object.assign(new Error("denied"), { code: "EACCES" })));
});
