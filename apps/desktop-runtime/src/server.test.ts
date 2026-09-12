import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDON_ID, listen } from "@stremio-offline/addon-core";
import type { StremioManifest, StremioStream } from "@stremio-offline/models";
import { createRuntimeServer } from "./server.ts";
import { spike1Action, spike1Handlers, type Spike1State } from "./spike1.ts";

const SECRET = "0".repeat(64);
const auth = { authorization: `Bearer ${SECRET}` };
const TEST_URI = "stremio-offline://test?id=tt0816692";

async function startSpike1() {
  const state: Spike1State = { received: 0 };
  const server = createRuntimeServer({
    secret: SECRET,
    version: "0.0.1",
    handlers: spike1Handlers(state, "0.0.1"),
    onAction: (action) => spike1Action(state, action, () => 0),
  });
  const { port } = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  const streams = async (): Promise<StremioStream[]> => {
    const res = await fetch(`${base}/stream/movie/tt0816692.json`);
    return ((await res.json()) as { streams: StremioStream[] }).streams;
  };
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return { base, state, streams, close };
}

test("spike 1: addon routes are public and the entry flips once an action arrives", async () => {
  const rt = await startSpike1();
  try {
    const manifestRes = await fetch(`${rt.base}/manifest.json`);
    assert.equal(manifestRes.headers.get("access-control-allow-origin"), "*");
    const manifest = (await manifestRes.json()) as StremioManifest;
    assert.equal(manifest.id, ADDON_ID);
    assert.deepEqual(manifest.resources, ["stream"]);

    const [before] = await rt.streams();
    assert.equal(before?.name, "⬇ TEST DOWNLOAD");
    assert.equal(before?.externalUrl, TEST_URI);
    assert.equal(before?.url, undefined);

    const ok = await fetch(`${rt.base}/api/action`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ uri: TEST_URI }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      ok: true,
      action: "test",
      result: "received test action for tt0816692 (1 so far)",
    });
    assert.equal(rt.state.received, 1);

    const [after] = await rt.streams();
    assert.equal(after?.name, "✅ HANDLER OK");
    assert.match(after?.description ?? "", /last for tt0816692/);
    assert.equal(after?.externalUrl, TEST_URI);
  } finally {
    await rt.close();
  }
});

test("/api/* requires the install secret and validates the action body", async () => {
  const rt = await startSpike1();
  try {
    const anonymous = await fetch(`${rt.base}/api/action`, { method: "POST", body: JSON.stringify({ uri: TEST_URI }) });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("access-control-allow-origin"), null, "no CORS on the privileged surface");
    assert.equal((await fetch(`${rt.base}/api/health`, { headers: { authorization: "Bearer nope" } })).status, 401);
    assert.equal(rt.state.received, 0);

    const health = await fetch(`${rt.base}/api/health`, { headers: auth });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, version: "0.0.1" });

    const post = (body: string) => fetch(`${rt.base}/api/action`, { method: "POST", headers: auth, body });
    assert.equal((await post("{ not json")).status, 400);
    assert.equal((await post(JSON.stringify({ uri: "https://example.com" }))).status, 400);
    assert.equal((await post(JSON.stringify({}))).status, 400);
    assert.equal((await fetch(`${rt.base}/api/nope`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${rt.base}/nope`)).status, 404);
  } finally {
    await rt.close();
  }
});
