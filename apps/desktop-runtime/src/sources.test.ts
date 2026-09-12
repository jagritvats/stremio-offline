import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpstreamClient, type FetchLike } from "@stremio-offline/addon-proxy";
import { readConfig } from "./config.ts";
import { addSource, describeSource, listSources, removeSource, setSourceEnabled, setStorageDir } from "./sources.ts";

const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });

const manifests: FetchLike = async (url) => {
  if (url === "https://torrentio.example/key=secret/manifest.json") return ok({ id: "t", name: "Torrentio", resources: ["stream"] });
  if (url === "https://meta.example/manifest.json") return ok({ id: "m", name: "Meta Only", resources: [{ name: "meta", types: ["movie"] }] });
  return { ok: false, status: 404, json: async () => ({}) };
};

test("sources: add validates the manifest and dedupes by transport url; list, enable, remove, storage", async () => {
  const home = await mkdtemp(join(tmpdir(), "so-sources-"));
  const client = new UpstreamClient({ fetch: manifests });
  try {
    const added = await addSource(home, client, " stremio://torrentio.example/key=secret/manifest.json ");
    assert.equal(added.name, "Torrentio");
    assert.equal(added.manifestUrl, "https://torrentio.example/key=secret/manifest.json");
    assert.equal(added.transportUrl, "https://torrentio.example/key=secret");
    assert.match(added.id, /^[0-9a-f]{6}$/);
    assert.equal(describeSource(added), `${added.id}  on   Torrentio  (torrentio.example)`, "never the path, which can hold a key");

    const again = await addSource(home, client, "https://torrentio.example/key=secret/manifest.json");
    assert.equal(again.id, added.id);
    assert.equal((await listSources(home)).length, 1);

    await assert.rejects(addSource(home, client, "https://meta.example/manifest.json"), /does not serve streams/);
    await assert.rejects(addSource(home, client, "https://nope.example/manifest.json"), (error: Error) => {
      assert.equal(error.message, "upstream responded 404");
      return true;
    });
    await assert.rejects(addSource(home, client, "ftp://x/manifest.json"), /http\(s\)/);

    assert.equal(await setSourceEnabled(home, added.id, false), true);
    assert.equal((await listSources(home))[0]?.enabled, false);
    assert.equal(await setSourceEnabled(home, "zzzzzz", true), false);

    assert.equal(await removeSource(home, added.id), true);
    assert.equal(await removeSource(home, added.id), false);
    assert.deepEqual(await listSources(home), []);

    const dir = await setStorageDir(home, join(home, "dl", "nested"));
    assert.equal((await readConfig(home))?.storageDir, dir);
    assert.ok((await stat(dir)).isDirectory());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
