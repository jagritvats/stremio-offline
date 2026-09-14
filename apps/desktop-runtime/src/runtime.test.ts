import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listen } from "@stremio-offline/addon-core";
import type { FetchLike } from "@stremio-offline/addon-proxy";
import { HttpEngine } from "@stremio-offline/download-core";
import type {
  CatalogResponse,
  DownloadJob,
  MetaResponse,
  StremioManifest,
  StremioStream,
} from "@stremio-offline/models";
import { writeConfig, type RuntimeConfig } from "./config.ts";
import { createRuntime, type Runtime } from "./runtime.ts";

const SECRET = "1".repeat(64);
const DATA = randomBytes(200 * 1024);
const AUTH = { authorization: `Bearer ${SECRET}` };

/** A file host with single-range support: what an upstream http stream points at. */
async function contentServer() {
  const server = createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), DATA.length - 1) : DATA.length - 1;
    const headers = { "content-type": "video/mp4", "content-length": String(end - start + 1) };
    if (match) res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${DATA.length}` });
    else res.writeHead(200, headers);
    res.end(DATA.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/movie`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });

/** One source addon offering one http stream (and one YouTube stream we must skip), plus a Cinemeta stand-in. */
function upstreamFor(fileUrl: string): FetchLike {
  return async (url) => {
    if (url === "https://up.example/stream/movie/tt1.json") {
      return ok({
        streams: [
          { url: fileUrl, title: "Test.Movie.1080p.WEB-DL", behaviorHints: { videoSize: DATA.length } },
          { ytId: "x" },
          { infoHash: "0123456789abcdef0123456789abcdef01234567", fileIdx: 0, title: "Test.Movie.2160p.REMUX" },
        ],
      });
    }
    if (url === "https://cinemeta.example/meta/movie/tt1.json") {
      return ok({ meta: { id: "tt1", type: "movie", name: "Test Movie", poster: "https://img/p.jpg" } });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

async function startRuntime(
  home: string,
  config: RuntimeConfig,
  upstreamFetch: FetchLike,
  overrides: Partial<Parameters<typeof createRuntime>[0]> = {},
) {
  const runtime = await createRuntime({
    home,
    config,
    version: "0.0.1",
    upstreamFetch,
    cinemeta: { id: "cinemeta", transportUrl: "https://cinemeta.example" },
    engine: new HttpEngine({ progressIntervalMs: 0, retryDelayMs: 1 }),
    ...overrides,
  });
  const { port } = await listen(runtime.server, 0);
  const base = `http://127.0.0.1:${port}`;
  const get = async <T>(path: string): Promise<T> => (await fetch(`${base}${path}`)).json() as Promise<T>;
  const streams = async (): Promise<StremioStream[]> => (await get<{ streams: StremioStream[] }>("/stream/movie/tt1.json")).streams;
  const action = (uri: string) => fetch(`${base}/api/action`, { method: "POST", headers: AUTH, body: JSON.stringify({ uri }) });
  return { runtime, base, get, streams, action };
}

async function untilComplete(runtime: Runtime, timeoutMs = 5000): Promise<DownloadJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = (await runtime.manager.list()).find((candidate) => candidate.status === "complete");
    if (job) return job;
    if (Date.now() > deadline) throw new Error("download did not complete in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("runtime: an upstream stream becomes ⬇ OFFLINE, a tap downloads it, and it plays from /media — also after a restart without internet", async () => {
  const home = await mkdtemp(join(tmpdir(), "so-runtime-"));
  const content = await contentServer();
  const config: RuntimeConfig = {
    version: 1,
    port: 0,
    secret: SECRET,
    storageDir: join(home, "downloads"),
    sources: [{ id: "up", name: "Upstream", manifestUrl: "https://up.example/manifest.json", transportUrl: "https://up.example", enabled: true }],
  };
  await writeConfig(home, config);

  const first = await startRuntime(home, config, upstreamFor(content.url));
  let jobId = "";
  try {
    const manifest = await first.get<StremioManifest>("/manifest.json");
    assert.deepEqual(manifest.resources, ["stream", "catalog", "meta"]);

    const [entry, ...rest] = await first.streams();
    assert.equal(rest.length, 0, "the YouTube stream is not downloadable and the torrent has no engine yet");
    assert.equal(entry?.name, "⬇ OFFLINE • 1080p");
    assert.equal(entry?.description, "1080p WEB-DL • 200 KB\nUpstream");
    assert.match(entry?.externalUrl ?? "", /^stremio-offline:\/\/enqueue\/[0-9a-f]{32}$/);

    assert.deepEqual((await first.get<CatalogResponse>("/catalog/movie/stremio-offline.movies.json")).metas, []);
    assert.equal((await fetch(`${first.base}/meta/movie/tt1.json`)).status, 404, "no meta until we hold something");

    const tap = await first.action(entry?.externalUrl ?? "");
    assert.equal(tap.status, 200);
    assert.deepEqual(await tap.json(), { ok: true, action: "enqueue", result: "queued 1080p WEB-DL for Test Movie" });

    const done = await untilComplete(first.runtime);
    jobId = done.id;
    assert.equal(done.media.title, "Test Movie", "title comes from the metadata lookup");
    assert.equal(done.localPath, join(home, "downloads", "Movies", "Test Movie", `Test Movie [${done.id}].mp4`));
    assert.equal(done.totalBytes, DATA.length);

    const [playable] = await first.streams();
    assert.equal(playable?.name, "✅ OFFLINE • 1080p");
    assert.equal(playable?.url, `${first.base}/media/${done.id}`);
    assert.equal(playable?.behaviorHints?.filename, `Test Movie [${done.id}].mp4`);

    const media = await fetch(playable?.url ?? "", { headers: { range: "bytes=0-9" } });
    assert.equal(media.status, 206);
    assert.ok(Buffer.from(await media.arrayBuffer()).equals(DATA.subarray(0, 10)));

    const catalog = await first.get<CatalogResponse>("/catalog/movie/stremio-offline.movies.json");
    assert.deepEqual(
      catalog.metas.map((meta) => [meta.id, meta.name, meta.poster]),
      [["tt1", "Test Movie", "https://img/p.jpg"]],
    );
    assert.equal((await first.get<MetaResponse>("/meta/movie/tt1.json")).meta.name, "Test Movie");

    const again = await first.action(entry?.externalUrl ?? "");
    assert.equal(again.status, 200, "tapping a finished entry again is harmless");
    assert.equal((await first.runtime.manager.list()).length, 1);

    const stale = await first.action("stremio-offline://enqueue/deadbeef");
    assert.equal(stale.status, 400);
    assert.match(((await stale.json()) as { error: string }).error, /expired/);

    const jobs = await fetch(`${first.base}/api/jobs`, { headers: AUTH });
    assert.equal(((await jobs.json()) as { jobs: unknown[] }).jobs.length, 1);
    assert.equal((await fetch(`${first.base}/api/jobs`)).status, 401);
  } finally {
    await first.runtime.close();
  }

  // Same home, new process, no upstream reachable: what was downloaded is still offered and still plays.
  const offline: FetchLike = async () => {
    throw new Error("offline");
  };
  const second = await startRuntime(home, config, offline);
  try {
    const [playable, ...rest] = await second.streams();
    assert.equal(rest.length, 0);
    assert.equal(playable?.name, "✅ OFFLINE • 1080p");
    assert.equal(playable?.url, `${second.base}/media/${jobId}`);
    const head = await fetch(playable?.url ?? "", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(DATA.length));
    assert.equal((await second.get<CatalogResponse>("/catalog/movie/stremio-offline.movies.json")).metas[0]?.name, "Test Movie");
    assert.equal((await second.get<MetaResponse>("/meta/movie/tt1.json")).meta.poster, "https://img/p.jpg");
  } finally {
    await second.runtime.close();
    await content.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a download that cannot fit is refused before anything is written", async () => {
  const home = await mkdtemp(join(tmpdir(), "so-space-"));
  const content = await contentServer();
  const config: RuntimeConfig = {
    version: 1,
    port: 0,
    secret: SECRET,
    storageDir: join(home, "downloads"),
    sources: [
      {
        id: "up",
        name: "Upstream",
        manifestUrl: "https://up.example/manifest.json",
        transportUrl: "https://up.example",
        enabled: true,
      },
    ],
  };
  await writeConfig(home, config);

  const full = await startRuntime(home, config, upstreamFor(content.url), { freeSpace: async () => 1024 });
  try {
    const [entry] = await full.streams();
    const refused = await full.action(entry?.externalUrl ?? "");
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /not enough space.*needs 200 KB.*1 KB free/);
    assert.deepEqual(await full.runtime.manager.list(), [], "nothing is queued and nothing is on disk");
  } finally {
    await full.runtime.close();
  }

  // The same tap succeeds once the space is there, and an unreadable disk never blocks a download.
  const unknown = await startRuntime(home, config, upstreamFor(content.url), {
    freeSpace: async () => {
      throw new Error("statfs failed");
    },
  });
  try {
    const [entry] = await unknown.streams();
    assert.equal((await unknown.action(entry?.externalUrl ?? "")).status, 200);
    await untilComplete(unknown.runtime);
  } finally {
    await unknown.runtime.close();
    await content.close();
    await rm(home, { recursive: true, force: true });
  }
});
