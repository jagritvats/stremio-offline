import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalServer, listen } from "./http.ts";
import { contentTypeFor, mediaRoute, parseRange } from "./media.ts";

test("parseRange handles the forms a player sends", () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=0-500", 100), { start: 0, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=50-40", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=0-", 0), "unsatisfiable");
  assert.equal(parseRange("bytes=0-9,20-29", 100), null, "multi-range is ignored, not rejected");
  assert.equal(parseRange("items=0-9", 100), null);
  assert.equal(contentTypeFor("/x/Movie.MKV"), "video/x-matroska");
  assert.equal(contentTypeFor("/x/blob"), "application/octet-stream");
});

test("media route serves whole files and byte ranges, for resolvable jobs only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "so-media-"));
  const file = join(dir, "movie.mp4");
  const data = randomBytes(1000);
  await writeFile(file, data);
  const server = createLocalServer([
    mediaRoute(async (id) => {
      if (id === "done") return { path: file };
      if (id === "gone") return { path: join(dir, "missing.mp4") };
      return undefined;
    }),
  ]);
  const { port } = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const head = await fetch(`${base}/media/done`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "1000");
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.equal(head.headers.get("content-type"), "video/mp4");
    assert.equal(head.headers.get("access-control-allow-origin"), "*");

    const full = await fetch(`${base}/media/done`);
    assert.equal(full.status, 200);
    assert.ok(Buffer.from(await full.arrayBuffer()).equals(data));

    const middle = await fetch(`${base}/media/done`, { headers: { range: "bytes=10-19" } });
    assert.equal(middle.status, 206);
    assert.equal(middle.headers.get("content-range"), "bytes 10-19/1000");
    assert.equal(middle.headers.get("content-length"), "10");
    assert.ok(Buffer.from(await middle.arrayBuffer()).equals(data.subarray(10, 20)));

    const tail = await fetch(`${base}/media/done`, { headers: { range: "bytes=990-" } });
    assert.equal(tail.status, 206);
    assert.ok(Buffer.from(await tail.arrayBuffer()).equals(data.subarray(990)));

    const beyond = await fetch(`${base}/media/done`, { headers: { range: "bytes=1000-" } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get("content-range"), "bytes */1000");

    assert.equal((await fetch(`${base}/media/other`)).status, 404);
    assert.equal((await fetch(`${base}/media/gone`)).status, 404);
    assert.equal((await fetch(`${base}/media/done`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/media/done`, { method: "OPTIONS" })).status, 204);
    assert.equal((await fetch(`${base}/media`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
