import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceKey, transportUrlFromManifestUrl } from "./source.ts";

test("sourceKey normalises torrent identity", () => {
  const hash = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
  assert.equal(sourceKey({ type: "torrent", infoHash: hash, fileIdx: 3 }), `torrent:${hash.toLowerCase()}:3`);
  assert.equal(sourceKey({ type: "torrent", infoHash: hash }), `torrent:${hash.toLowerCase()}:-`);
  assert.equal(sourceKey({ type: "http", url: "https://x/y.mkv" }), "http:https://x/y.mkv");
});

test("transportUrlFromManifestUrl strips manifest.json and stremio scheme", () => {
  assert.equal(transportUrlFromManifestUrl("https://torrentio.strem.fun/manifest.json"), "https://torrentio.strem.fun");
  assert.equal(transportUrlFromManifestUrl("stremio://example.com/cfg/manifest.json"), "https://example.com/cfg");
  assert.equal(transportUrlFromManifestUrl("https://example.com/addon/"), "https://example.com/addon");
  assert.equal(transportUrlFromManifestUrl("https://example.com/manifest.json?x=1"), "https://example.com");
});
