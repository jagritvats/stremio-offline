import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceAddon } from "@stremio-offline/models";
import { collectOfflineSources } from "./aggregator.ts";
import { UpstreamClient, streamsUrl, type FetchLike } from "./upstream-client.ts";

const HASH = "0123456789abcdef0123456789abcdef01234567";

const addons: SourceAddon[] = [
  { id: "a", name: "Torrentio", manifestUrl: "https://a.example/manifest.json", transportUrl: "https://a.example", enabled: true },
  { id: "b", name: "TPB+", manifestUrl: "https://b.example/manifest.json", transportUrl: "https://b.example", enabled: true },
  { id: "c", name: "Broken", manifestUrl: "https://c.example/manifest.json", transportUrl: "https://c.example", enabled: true },
  { id: "d", name: "Disabled", manifestUrl: "https://d.example/manifest.json", transportUrl: "https://d.example", enabled: false },
];

const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });

const requested: string[] = [];
const fakeFetch: FetchLike = async (url) => {
  requested.push(url);
  if (url.startsWith("https://a.example/")) {
    return ok({ streams: [{ infoHash: HASH, fileIdx: 0, title: "Movie 1080p WEB-DL\n💾 4.2 GB" }] });
  }
  if (url.startsWith("https://b.example/")) {
    return ok({ streams: [{ infoHash: HASH, fileIdx: 0, title: "Movie 1080p" }, { ytId: "abc" }] });
  }
  return { ok: false, status: 500, json: async () => ({}) };
};

test("streamsUrl encodes the id", () => {
  assert.equal(streamsUrl("https://a.example/", "series", "tt1:2:3"), "https://a.example/stream/series/tt1%3A2%3A3.json");
});

test("aggregates, dedupes and reports per-addon errors", async () => {
  const client = new UpstreamClient({ fetch: fakeFetch });
  const result = await collectOfflineSources(client, addons, "movie", "tt0816692");

  assert.equal(result.sources.length, 1);
  assert.deepEqual(result.sources[0]?.providers, ["Torrentio", "TPB+"]);
  assert.equal(result.sources[0]?.label, "1080p WEB-DL");
  assert.deepEqual(result.errors, [{ addonId: "c", message: "upstream responded 500" }]);
  assert.ok(!requested.some((url) => url.startsWith("https://d.example/")), "disabled addons are not queried");
});

test("timeouts surface as upstream errors without the url", async () => {
  const hanging: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  const client = new UpstreamClient({ fetch: hanging, timeoutMs: 10 });
  const result = await collectOfflineSources(client, [addons[0]!], "movie", "tt1");
  assert.deepEqual(result.errors, [{ addonId: "a", message: "upstream timed out" }]);
});
