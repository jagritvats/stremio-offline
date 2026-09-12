// Local runtime entry point. Binds 127.0.0.1 only.
//
//   pnpm spike:1              run the hello-offline addon (DESIGN §7, §23 Spike 1)
//   pnpm register             register stremio-offline:// with the OS, once
//   main.ts dispatch <uri>    what the OS runs for a stremio-offline:// URI: forwards it to the running runtime
//   pnpm runtime              the real runtime; deliberately absent until Spike 1 passes (CLAUDE.md)

import { listen } from "@stremio-offline/addon-core";
import { ACTION_SCHEME } from "./action.ts";
import { configPath, loadOrCreateConfig, readConfig, runtimeHome } from "./config.ts";
import { registerProtocol } from "./protocol.ts";
import { createRuntimeServer } from "./server.ts";
import { spike1Action, spike1Handlers, type Spike1State } from "./spike1.ts";

const VERSION = "0.0.1";

function fail(message: string, code = 1): never {
  console.error(`stremio-offline: ${message}`);
  process.exit(code);
}

async function runSpike1(): Promise<void> {
  const home = runtimeHome();
  const portEnv = process.env["STREMIO_OFFLINE_PORT"];
  const config = await loadOrCreateConfig(home, portEnv ? Number(portEnv) : undefined);

  const state: Spike1State = { received: 0 };
  const server = createRuntimeServer({
    secret: config.secret,
    version: VERSION,
    handlers: spike1Handlers(state, VERSION),
    onAction: (action) => {
      const outcome = spike1Action(state, action);
      console.log(`[spike1] ${outcome}`);
      return outcome;
    },
    log: (message) => console.error(`[runtime] ${message}`),
  });

  const bound = await listen(server, config.port).catch((error: NodeJS.ErrnoException) =>
    fail(
      error.code === "EADDRINUSE"
        ? `port ${config.port} is in use. Already running? Otherwise set STREMIO_OFFLINE_PORT to move it.`
        : `cannot listen on 127.0.0.1:${config.port}: ${error.message}`,
    ),
  );

  console.log(`Stremio Offline runtime ${VERSION} — Spike 1 (hello-offline)`);
  console.log(`  addon    http://${bound.host}:${bound.port}/manifest.json   (paste into Stremio's addon search)`);
  console.log(`  state    ${configPath(home)}`);
  console.log(`  handler  ${ACTION_SCHEME}://   (run \`pnpm register\` once if you have not)`);
  console.log('Waiting. Open any title in Stremio and tap "⬇ TEST DOWNLOAD".');

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
  }
}

// Runs as a short-lived process launched by the OS with the URI Stremio opened.
// It only forwards: the running runtime decides what the action means.
async function dispatch(uri: string): Promise<void> {
  if (!uri.startsWith(`${ACTION_SCHEME}:`)) fail(`not a ${ACTION_SCHEME}:// URI: ${uri}`, 2);
  const home = runtimeHome();
  const config = await readConfig(home);
  if (!config) fail(`no runtime state in ${home}; start the runtime first (pnpm spike:1)`);

  const response = await fetch(`http://127.0.0.1:${config.port}/api/action`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
    body: JSON.stringify({ uri }),
  }).catch(() => fail(`the runtime is not running on 127.0.0.1:${config.port}`));

  const body = await response.text();
  if (!response.ok) fail(`the runtime rejected the action (${response.status}): ${body}`);
  console.log(body);
}

const [command = "start", ...rest] = process.argv.slice(2);

if (command.startsWith(`${ACTION_SCHEME}:`)) {
  await dispatch(command);
} else {
  switch (command) {
    case "spike1":
      await runSpike1();
      break;
    case "register":
      console.log(await registerProtocol().catch((error: Error) => fail(error.message)));
      break;
    case "dispatch":
      await dispatch(rest[0] ?? fail("usage: dispatch <stremio-offline://...>", 2));
      break;
    case "start":
      fail("the full runtime is built once Spike 1 passes (docs/SPIKES.md); run `pnpm spike:1`", 2);
      break;
    default:
      fail(`unknown command "${command}"; one of: spike1, register, dispatch <uri>`, 2);
  }
}
