import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PORT,
  configPath,
  defaultStorageDir,
  loadOrCreateConfig,
  readConfig,
  runtimeHome,
  updateConfig,
} from "./config.ts";

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
    assert.equal(first.storageDir, defaultStorageDir());
    assert.deepEqual(first.sources, []);

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

test("readConfig fills defaults for an older file, drops malformed sources, and updateConfig persists edits", async () => {
  const home = await mkdtemp(join(tmpdir(), "so-home-"));
  try {
    const secret = "a".repeat(64);
    const good = { id: "ok", name: "N", manifestUrl: "https://m/x/manifest.json", transportUrl: "https://m/x", enabled: true };
    await writeFile(configPath(home), JSON.stringify({ version: 1, port: 1234, secret, sources: [{ id: "junk" }, good, "x"] }));
    const config = await readConfig(home);
    assert.equal(config?.port, 1234);
    assert.equal(config?.storageDir, defaultStorageDir());
    assert.deepEqual(config?.sources, [good]);

    const updated = await updateConfig(home, (current) => {
      current.storageDir = "/somewhere";
      current.sources[0]!.enabled = false;
    });
    assert.equal(updated.secret, secret);
    const reread = await readConfig(home);
    assert.equal(reread?.storageDir, "/somewhere");
    assert.equal(reread?.sources[0]?.enabled, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
