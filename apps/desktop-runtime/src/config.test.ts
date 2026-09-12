import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, configPath, loadOrCreateConfig, readConfig, runtimeHome } from "./config.ts";

test("runtimeHome honours STREMIO_OFFLINE_HOME", () => {
  assert.equal(runtimeHome({ STREMIO_OFFLINE_HOME: "/x/y" }), "/x/y");
  assert.match(runtimeHome({}), /\.stremio-offline$/);
});

test("loadOrCreateConfig mints the install secret once and keeps it across port changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "so-home-"));
  try {
    const first = await loadOrCreateConfig(home);
    assert.match(first.secret, /^[0-9a-f]{64}$/);
    assert.equal(first.port, DEFAULT_PORT);

    const second = await loadOrCreateConfig(home, 4000);
    assert.equal(second.secret, first.secret);
    assert.equal(second.port, 4000);
    assert.deepEqual(await readConfig(home), second);
    assert.deepEqual(JSON.parse(await readFile(configPath(home), "utf8")), second);

    assert.equal(await readConfig(join(home, "missing")), undefined);
    await writeFile(configPath(home), '{"port":"nope"}');
    await assert.rejects(readConfig(home), /malformed/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
