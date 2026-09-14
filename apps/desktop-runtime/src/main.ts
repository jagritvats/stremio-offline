// Local runtime entry point. Binds 127.0.0.1 only.
//
//   pnpm runtime                        start the runtime (default command)
//   pnpm runtime jobs                   list downloads; jobs pause|resume|cancel <id> acts on one
//   pnpm runtime sources list|add <manifestUrl>|remove <id>|enable <id>|disable <id>
//   pnpm runtime storage [<dir>]        show or set the download folder (restart the runtime after a change)
//   pnpm spike:1                        the hello-offline addon of DESIGN §7 / §23 Spike 1
//   pnpm register                       register stremio-offline:// with the OS, once
//   main.ts dispatch <uri>              what the OS runs for a stremio-offline:// URI: forwards it to the runtime

import { listen } from "@stremio-offline/addon-core";
import { UpstreamClient } from "@stremio-offline/addon-proxy";
import { ACTION_SCHEME, type ActionRequest } from "./action.ts";
import { connect } from "./client.ts";
import { configPath, loadOrCreateConfig, runtimeHome } from "./config.ts";
import { jobsTable, resolveJobId } from "./jobs-table.ts";
import { registerProtocol } from "./protocol.ts";
import { createRuntime } from "./runtime.ts";
import { createRuntimeServer } from "./server.ts";
import { addSource, describeSource, listSources, removeSource, setSourceEnabled, setStorageDir } from "./sources.ts";
import { spike1Action, spike1Handlers, type Spike1State } from "./spike1.ts";

// `pnpm runtime jobs | head -1` closes this process's stdout early, and a write
// to a closed pipe raises an unhandled error event that ends the CLI in a stack
// trace. Exiting quietly is what every other command-line tool does.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const VERSION = "0.0.1";
const USAGE =
  "one of: start, jobs [pause|resume|cancel <id>], sources <list|add|remove|enable|disable>, " +
  "storage [dir], spike1, register, dispatch <uri>";

function fail(message: string, code = 1): never {
  console.error(`stremio-offline: ${message}`);
  process.exit(code);
}

function portFromEnv(): number | undefined {
  const raw = process.env["STREMIO_OFFLINE_PORT"];
  return raw ? Number(raw) : undefined;
}

const log = (message: string): void => console.error(`[runtime] ${message}`);

async function bind(server: Parameters<typeof listen>[0], port: number) {
  return listen(server, port).catch((error: NodeJS.ErrnoException) =>
    fail(
      error.code === "EADDRINUSE"
        ? `port ${port} is in use. Already running? Otherwise set STREMIO_OFFLINE_PORT to move it.`
        : `cannot listen on 127.0.0.1:${port}: ${error.message}`,
    ),
  );
}

function onShutdown(close: () => Promise<void>): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void close().then(() => process.exit(0));
    });
  }
}

async function start(): Promise<void> {
  const home = runtimeHome();
  const config = await loadOrCreateConfig(home, portFromEnv());
  const runtime = await createRuntime({ home, config, version: VERSION, log });
  const bound = await bind(runtime.server, config.port);

  const names = config.sources.filter((source) => source.enabled).map((source) => source.name);
  console.log(`Stremio Offline runtime ${VERSION}`);
  console.log(`  addon     http://${bound.host}:${bound.port}/manifest.json   (paste into Stremio's addon search)`);
  console.log(`  storage   ${config.storageDir}`);
  console.log(`  sources   ${names.length > 0 ? names.join(", ") : "none yet: pnpm runtime sources add <manifest url>"}`);
  console.log(`  state     ${home}`);
  console.log(`  handler   ${ACTION_SCHEME}://   (run \`pnpm register\` once if you have not)`);
  console.log("  downloads pnpm runtime jobs   (also: jobs pause|resume|cancel <id>)");

  // One line per status change, not per progress tick.
  const lastStatus = new Map<string, string>();
  runtime.subscribe((event) => {
    if (event.type === "job-removed") {
      lastStatus.delete(event.jobId);
      console.log(`[job ${event.jobId}] removed`);
      return;
    }
    const { job } = event;
    if (lastStatus.get(job.id) === job.status) return;
    lastStatus.set(job.id, job.status);
    const detail = job.status === "error" ? `: ${job.error ?? "unknown error"}` : "";
    console.log(`[job ${job.id}] ${job.status} — ${job.media.title} • ${job.label}${detail}`);
  });

  onShutdown(runtime.close);
}

