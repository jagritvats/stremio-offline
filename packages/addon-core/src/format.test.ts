import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatPercent } from "./format.ts";

test("formatBytes", () => {
  assert.equal(formatBytes(undefined), undefined);
  assert.equal(formatBytes(-1), undefined);
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "2 KB");
  assert.equal(formatBytes(700 * 1024 ** 2), "700 MB");
  assert.equal(formatBytes(9.4 * 1024 ** 3), "9.4 GB");
  assert.equal(formatBytes(120 * 1024 ** 3), "120 GB");
});

test("formatPercent", () => {
  assert.equal(formatPercent(5, undefined), undefined);
  assert.equal(formatPercent(5, 0), undefined);
  assert.equal(formatPercent(58, 100), "58%");
  assert.equal(formatPercent(999, 100), "100%");
});
