// The hosted half of Stremio Offline, published at soffline.synpse.app and
// installed into Stremio by URL the way Torrentio is.
//
// This is NOT the runtime in apps/desktop-runtime. That one binds 127.0.0.1,
// owns the download engine and the files on disk, and holds the privileged
// `/api/*` surface behind an install secret. This process is the opposite of it
// in every one of those respects, and the two must not be confused:
//
//   desktop-runtime          addon-server (this file)
//   -----------------------  ------------------------------------------------
//   binds 127.0.0.1          binds 0.0.0.0, behind Traefik
//   has /api/* + secret      has NO privileged endpoints at all
//   writes files to disk     writes nothing, anywhere, ever
//   per-machine state        stateless; config rides in the install URL
//
// WHY THE STREAM LIST IS EMPTY HERE, AND WHAT WOULD CHANGE THAT
// ---------------------------------------------------------------------------
// Everything needed to aggregate upstream sources already exists and is wired
// below: `collectOfflineSources` fans out across the configured addons, dedupes
// and sorts. What this process cannot do is mint the action token that a
// `⬇ OFFLINE` entry needs.
//
// `SourceRegistry` (download-core) is an in-memory map inside the runtime, and
// its tokens are opaque on purpose — DESIGN §6 and §21 require that an action URI
// carry a reference to a known source and never a magnet, an upstream URL or a
// credential. A token minted here would mean nothing to the runtime on someone
// else's machine, and the only way to make it mean something would be to put the
// source descriptor in the URI itself. That is the exact thing §21 forbids,
// because a localhost action endpoint is reachable by any webpage the user has
// open.
//
// So `presentSources` below is complete and unused, and `stream` returns an empty
// list rather than entries that cannot be actioned. Closing this gap is a design
// decision about token custody across the hosted/local boundary, not an
// implementation detail — see deploy/docker/README.md.

import {
  buildManifest,
  createAddonRouter,
  createLocalServer,
  listen,
  presentSource,
  sendJson,
  type AddonHandlers,
  type RouteHandler,
} from "@stremio-offline/addon-core";
import { UpstreamClient, collectOfflineSources } from "@stremio-offline/addon-proxy";
import type { MediaType, SourceAddon, StremioStream } from "@stremio-offline/models";
import { parseConfig, EMPTY_CONFIG, type IncomingConfig } from "./config.ts";
import { configurePage } from "./configure.ts";

const PORT = Number(process.env["PORT"] ?? 7000);

// 0.0.0.0 deliberately, and unlike every other entry point in this repo. This
// process only ever runs inside a container whose ports are not published to the
// host — Traefik reaches it over a shared Docker network. A loopback bind here
// makes every request 502, with nothing in this container's logs to explain it.
const HOST = process.env["HOST"] ?? "0.0.0.0";

const VERSION = process.env["SOFF_VERSION"] ?? "0.0.1";

// Paths this server owns itself. Anything else in the first path segment is
// treated as a config blob, which is what makes `/<config>/manifest.json` work.
const OWN_ROUTES = new Set(["manifest.json", "stream", "catalog", "meta", "configure", "health"]);

const upstream = new UpstreamClient({ userAgent: `stremio-offline-hosted/${VERSION}` });

// --- Handlers ---------------------------------------------------------------

function handlersFor(config: IncomingConfig): AddonHandlers {
  return {
    manifest: () =>
      buildManifest({
        version: VERSION,
        // No catalogs. The offline library is a list of what is on one
        // particular disk, and a hosted server has no way to know that — it must
        // not guess, and must not show one person's library shape to another.
        // `library: false` drops the catalog and meta resources rather than
        // advertising two catalogs that could only ever answer empty.
        library: false,
        description:
          "Mirrors the streams of your existing source addons. Pair with the Stremio Offline " +
          "runtime on your device to download them for offline playback.",
      }),

    stream: async (type: MediaType, id: string) => {
      const streams = await buildStreams(type, id, config);
      return { streams };
    },
  };
}

// Fans out across the configured upstream addons and reduces the result to the
// entries Stremio should show. Returns empty until the token question above is
// settled; the aggregation itself is real and runs.
async function buildStreams(type: MediaType, id: string, config: IncomingConfig): Promise<StremioStream[]> {
  if (config.sources.length === 0) return [];

  const addons: SourceAddon[] = config.sources.map((source, index) => ({
    id: `src-${index}`,
    // Shown on the entry as the provider name. Deliberately positional rather
    // than derived from the URL: the host name is part of a credentialled URL.
    name: `Source ${index + 1}`,
    manifestUrl: source.transportUrl,
    transportUrl: source.transportUrl,
    enabled: source.enabled,
  }));

  const { sources } = await collectOfflineSources(upstream, addons, type, id);
  const wanted = filterByQuality(sources, config.qualities);

  return presentSources(wanted);
}

function filterByQuality<T extends { quality?: string }>(sources: T[], qualities: string[]): T[] {
  if (qualities.length === 0) return sources;
  const allowed = new Set(qualities.map((q) => q.toLowerCase()));
  return sources.filter((s) => (s.quality ? allowed.has(s.quality.toLowerCase()) : true));
}

// Complete, and unused on purpose. See the header: every entry this would build
// needs an action token that only the local runtime can issue. Kept wired so the
// moment token custody is decided, this is the single place that changes.
function presentSources(sources: Parameters<typeof presentSource>[0][]): StremioStream[] {
  void sources;
  return [];
}

// --- Routes -----------------------------------------------------------------

// Liveness, before any config parsing, so a malformed install URL can never make
// the container look unhealthy and trigger a restart loop.
const healthRoute: RouteHandler = ({ res, url }) => {
  if (url.pathname !== "/health") return false;
  sendJson(res, 200, { ok: true, version: VERSION });
  return true;
};

// The addon protocol, with the Torrentio-style config prefix stripped first.
//
// Never log `url.pathname`. The config segment can carry upstream credentials —
// see the header of config.ts.
const addonRoute: RouteHandler = async ({ res, url, method }) => {
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const hasConfig = segments.length > 0 && !OWN_ROUTES.has(segments[0] ?? "");
  const config = hasConfig ? parseConfig(segments[0]) : EMPTY_CONFIG;
  const path = `/${(hasConfig ? segments.slice(1) : segments).join("/")}`;

  const router = createAddonRouter(handlersFor(config));
  const result = await router({ method, path });
  if (!result) return false;

  res.writeHead(result.status, {
    ...result.headers,
    ...(result.body ? { "Content-Length": Buffer.byteLength(result.body) } : {}),
  });
  res.end(method === "HEAD" ? undefined : result.body);
  return true;
};

// `/` and `/configure`, with or without a config prefix. Stremio opens the
// prefixed form when someone reconfigures an addon they already installed.
const configureRoute: RouteHandler = ({ res, url }) => {
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const hasConfig = segments.length > 0 && !OWN_ROUTES.has(segments[0] ?? "");
  const rest = hasConfig ? segments.slice(1) : segments;
  if (rest.length > 0 && rest[0] !== "configure") return false;

  const body = configurePage(hasConfig ? segments[0] : undefined);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
  return true;
};

const server = createLocalServer([healthRoute, addonRoute, configureRoute], {
  // No request detail. The only request-shaped thing available to print is the
  // path, and the path holds the config.
  onError: () => console.error("addon-server: request failed"),
});

await listen(server, PORT, HOST);
console.log(`stremio-offline addon-server listening on ${HOST}:${PORT}`);

// Traefik and Docker both stop a container by signalling it. Without these the
// process is killed after the grace period on every deploy, which turns an
// ordinary rolling restart into a hard kill.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
