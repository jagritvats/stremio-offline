import { test } from "node:test";
import assert from "node:assert/strict";
import { parseActionUri } from "./action.ts";

test("parseActionUri reads action, path args and query params", () => {
  assert.deepEqual(parseActionUri("stremio-offline://test?id=123"), { action: "test", args: [], params: { id: "123" } });
  assert.deepEqual(parseActionUri("stremio-offline://enqueue/a%20b/c"), { action: "enqueue", args: ["a b", "c"], params: {} });
  assert.deepEqual(parseActionUri(" stremio-offline://Test/?id=tt1%3A2%3A4 "), {
    action: "test",
    args: [],
    params: { id: "tt1:2:4" },
  });
});

test("parseActionUri rejects other schemes and malformed input", () => {
  assert.equal(parseActionUri("https://example.com/enqueue/x"), null);
  assert.equal(parseActionUri("stremio-offline://"), null);
  assert.equal(parseActionUri("stremio-offline:test"), null);
  assert.equal(parseActionUri("not a uri"), null);
});
