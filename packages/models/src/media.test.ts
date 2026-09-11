import { test } from "node:test";
import assert from "node:assert/strict";
import { isMediaType, mediaScopeKey, parseMediaId } from "./media.ts";

test("parseMediaId: series episode id carries season and episode", () => {
  assert.deepEqual(parseMediaId("series", "tt11280740:2:4"), {
    type: "series",
    mediaId: "tt11280740",
    videoId: "tt11280740:2:4",
    season: 2,
    episode: 4,
  });
});

test("parseMediaId: movie id maps videoId to itself", () => {
  assert.deepEqual(parseMediaId("movie", "tt0816692"), {
    type: "movie",
    mediaId: "tt0816692",
    videoId: "tt0816692",
  });
});

test("parseMediaId: series id without episode keeps mediaId", () => {
  assert.deepEqual(parseMediaId("series", "tt11280740"), {
    type: "series",
    mediaId: "tt11280740",
    videoId: "tt11280740",
  });
});

test("mediaScopeKey distinguishes episodes", () => {
  assert.equal(mediaScopeKey(parseMediaId("series", "tt1:1:1")), "series:tt1:1:1");
  assert.notEqual(
    mediaScopeKey(parseMediaId("series", "tt1:1:1")),
    mediaScopeKey(parseMediaId("series", "tt1:1:2")),
  );
});

test("isMediaType accepts only movie and series", () => {
  assert.ok(isMediaType("movie"));
  assert.ok(isMediaType("series"));
  assert.ok(!isMediaType("tv"));
});
