// The hosted half of Stremio Offline.
//
// This is NOT the runtime in apps/desktop-runtime. That one binds 127.0.0.1,
// owns the download engine and the files on disk, and holds privileged `/api/*`
// endpoints behind an install secret. This process is the opposite of it in
// every one of those respects, and the two must not be confused:
//
//   desktop-runtime          addon-server (this file)
//   -----------------------  ------------------------------------------------
//   binds 127.0.0.1          binds 0.0.0.0, published at soffline.synpse.app
//   has /api/* + secret      has NO privileged endpoints at all
//   writes files to disk     writes nothing, anywhere, ever
//   per-machine state        stateless; config rides in the install URL
//
// WHAT A HOSTED ADDON CAN AND CANNOT DO
// ---------------------------------------------------------------------------
// DESIGN.md section 1 is right: a pure remote addon cannot persist files on the
// device and cannot run the download engine. Hosting this half does not change
// that. What it buys is installation — one HTTPS URL pasted into Stremio, the
// way Torrentio is installed, with no local process needed just to browse.
//
// So the split is: this host answers the catalogue and the stream list. The
// download itself, and offline playback of it, still belong to the runtime on
// the device. A stream entry served from here that claims to make something
// available offline, with no runtime installed, would be a lie — see
// `streamHandler` below, which is why it currently answers empty.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildManifest } from "./manifest.ts";
import { parseConfig, EMPTY_CONFIG, type IncomingConfig } from "./config.ts";
import { configurePage } from "./configure.ts";

const PORT = Number(process.env["PORT"] ?? 7000);

// 0.0.0.0 deliberately. This process only ever runs inside a container whose
// ports are not published to the host — Traefik reaches it over the shared
// Docker network. Binding 127.0.0.1 here would make it unreachable from Traefik
// and every request would 502, with nothing in this process's logs to say why.
const HOST = process.env["HOST"] ?? "0.0.0.0";

// The addon resources this server answers, used to tell `/manifest.json` from
// `/<config>/manifest.json` without a router library.
const RESOURCES = new Set(["manifest.json", "stream", "catalog", "meta", "configure", "health"]);

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    // Stremio Web runs in a browser on a different origin, so without this the
    // addon installs and then answers nothing, with the failure visible only in
    // the browser console. Every Stremio addon is served wide open like this;
    // there is nothing here worth protecting with an origin check, because the
    // server holds no state and no privileged route.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

// --- Resource handlers ------------------------------------------------------
// Each one is the seam where packages/addon-core plugs in. They are deliberately
// thin and deliberately honest: an unimplemented handler answers an empty list,
// never a plausible-looking fake one.

function streamHandler(_type: string, _id: string, _config: IncomingConfig): { streams: unknown[] } {
  // Empty until addon-core and addon-proxy exist, and until Spike 3 has shown
  // that an upstream addon can actually be normalised into an offline entry.
  // DESIGN.md section 23 fixes that build order and it is not negotiable here.
  //
  // An entry returned from this host can only ever be an `externalUrl` that
  // hands off to the local runtime — this process cannot download anything for
  // anybody. Returning entries before that handoff is proven (Spike 1) would put
  // a download button in front of people that silently does nothing.
  return { streams: [] };
}

function catalogHandler(_type: string, _id: string, _config: IncomingConfig): { metas: unknown[] } {
  // The offline catalogue is a list of what is on one particular disk. A hosted
  // server has no way to know that and must not guess. Once the runtime exists
  // this is served by the runtime on localhost, and the hosted copy stays empty
  // rather than showing one person's library shape to another.
  return { metas: [] };
}

function metaHandler(_type: string, _id: string, _config: IncomingConfig): { meta: unknown } {
  return { meta: null };
}

// --- Routing ----------------------------------------------------------------

function handle(req: IncomingMessage, res: ServerResponse): void {
  // Never log `req.url`. It contains the config segment, which can contain
  // upstream credentials. See the header of config.ts.
  const rawPath = (req.url ?? "/").split("?")[0] ?? "/";

  if (req.method === "OPTIONS") {
    send(res, 204, "", "text/plain");
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { err: "method not allowed" });
    return;
  }

  const segments = rawPath.split("/").filter((s) => s.length > 0);

  // Liveness, before any config parsing, so a malformed install URL can never
  // make the container look unhealthy and trigger a restart loop.
  if (segments[0] === "health") {
    sendJson(res, 200, { ok: true, version: buildManifest(EMPTY_CONFIG).version });
    return;
  }

  // `/<config>/rest...` versus `/rest...`. The first segment is configuration
  // unless it names a resource this server serves.
  const hasConfig = segments.length > 0 && !RESOURCES.has(segments[0] ?? "");
  const configSegment = hasConfig ? segments[0] : undefined;
  const rest = hasConfig ? segments.slice(1) : segments;
  const config = parseConfig(configSegment);

  const head = rest[0];

  if (head === undefined || head === "configure") {
    send(res, 200, configurePage(configSegment), "text/html; charset=utf-8");
    return;
  }

  if (head === "manifest.json") {
    sendJson(res, 200, buildManifest(config));
    return;
  }

  // `/stream/movie/tt0816692.json` — type, then id with a `.json` suffix.
  if (head === "stream" || head === "catalog" || head === "meta") {
    const type = rest[1];
    const tail = rest[2];
    if (type === undefined || tail === undefined) {
      sendJson(res, 404, { err: "not found" });
      return;
    }
    const id = decodeURIComponent(tail.replace(/\.json$/, ""));

    if (head === "stream") sendJson(res, 200, streamHandler(type, id, config));
    else if (head === "catalog") sendJson(res, 200, catalogHandler(type, id, config));
    else sendJson(res, 200, metaHandler(type, id, config));
    return;
  }

  sendJson(res, 404, { err: "not found" });
}

const server = createServer((req, res) => {
  try {
    handle(req, res);
  } catch {
    // No error detail in the response and none in the log: the only
    // request-shaped thing available to print is the path, and the path holds
    // the config.
    if (!res.headersSent) sendJson(res, 500, { err: "internal error" });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`stremio-offline addon-server listening on ${HOST}:${PORT}`);
});

// Traefik and Docker both stop a container by signalling it. Without these the
// process is killed after the 10s grace period on every deploy, which turns an
// ordinary rolling restart into a hard kill.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
