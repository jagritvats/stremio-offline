import { test } from "node:test";
import assert from "node:assert/strict";
import type { DownloadJob, NormalizedSource } from "@stremio-offline/models";
import { actionUri, completedStream, downloadActionStream, jobStatusStream } from "./presenter.ts";

const opts = { mediaBaseUrl: "http://127.0.0.1:34701" };
const GB = 1024 ** 3;

const source: NormalizedSource = {
  key: "torrent:abc:1",
  source: { type: "torrent", infoHash: "abc", fileIdx: 1 },
  providers: ["Torrentio", "TPB+"],
  label: "1080p WEB-DL",
  quality: "1080p",
  size: 9.4 * GB,
};

function job(overrides: Partial<DownloadJob>): DownloadJob {
  return {
    id: "job1",
    media: { type: "movie", mediaId: "tt1", videoId: "tt1", title: "Interstellar" },
    source: source.source,
    sourceKey: source.key,
    label: source.label,
    quality: "1080p",
    status: "queued",
    bytesDownloaded: 0,
    totalBytes: 8 * GB,
    localPath: "D:\\Movies\\Interstellar\\Interstellar.1080p.mkv",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("actionUri encodes parts", () => {
  assert.equal(actionUri("stremio-offline", "enqueue", "a b"), "stremio-offline://enqueue/a%20b");
  assert.equal(actionUri("stremio-offline", "test"), "stremio-offline://test");
});

test("download action stream carries the token, size and providers", () => {
  const stream = downloadActionStream(source, "tok123", opts);
  assert.equal(stream.name, "⬇ OFFLINE • 1080p");
  assert.equal(stream.externalUrl, "stremio-offline://enqueue/tok123");
  assert.equal(stream.description, "1080p WEB-DL • 9.4 GB\nTorrentio + TPB+");
  assert.equal(stream.url, undefined);
});

test("completed stream points Stremio's player at the media endpoint", () => {
  const stream = completedStream(job({ status: "complete", bytesDownloaded: 8 * GB }), opts);
  assert.equal(stream.name, "✅ OFFLINE • 1080p");
  assert.equal(stream.url, "http://127.0.0.1:34701/media/job1");
  assert.equal(stream.behaviorHints?.filename, "Interstellar.1080p.mkv");
  assert.equal(stream.behaviorHints?.videoSize, 8 * GB);
  assert.match(stream.description ?? "", /Stored on this device/);
});

test("in-progress stream shows percentage and pause action", () => {
  const stream = jobStatusStream(job({ status: "downloading", bytesDownloaded: 4.64 * GB }), opts);
  assert.equal(stream.name, "⏳ 58% DOWNLOADED");
  assert.equal(stream.externalUrl, "stremio-offline://pause/job1");
  assert.match(stream.description ?? "", /4\.6 GB \/ 8\.0 GB/);
});

test("paused and failed jobs get resume and retry actions", () => {
  assert.equal(jobStatusStream(job({ status: "paused", bytesDownloaded: 2 * GB }), opts).externalUrl, "stremio-offline://resume/job1");
  const failed = jobStatusStream(job({ status: "error", error: "no peers" }), opts);
  assert.equal(failed.name, "⚠ FAILED");
  assert.match(failed.description ?? "", /no peers/);
  assert.equal(failed.externalUrl, "stremio-offline://retry/job1");
});
