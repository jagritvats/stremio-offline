// The real runtime: what `pnpm runtime` starts once Spike 1 has shown that
// stremio-offline:// reaches this process.
//
//   stream   fan out to the configured source addons, merge with the jobs we
//            hold for that title, hand back ⬇ / ⏳ / ✅ entries (DESIGN §9)
//   action   enqueue/<token> resolves a registry token into a job; the token
//            is the only thing that ever travels in a URI (DESIGN §6, §21)
//   media    /media/<jobId> streams finished files to Stremio's player (§10)
//   library  catalog + meta from what is on disk and the metadata snapshots
//            taken at enqueue time, so it all works without internet (§11)
//
// Everything persists under the runtime home: jobs.json, meta/, and the
// download folder from runtime.json. Killing the process mid-download and
// starting it again resumes from the partial file (§18).

import type { Server } from "node:http";
import { join } from "node:path";
import {
  buildCatalog,
  buildManifest,
  buildMeta,
  CATALOG_MOVIES_ID,
  CATALOG_SERIES_ID,
  jobStatusStream,
  libraryMediaIds,
  mediaRoute,
  presentSource,
  snapshotMeta,
  type AddonHandlers,
  type PresenterOptions,
} from "@stremio-offline/addon-core";
import { UpstreamClient, collectOfflineSources, type FetchLike } from "@stremio-offline/addon-proxy";
import {
  DownloadManager,
  HttpEngine,
  JsonDirMetaStore,
  JsonFileJobStore,
  SourceRegistry,
  type DownloadEngine,
  type JobStore,
  type ManagerListener,
  type MetaStore,
} from "@stremio-offline/download-core";
import {
  parseMediaId,
  type JobMedia,
  type MediaRef,
  type OfflineMeta,
  type SourceAddon,
  type StremioStream,
} from "@stremio-offline/models";
import type { ActionRequest } from "./action.ts";
import { readConfig, type RuntimeConfig } from "./config.ts";
import { createRuntimeServer } from "./server.ts";

/** Stremio's own metadata addon, used for titles and the offline snapshots. */
export const CINEMETA = { id: "cinemeta", transportUrl: "https://v3-cinemeta.strem.io" };

export interface RuntimeOptions {
  home: string;
  config: RuntimeConfig;
  version: string;
  log?: (message: string) => void;
  /** Test seams. */
  upstreamFetch?: FetchLike;
  engine?: DownloadEngine;
  jobStore?: JobStore;
  metaStore?: MetaStore;
  /** null turns metadata lookups off. */
  cinemeta?: { id: string; transportUrl: string } | null;
}

export interface Runtime {
  server: Server;
  manager: DownloadManager;
  subscribe(listener: ManagerListener): () => void;
  close(): Promise<void>;
}

