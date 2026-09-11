import { test } from "node:test";
import assert from "node:assert/strict";
import { detectQuality, normalizeStream, parseMagnet, parseSizeText, toOfflineSource } from "./source-normalizer.ts";

const HASH = "0123456789abcdef0123456789abcdef01234567";
const GB = 1024 ** 3;

test("torrent stream with infoHash, fileIdx and trackers", () => {
  const normalized = normalizeStream(
    {
      name: "Torrentio\n1080p",
      title: "Interstellar.2014.1080p.WEB-DL.x265\n👤 120 💾 9.38 GB ⚙️ ThePirateBay",
      infoHash: HASH.toUpperCase(),
      fileIdx: 2,
      sources: ["tracker:udp://tracker.example:1337/announce", "dht:" + HASH],
      behaviorHints: { filename: "Interstellar.2014.1080p.WEB-DL.x265.mkv", bingeGroup: "x" },
    },
    "Torrentio",
  );
  assert.ok(normalized);
  assert.deepEqual(normalized.source, {
    type: "torrent",
    infoHash: HASH,
    fileIdx: 2,
    trackers: ["udp://tracker.example:1337/announce"],
    filename: "Interstellar.2014.1080p.WEB-DL.x265.mkv",
    size: Math.round(9.38 * GB),
  });
  assert.equal(normalized.key, `torrent:${HASH}:2`);
  assert.equal(normalized.quality, "1080p");
  assert.equal(normalized.label, "1080p WEB-DL HEVC");
  assert.deepEqual(normalized.providers, ["Torrentio"]);
  assert.equal(normalized.size, Math.round(9.38 * GB));
});

test("magnet urls become torrent sources", () => {
  const magnet = `magnet:?xt=urn:btih:${HASH}&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ft.example%3A80`;
  assert.deepEqual(parseMagnet(magnet), {
    type: "torrent",
    infoHash: HASH,
    trackers: ["udp://t.example:80"],
    filename: "Big Buck Bunny",
  });
  assert.equal(toOfflineSource({ url: magnet })?.type, "torrent");
  assert.equal(parseMagnet("magnet:?dn=nothing"), null);
});

test("http stream keeps proxy request headers and videoSize", () => {
  const normalized = normalizeStream(
    {
      url: "https://cdn.example/movie.mkv",
      title: "4K HDR REMUX",
      behaviorHints: { proxyHeaders: { request: { Authorization: "Bearer x" } }, videoSize: 61 * GB },
    },
    "MyAddon",
  );
  assert.ok(normalized);
  assert.deepEqual(normalized.source, {
    type: "http",
    url: "https://cdn.example/movie.mkv",
    requestHeaders: { Authorization: "Bearer x" },
    size: 61 * GB,
  });
  assert.equal(normalized.quality, "4K");
  assert.equal(normalized.label, "4K REMUX HDR");
});

test("non-downloadable streams are skipped", () => {
  assert.equal(toOfflineSource({ ytId: "dQw4w9WgXcQ" }), null);
  assert.equal(toOfflineSource({ externalUrl: "https://netflix.com/x" }), null);
  assert.equal(toOfflineSource({ url: "rtmp://live.example/stream" }), null);
  assert.equal(toOfflineSource({ infoHash: "not-a-hash" }), null);
});

test("quality and size detection", () => {
  assert.equal(detectQuality("Movie 2160p BluRay"), "4K");
  assert.equal(detectQuality("Movie HDCAM"), "CAM");
  assert.equal(detectQuality("plain"), undefined);
  assert.equal(parseSizeText("💾 700 MB"), 700 * 1024 ** 2);
  assert.equal(parseSizeText("size 1,5 GB"), Math.round(1.5 * GB));
  assert.equal(parseSizeText("no size"), undefined);
});

test("falls back to the title when nothing is detected", () => {
  const normalized = normalizeStream({ infoHash: HASH, title: "Some Release Name\nsecond line" }, "X");
  assert.equal(normalized?.label, "Some Release Name");
  assert.equal(normalized?.quality, undefined);
});
