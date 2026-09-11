import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, ADDON_ID } from "./manifest.ts";
import { createAddonRouter, type AddonHandlers } from "./router.ts";

function makeRouter(overrides: Partial<AddonHandlers> = {}, onError?: (path: string, error: unknown) => void) {
  const calls: string[] = [];
  const handlers: AddonHandlers = {
    manifest: () => buildManifest({ version: "0.0.1" }),
    stream: async (type, id) => {
      calls.push(`stream:${type}:${id}`);
      return { streams: [] };
    },
    catalog: async (type, id, extra) => {
      calls.push(`catalog:${type}:${id}:${JSON.stringify(extra)}`);
      return { metas: [] };
    },
    meta: async (type, id) => (id === "tt1" ? { meta: { id, type, name: "One" } } : null),
    ...overrides,
  };
  const options = onError ? { onError } : {};
  return { router: createAddonRouter(handlers, options), calls };
}

test("serves the manifest with CORS headers", async () => {
  const { router } = makeRouter();
  const res = await router({ method: "GET", path: "/manifest.json" });
  assert.equal(res?.status, 200);
  assert.equal(res?.headers["Access-Control-Allow-Origin"], "*");
  assert.equal(JSON.parse(res?.body ?? "{}").id, ADDON_ID);
});

test("routes stream requests and decodes ids", async () => {
  const { router, calls } = makeRouter();
  const res = await router({ method: "GET", path: "/stream/series/tt11280740%3A2%3A4.json" });
  assert.equal(res?.status, 200);
  assert.deepEqual(calls, ["stream:series:tt11280740:2:4"]);
});

test("routes catalog requests with extra", async () => {
  const { router, calls } = makeRouter();
  const res = await router({ method: "GET", path: "/catalog/movie/stremio-offline.movies/search=dune&skip=20.json" });
  assert.equal(res?.status, 200);
  assert.deepEqual(calls, ['catalog:movie:stremio-offline.movies:{"search":"dune","skip":"20"}']);
});

test("meta returns 404 when the handler has nothing", async () => {
  const { router } = makeRouter();
  assert.equal((await router({ method: "GET", path: "/meta/movie/tt1.json" }))?.status, 200);
  assert.equal((await router({ method: "GET", path: "/meta/movie/tt2.json" }))?.status, 404);
});

test("ignores non-addon paths and rejects unsupported types", async () => {
  const { router } = makeRouter();
  assert.equal(await router({ method: "GET", path: "/media/abc" }), null);
  assert.equal(await router({ method: "GET", path: "/api/health" }), null);
  assert.equal(await router({ method: "GET", path: "/" }), null);
  assert.equal((await router({ method: "GET", path: "/stream/tv/abc.json" }))?.status, 404);
});

test("answers CORS preflight", async () => {
  const { router } = makeRouter();
  const res = await router({ method: "OPTIONS", path: "/stream/movie/tt1.json" });
  assert.equal(res?.status, 204);
  assert.equal(res?.headers["Access-Control-Allow-Origin"], "*");
});

test("handler failures become 500 and are reported", async () => {
  const seen: string[] = [];
  const { router } = makeRouter(
    {
      stream: async () => {
        throw new Error("boom");
      },
    },
    (path) => seen.push(path),
  );
  const res = await router({ method: "GET", path: "/stream/movie/tt1.json" });
  assert.equal(res?.status, 500);
  assert.deepEqual(seen, ["/stream/movie/tt1.json"]);
});