async function runSpike1(): Promise<void> {
  const home = runtimeHome();
  const config = await loadOrCreateConfig(home, portFromEnv());

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
    log,
  });
  const bound = await bind(server, config.port);

  console.log(`Stremio Offline runtime ${VERSION} — Spike 1 (hello-offline)`);
  console.log(`  addon    http://${bound.host}:${bound.port}/manifest.json   (paste into Stremio's addon search)`);
  console.log(`  state    ${configPath(home)}`);
  console.log(`  handler  ${ACTION_SCHEME}://   (run \`pnpm register\` once if you have not)`);
  console.log('Waiting. Open any title in Stremio and tap "⬇ TEST DOWNLOAD".');

  onShutdown(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
}

// Runs as a short-lived process launched by the OS with the URI Stremio opened.
// It only forwards: the running runtime decides what the action means.
async function dispatch(uri: string): Promise<void> {
  if (!uri.startsWith(`${ACTION_SCHEME}:`)) fail(`not a ${ACTION_SCHEME}:// URI: ${uri}`, 2);
  const client = await connect(runtimeHome()).catch((error: Error) => fail(error.message));
  console.log(await client.raw(uri).catch((error: Error) => fail(error.message)));
}

/** `jobs` and the one-job commands, all of which go through the same action surface. */
async function jobs(args: string[]): Promise<void> {
  const [verb = "list", typed] = args;
  const client = await connect(runtimeHome()).catch((error: Error) => fail(error.message));
  const all = await client.jobs().catch((error: Error) => fail(error.message));

  if (verb === "list") {
    for (const line of jobsTable(all)) console.log(line);
    return;
  }
  const actions: Record<string, ActionRequest["action"]> = {
    pause: "pause",
    resume: "resume",
    retry: "resume",
    cancel: "cancel",
  };
  const action = actions[verb];
  if (!action) fail(`unknown jobs command "${verb}"; one of: list, pause, resume, cancel`, 2);
  if (!typed) fail(`jobs ${verb} needs a job id; run \`pnpm runtime jobs\` to list them`, 2);

  const id = ((): string => {
    try {
      return resolveJobId(all, typed);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 2);
    }
  })();
  console.log(await client.action(`${ACTION_SCHEME}://${action}/${encodeURIComponent(id)}`).catch((error: Error) => fail(error.message)));
}

async function sources(args: string[]): Promise<void> {
  const home = runtimeHome();
  const [verb = "list", target] = args;
  const need = (): string => target ?? fail(`sources ${verb} needs an argument`, 2);
  switch (verb) {
    case "list": {
      const all = await listSources(home);
      if (all.length === 0) console.log("no source addons yet: pnpm runtime sources add <manifest url>");
      for (const source of all) console.log(describeSource(source));
      return;
    }
    case "add": {
      const client = new UpstreamClient({ userAgent: `stremio-offline/${VERSION}` });
      const source = await addSource(home, client, need()).catch((error: Error) => fail(error.message));
      console.log(`added ${describeSource(source)}`);
      return;
    }
    case "remove":
      console.log((await removeSource(home, need())) ? `removed ${target}` : `no source with id ${target}`);
      return;
    case "enable":
    case "disable": {
      const enabled = verb === "enable";
      console.log((await setSourceEnabled(home, need(), enabled)) ? `${verb}d ${target}` : `no source with id ${target}`);
      return;
    }
    default:
      fail(`unknown sources command "${verb}"; ${USAGE}`, 2);
  }
}

async function storage(dir: string | undefined): Promise<void> {
  const home = runtimeHome();
  if (dir) {
    console.log(`downloads will go to ${await setStorageDir(home, dir)} (restart the runtime if it is running)`);
  } else {
    console.log((await loadOrCreateConfig(home)).storageDir);
  }
}

const [command = "start", ...rest] = process.argv.slice(2);

if (command.startsWith(`${ACTION_SCHEME}:`)) {
  await dispatch(command);
} else {
  switch (command) {
    case "start":
      await start();
      break;
    case "jobs":
      await jobs(rest);
      break;
    case "sources":
      await sources(rest);
      break;
    case "storage":
      await storage(rest[0]);
      break;
    case "spike1":
      await runSpike1();
      break;
    case "register":
      console.log(await registerProtocol(runtimeHome()).catch((error: Error) => fail(error.message)));
      break;
    case "dispatch":
      await dispatch(rest[0] ?? fail("usage: dispatch <stremio-offline://...>", 2));
      break;
    default:
      fail(`unknown command "${command}"; ${USAGE}`, 2);
  }
}
