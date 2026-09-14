import { test } from "node:test";
import assert from "node:assert/strict";
import type { DownloadJob } from "@stremio-offline/models";
import { jobsTable, resolveJobId, shortId } from "./jobs-table.ts";

const GB = 1024 ** 3;

function job(overrides: Partial<DownloadJob> & Pick<DownloadJob, "id">): DownloadJob {
  return {
    media: { type: "movie", mediaId: "tt1", videoId: "tt1", title: "Interstellar" },
    source: { type: "http", url: "https://secret.example/key/movie.mkv" },
    sourceKey: "http:https://secret.example/key/movie.mkv",
    label: "1080p WEB-DL",
    status: "queued",
    bytesDownloaded: 0,
    totalBytes: 8 * GB,
    localPath: "/store/movie.mkv",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("jobsTable lines up columns, shows progress per status and never prints a url", () => {
  const lines = jobsTable([
    job({ id: "aaaaaaaabbbb", status: "downloading", bytesDownloaded: 4 * GB, updatedAt: 30 }),
    job({ id: "ccccccccdddd", status: "complete", bytesDownloaded: 8 * GB, updatedAt: 20 }),
    job({
      id: "eeeeeeeeffff",
      status: "error",
      error: "upstream responded 503",
      updatedAt: 10,
      media: { type: "series", mediaId: "tt2", videoId: "tt2:2:4", season: 2, episode: 4, title: "Severance" },
    }),
  ]);

  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /^aaaaaaaa {2}downloading {2}50% {2}4\.0 GB \/ 8\.0 GB {2}Interstellar • 1080p WEB-DL$/);
  assert.match(lines[1] ?? "", /^cccccccc {2}complete {5}8\.0 GB/);
  assert.match(lines[2] ?? "", /Severance S02E04 • 1080p WEB-DL {2}\(upstream responded 503\)$/);
  assert.ok(!lines.join("\n").includes("secret.example"), "a source url never reaches the terminal");

  // Newest first, and the columns are a constant width apart.
  const columns = lines.map((line) => line.indexOf("Interstellar • ") + line.indexOf("Severance S"));
  assert.equal(new Set(lines.map((line) => line.length - line.trimEnd().length)).size, 1);
  assert.ok(columns.length === 3);
  assert.deepEqual(jobsTable([]), ["no downloads yet"]);
});

test("resolveJobId accepts a short id and refuses an ambiguous one", () => {
  const jobs = [job({ id: "abc123def456" }), job({ id: "abc999aaa000" }), job({ id: "ffffffffffff" })];
  assert.equal(shortId("abc123def456"), "abc123de");
  assert.equal(resolveJobId(jobs, "ffffffff"), "ffffffffffff");
  assert.equal(resolveJobId(jobs, "abc123def456"), "abc123def456");
  assert.throws(() => resolveJobId(jobs, "abc"), /matches 2 jobs/);
  assert.throws(() => resolveJobId(jobs, "nope"), /no job matches/);
});
