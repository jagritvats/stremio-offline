import { test } from "node:test";
import assert from "node:assert/strict";
import { UpstreamClient, UpstreamError, metaUrl, type FetchLike } from "./upstream-client.ts";

const cinemeta = { id: "cinemeta", transportUrl: "https://cinemeta.example/" };

const fakeFetch: FetchLike = async (url) => {
  if (url.endsWith("/meta/movie/tt1.json")) {
    return { ok: true, status: 200, json: async () => ({ meta: { id: "tt1", type: "movie", name: "One", poster: "p" } }) };
  }
  if (url.endsWith("/meta/movie/tt2.json")) return { ok: false, status: 404, json: async () => ({}) };
  if (url.endsWith("/meta/movie/tt3.json")) return { ok: true, status: 200, json: async () => ({ meta: null }) };
  return { ok: false, status: 500, json: async () => ({}) };
};

test("metaUrl encodes the id", () => {
  assert.equal(metaUrl("https://cinemeta.example/", "series", "tt1:2:3"), "https://cinemeta.example/meta/series/tt1%3A2%3A3.json");
});

test("fetchMeta returns the meta, null when there is none, and throws on failure", async () => {
  const client = new UpstreamClient({ fetch: fakeFetch });
  assert.deepEqual(await client.fetchMeta(cinemeta, "movie", "tt1"), { id: "tt1", type: "movie", name: "One", poster: "p" });
  assert.equal(await client.fetchMeta(cinemeta, "movie", "tt2"), null);
  assert.equal(await client.fetchMeta(cinemeta, "movie", "tt3"), null);
  await assert.rejects(client.fetchMeta(cinemeta, "movie", "tt4"), (error: unknown) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.status, 500);
    assert.ok(!error.message.includes("cinemeta.example"));
    return true;
  });
});