function toJobMedia(ref: MediaRef): JobMedia {
  const media: JobMedia = { type: ref.type, mediaId: ref.mediaId, title: ref.title ?? ref.mediaId };
  if (ref.videoId !== undefined) media.videoId = ref.videoId;
  if (ref.season !== undefined) media.season = ref.season;
  if (ref.episode !== undefined) media.episode = ref.episode;
  return media;
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const { home, version } = options;
  const log = options.log ?? (() => {});
  let config = options.config;

  const jobStore = options.jobStore ?? new JsonFileJobStore(join(home, "jobs.json"));
  const metaStore = options.metaStore ?? new JsonDirMetaStore(join(home, "meta"));
  const engine = options.engine ?? new HttpEngine({ userAgent: `stremio-offline/${version}` });
  const clientOptions = { userAgent: `stremio-offline/${version}`, ...(options.upstreamFetch ? { fetch: options.upstreamFetch } : {}) };
  const client = new UpstreamClient(clientOptions);
  // Short timeout: a title lookup must not hold up an enqueue for long when offline.
  const metaClient = new UpstreamClient({ ...clientOptions, timeoutMs: 5_000 });
  const cinemeta = options.cinemeta === undefined ? CINEMETA : options.cinemeta;
  const registry = new SourceRegistry();
  const manager = new DownloadManager({ store: jobStore, engine, storageDir: config.storageDir, log });
  await manager.init();
  let warnedUnsupported = false;

  let server: Server | undefined;
  const presenter = (): PresenterOptions => {
    const address = server?.address();
    const port = address && typeof address === "object" ? address.port : config.port;
    return { mediaBaseUrl: `http://127.0.0.1:${port}` };
  };

  /** Sources as currently configured: the CLI edits runtime.json while we run. */
  async function currentSources(): Promise<SourceAddon[]> {
    try {
      const fresh = await readConfig(home);
      if (fresh) config = fresh;
    } catch (error) {
      log(`runtime.json could not be re-read, keeping the last good sources: ${String(error)}`);
    }
    return config.sources.filter((source) => source.enabled);
  }

  /** The real title (and a metadata snapshot for the offline library), best effort. */
  async function resolveMedia(media: JobMedia): Promise<JobMedia> {
    if (!cinemeta) return media;
    try {
      const meta = await metaClient.fetchMeta(cinemeta, media.type, media.mediaId);
      if (!meta) return media;
      await metaStore.put(snapshotMeta(meta, media.type));
      return { ...media, title: meta.name };
    } catch (error) {
      log(`metadata for ${media.mediaId} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return media;
    }
  }

  const handlers: AddonHandlers = {
    manifest: () => buildManifest({ version, library: true }),

    stream: async (type, id) => {
      const media = toJobMedia(parseMediaId(type, id));
      const jobs = await manager.findForMedia(media);
      const sources = await currentSources();
      const streams: StremioStream[] = [];
      const shown = new Set<string>();

      if (sources.length > 0) {
        const result = await collectOfflineSources(client, sources, type, id);
        for (const failure of result.errors) log(`source addon ${failure.addonId}: ${failure.message}`);
        // A ⬇ entry the engine cannot act on is a button that does nothing: leave those out.
        const offered = result.sources.filter((source) => engine.supports?.(source.source) ?? true);
        if (offered.length < result.sources.length && !warnedUnsupported) {
          warnedUnsupported = true;
          log(`${result.sources.length - offered.length} source(s) hidden: no engine for their type yet (torrent engine not built)`);
        }
        for (const source of offered) {
          const token = registry.register(source, media);
          const job = jobs.find((candidate) => candidate.sourceKey === source.key);
          if (job) shown.add(job.id);
          streams.push(presentSource(source, job, token, presenter()));
        }
      }
      // Jobs whose source is not on offer right now (upstream down, or we are offline) still show.
      for (const job of jobs) if (!shown.has(job.id)) streams.push(jobStatusStream(job, presenter()));
      // Playable first: what is on disk beats what could be fetched.
      streams.sort((a, b) => Number(Boolean(b.url)) - Number(Boolean(a.url)));
      return { streams };
    },

    catalog: async (type, catalogId, extra) => {
      if (catalogId !== (type === "movie" ? CATALOG_MOVIES_ID : CATALOG_SERIES_ID)) return { metas: [] };
      const jobs = await manager.list();
      const metas = new Map<string, OfflineMeta>();
      for (const mediaId of libraryMediaIds(type, jobs)) {
        const meta = await metaStore.get(type, mediaId);
        if (meta) metas.set(mediaId, meta);
      }
      return buildCatalog(type, jobs, metas, extra);
    },

    meta: async (type, id) => buildMeta(type, id, await manager.list(), await metaStore.get(type, id)),
  };

  async function onAction(action: ActionRequest): Promise<string> {
    const target = action.args[0];
    const id = (): string => {
      if (!target) throw new Error(`${action.action} needs an id`);
      return target;
    };
    const status = (job: { status: string; label: string } | undefined): string =>
      job ? `${job.status}: ${job.label}` : "no such job";

    switch (action.action) {
      case "test":
        return "test action received";
      case "enqueue": {
        const registered = registry.resolve(id());
        if (!registered) throw new Error("that entry has expired; open the title in Stremio again and tap it once more");
        const media = await resolveMedia(registered.media);
        const job = await manager.enqueue({ ...registered, media });
        return `queued ${job.label} for ${media.title}`;
      }
      case "pause":
        return status(await manager.pause(id()));
      case "resume":
      case "retry":
        return status(await manager.resume(id()));
      case "cancel":
        return (await manager.cancel(id())) ? "cancelled" : "no such job";
      case "job":
        return status(await manager.get(id()));
      default:
        throw new Error(`unknown action "${action.action}"`);
    }
  }

  const media = mediaRoute(async (jobId) => {
    const job = await manager.get(jobId);
    return job?.status === "complete" && job.localPath ? { path: job.localPath } : undefined;
  });

  server = createRuntimeServer({
    secret: config.secret,
    version,
    handlers,
    onAction,
    listJobs: () => manager.list(),
    routes: [media],
    log,
  });
  const bound = server;

  return {
    server: bound,
    manager,
    subscribe: (listener) => manager.subscribe(listener),
    close: () =>
      new Promise((resolve) => {
        bound.close(() => resolve());
        bound.closeAllConnections();
      }),
  };
}
