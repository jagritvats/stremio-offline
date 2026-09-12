import { test } from "node:test";
import assert from "node:assert/strict";
import type { DownloadJob, JobMedia, OfflineMeta } from "@stremio-offline/models";
import { buildCatalog, buildMeta, libraryMediaIds, snapshotMeta } from "./library.ts";

function job(id: string, media: JobMedia, updatedAt: number): DownloadJob {
  return {
    id,
    media,
    source: { type: "http", url: `https://x/${id}` },
    sourceKey: `http:https://x/${id}`,
    label: "1080p",
    status: "complete",
    bytesDownloaded: 1,
    totalBytes: 1,
    localPath: `/store/${id}.mkv`,
    createdAt: updatedAt,
    updatedAt,
  };
}

const jobs: DownloadJob[] = [
  job("a", { type: "movie", mediaId: "tt1", videoId: "tt1", title: "Interstellar" }, 10),
  job("b", { type: "series", mediaId: "tt2", videoId: "tt2:1:2", season: 1, episode: 2, title: "Severance" }, 5),
  job("c", { type: "series", mediaId: "tt2", videoId: "tt2:1:1", season: 1, episode: 1, title: "Severance" }, 20),
  job("d", { type: "movie", mediaId: "tt3", videoId: "tt3", title: "Dune" }, 30),
];

const interstellar: OfflineMeta = {
  type: "movie",
  imdbId: "tt1",
  title: "Interstellar (2014)",
  poster: "https://img/p.jpg",
  description: "Space.",
  savedAt: 1,
};

test("libraryMediaIds groups by title and orders by recency within a type", () => {
  assert.deepEqual(libraryMediaIds("movie", jobs), ["tt3", "tt1"]);
  assert.deepEqual(libraryMediaIds("series", jobs), ["tt2"]);
});

test("buildCatalog uses snapshots, falls back to job titles, searches and pages", () => {
  const metas = new Map([["tt1", interstellar]]);
  const all = buildCatalog("movie", jobs, metas, {});
  assert.deepEqual(all.metas, [
    { id: "tt3", type: "movie", name: "Dune", description: "Downloaded with Stremio Offline" },
    { id: "tt1", type: "movie", name: "Interstellar (2014)", posterShape: "poster", poster: "https://img/p.jpg", description: "Space." },
  ]);
  assert.deepEqual(buildCatalog("movie", jobs, metas, { search: "inter" }).metas.map((m) => m.id), ["tt1"]);
  assert.deepEqual(buildCatalog("movie", jobs, metas, { skip: "1" }).metas.map((m) => m.id), ["tt1"]);
  assert.deepEqual(buildCatalog("series", jobs, metas, {}).metas.map((m) => m.name), ["Severance"]);
});

test("buildMeta lists held episodes without a snapshot and prefers the snapshot's videos", () => {
  assert.equal(buildMeta("movie", "tt9", jobs, undefined), null);
  assert.deepEqual(buildMeta("series", "tt2", jobs, undefined), {
    meta: {
      id: "tt2",
      type: "series",
      name: "Severance",
      description: "Downloaded with Stremio Offline",
      videos: [
        { id: "tt2:1:1", title: "S01E01", season: 1, episode: 1 },
        { id: "tt2:1:2", title: "S01E02", season: 1, episode: 2 },
      ],
    },
  });
  const snapshot: OfflineMeta = {
    type: "series",
    imdbId: "tt2",
    title: "Severance",
    savedAt: 1,
    videos: [{ id: "tt2:1:1", title: "Good News About Hell", season: 1, episode: 1 }],
  };
  assert.deepEqual(buildMeta("series", "tt2", jobs, snapshot)?.meta.videos, snapshot.videos);
  assert.equal(buildMeta("movie", "tt1", jobs, interstellar)?.meta.name, "Interstellar (2014)");
});

test("snapshotMeta copies only what is present", () => {
  assert.deepEqual(snapshotMeta({ id: "tt1", type: "movie", name: "Interstellar", poster: "p" }, "movie", 7), {
    type: "movie",
    imdbId: "tt1",
    title: "Interstellar",
    poster: "p",
    savedAt: 7,
  });
});
