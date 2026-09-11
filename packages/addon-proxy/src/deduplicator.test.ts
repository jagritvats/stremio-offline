import { test } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedSource } from "@stremio-offline/models";
import { dedupeSources, sortSources } from "./deduplicator.ts";

const GB = 1024 ** 3;

function torrent(hash: string, fileIdx: number, provider: string, extra: Partial<NormalizedSource> = {}): NormalizedSource {
  return {
    key: `torrent:${hash}:${fileIdx}`,
    source: { type: "torrent", infoHash: hash, fileIdx },
    providers: [provider],
    label: "Unknown quality",
    ...extra,
  };
}

test("merges the same torrent from several providers", () => {
  const merged = dedupeSources([
    torrent("aaa", 1, "Torrentio", { quality: "1080p", label: "1080p WEB-DL", size: 8 * GB }),
    torrent("aaa", 1, "TPB+"),
    torrent("aaa", 1, "Torrentio"),
    torrent("aaa", 2, "TPB+"),
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0]?.providers, ["Torrentio", "TPB+"]);
  assert.equal(merged[0]?.label, "1080p WEB-DL");
  assert.equal(merged[0]?.size, 8 * GB);
});

test("fills in missing details from later duplicates", () => {
  const merged = dedupeSources([
    torrent("bbb", 0, "A"),
    torrent("bbb", 0, "B", { quality: "720p", label: "720p", size: 2 * GB, tags: ["HDTV"] }),
  ]);
  assert.equal(merged[0]?.quality, "720p");
  assert.equal(merged[0]?.label, "720p");
  assert.equal(merged[0]?.size, 2 * GB);
  assert.equal(merged[0]?.source.size, 2 * GB);
  assert.deepEqual(merged[0]?.tags, ["HDTV"]);
});

test("sorts best quality first, then larger", () => {
  const sorted = sortSources([
    torrent("1", 0, "A", { quality: "CAM" }),
    torrent("2", 0, "A", { quality: "1080p", size: 4 * GB }),
    torrent("3", 0, "A"),
    torrent("4", 0, "A", { quality: "4K" }),
    torrent("5", 0, "A", { quality: "1080p", size: 9 * GB }),
  ]);
  assert.deepEqual(
    sorted.map((source) => source.key),
    ["torrent:4:0", "torrent:5:0", "torrent:2:0", "torrent:3:0", "torrent:1:0"],
  );
});
