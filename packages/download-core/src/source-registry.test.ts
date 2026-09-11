import { test } from "node:test";
import assert from "node:assert/strict";
import type { JobMedia, NormalizedSource } from "@stremio-offline/models";
import { SourceRegistry } from "./source-registry.ts";

const source: NormalizedSource = {
  key: "torrent:abc:0",
  source: { type: "torrent", infoHash: "abc", fileIdx: 0 },
  providers: ["Torrentio"],
  label: "1080p",
};
const movie: JobMedia = { type: "movie", mediaId: "tt1", videoId: "tt1", title: "Movie" };
const episode: JobMedia = { type: "series", mediaId: "tt2", videoId: "tt2:1:1", season: 1, episode: 1, title: "Show" };

test("same source for the same media reuses the token", () => {
  const registry = new SourceRegistry();
  const first = registry.register(source, movie);
  const again = registry.register({ ...source, providers: ["Torrentio", "TPB+"] }, movie);
  assert.equal(first, again);
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.deepEqual(registry.resolve(first)?.source.providers, ["Torrentio", "TPB+"]);
  assert.notEqual(registry.register(source, episode), first);
  assert.equal(registry.size, 2);
});

test("tokens expire after the ttl and are refreshed on re-register", () => {
  let now = 1000;
  const registry = new SourceRegistry({ ttlMs: 100, now: () => now });
  const token = registry.register(source, movie);
  now = 1050;
  assert.ok(registry.resolve(token));
  registry.register(source, movie);
  now = 1140;
  assert.ok(registry.resolve(token), "refreshed token still valid");
  now = 1300;
  assert.equal(registry.resolve(token), undefined);
  assert.equal(registry.size, 0);
});

test("unknown tokens resolve to nothing", () => {
  assert.equal(new SourceRegistry().resolve("nope"), undefined);
});
