import { randomBytes } from "node:crypto";
import { isActiveJob, mediaScopeKey, type DownloadJob, type JobMedia, type OfflineSource } from "@stremio-offline/models";
import { planLocalPath, withSuffix } from "./paths.ts";
import type { RegisteredSource } from "./source-registry.ts";
import type { JobStore } from "./store.ts";

export interface EngineProgress {
  bytesDownloaded: number;
  totalBytes?: number;
  /** Set once the engine knows the real filename. */
  localPath?: string;
}

/** Callbacks an engine uses to report on one job. Safe to call from any tick. */
export interface EngineEvents {
  status(status: "resolving" | "downloading"): void;
  progress(update: EngineProgress): void;
  complete(result: { localPath: string; totalBytes: number }): void;
  error(message: string): void;
}

/**
 * A transfer backend (torrent, http). `start` must be resumable: the manager
 * calls it again after a process restart for every active job, and the engine
 * is expected to continue from whatever is already on disk (DESIGN §18).
 */
export interface DownloadEngine {
  /** Whether this engine can transfer the source at all. Absent means everything. */
  supports?(source: OfflineSource): boolean;
  start(job: DownloadJob, events: EngineEvents): Promise<void> | void;
  pause(job: DownloadJob): Promise<void> | void;
  cancel(job: DownloadJob, deleteFiles: boolean): Promise<void> | void;
}

/** Engine that never transfers anything; used by spikes before a real engine exists. */
export class NoopEngine implements DownloadEngine {
  start(): void {}
  pause(): void {}
  cancel(): void {}
}

export type ManagerEvent = { type: "job-updated"; job: DownloadJob } | { type: "job-removed"; jobId: string };
export type ManagerListener = (event: ManagerEvent) => void;

export interface DownloadManagerOptions {
  store: JobStore;
  engine: DownloadEngine;
  storageDir: string;
  now?: () => number;
  newId?: () => string;
  log?: (message: string) => void;
}

type MediaScope = Pick<JobMedia, "type" | "mediaId" | "videoId">;

/** Owns the job lifecycle: queued → resolving/downloading → complete, with pause/resume/cancel. */
export class DownloadManager {
  readonly #store: JobStore;
  readonly #engine: DownloadEngine;
  readonly #storageDir: string;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #log: (message: string) => void;
  readonly #listeners = new Set<ManagerListener>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: DownloadManagerOptions) {
    this.#store = options.store;
    this.#engine = options.engine;
    this.#storageDir = options.storageDir;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => randomBytes(8).toString("hex"));
    this.#log = options.log ?? (() => {});
  }

  /** Load persisted jobs and hand every active one back to the engine. */
  async init(): Promise<void> {
    await this.#store.init();
    for (const job of await this.#store.all()) {
      if (isActiveJob(job)) {
        this.#log(`resuming job ${job.id} (${job.status})`);
        await this.#startEngine(job);
      }
    }
  }

  subscribe(listener: ManagerListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(): Promise<DownloadJob[]> {
    return this.#store.all();
  }

  get(id: string): Promise<DownloadJob | undefined> {
    return this.#store.get(id);
  }

  async findForMedia(media: MediaScope): Promise<DownloadJob[]> {
    const scope = mediaScopeKey(media);
    return (await this.#store.all()).filter((job) => mediaScopeKey(job.media) === scope);
  }

  async findForSource(media: MediaScope, key: string): Promise<DownloadJob | undefined> {
    return (await this.findForMedia(media)).find((job) => job.sourceKey === key);
  }

  /** Create (or reuse) the job for a registered source and start transferring. */
  async enqueue(registered: RegisteredSource): Promise<DownloadJob> {
    const { job, start } = await this.#serial(async () => {
      const existing = await this.findForSource(registered.media, registered.source.key);
      if (existing && existing.status !== "error") return { job: existing, start: false };
      if (existing) {
        const retried = await this.#patch(existing.id, (j) => {
          j.status = "queued";
          delete j.error;
        });
        return { job: retried ?? existing, start: retried !== undefined };
      }

      const now = this.#now();
      const id = this.#newId();
      const job: DownloadJob = {
        id,
        media: { ...registered.media },
        source: structuredClone(registered.source.source),
        sourceKey: registered.source.key,
        label: registered.source.label,
        status: "queued",
        bytesDownloaded: 0,
        localPath: "",
        createdAt: now,
        updatedAt: now,
      };
      if (registered.source.quality) job.quality = registered.source.quality;
      if (registered.source.size) job.totalBytes = registered.source.size;

      const taken = new Set((await this.#store.all()).map((j) => j.localPath));
      const planned = planLocalPath(this.#storageDir, job.media, job.source, id);
      job.localPath = taken.has(planned) ? withSuffix(planned, id) : planned;

      await this.#store.put(job);
      this.#emit({ type: "job-updated", job });
      return { job, start: true };
    });
    if (start) await this.#startEngine(job);
    return job;
  }

  async pause(id: string): Promise<DownloadJob | undefined> {
    return this.#serial(async () => {
      const current = await this.#store.get(id);
      if (!current || !isActiveJob(current)) return current;
      await this.#engine.pause(current);
      return this.#patch(id, (j) => {
        j.status = "paused";
      });
    });
  }

  /** Resume a paused job, or retry a failed one. */
  async resume(id: string): Promise<DownloadJob | undefined> {
    const { job, start } = await this.#serial(async () => {
      const current = await this.#store.get(id);
      if (!current || (current.status !== "paused" && current.status !== "error")) {
        return { job: current, start: false };
      }
      const next = await this.#patch(id, (j) => {
        j.status = "queued";
        delete j.error;
      });
      return { job: next, start: next !== undefined };
    });
    if (start && job) await this.#startEngine(job);
    return job;
  }

  async cancel(id: string, deleteFiles = true): Promise<boolean> {
    return this.#serial(async () => {
      const job = await this.#store.get(id);
      if (!job) return false;
      await this.#engine.cancel(job, deleteFiles);
      await this.#store.delete(id);
      this.#emit({ type: "job-removed", jobId: id });
      return true;
    });
  }

  /** Resolves once every queued mutation (including pending engine events) has been applied. */
  idle(): Promise<void> {
    return this.#queue.then(() => undefined);
  }

  async #startEngine(job: DownloadJob): Promise<void> {
    try {
      await this.#engine.start(job, this.#eventsFor(job.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log(`job ${job.id}: engine failed to start: ${message}`);
      await this.#serial(() =>
        this.#patch(job.id, (j) => {
          j.status = "error";
          j.error = message;
        }),
      );
    }
  }

  #eventsFor(jobId: string): EngineEvents {
    const apply = (mutate: (job: DownloadJob) => void): void => {
      this.#serial(() => this.#patch(jobId, mutate)).catch((error: unknown) => {
        this.#log(`job ${jobId}: update failed: ${String(error)}`);
      });
    };
    return {
      status: (status) =>
        apply((j) => {
          if (isActiveJob(j)) j.status = status;
        }),
      progress: (update) =>
        apply((j) => {
          if (!isActiveJob(j)) return;
          j.bytesDownloaded = update.bytesDownloaded;
          if (update.totalBytes !== undefined) j.totalBytes = update.totalBytes;
          if (update.localPath) j.localPath = update.localPath;
          if (j.status !== "downloading") j.status = "downloading";
        }),
      complete: (result) =>
        apply((j) => {
          j.status = "complete";
          j.localPath = result.localPath;
          j.totalBytes = result.totalBytes;
          j.bytesDownloaded = result.totalBytes;
          delete j.error;
        }),
      error: (message) =>
        apply((j) => {
          j.status = "error";
          j.error = message;
        }),
    };
  }

  /** Read-modify-write one job; callers must hold the serial queue. */
  async #patch(id: string, mutate: (job: DownloadJob) => void): Promise<DownloadJob | undefined> {
    const current = await this.#store.get(id);
    if (!current) return undefined;
    const job = structuredClone(current);
    mutate(job);
    job.updatedAt = this.#now();
    await this.#store.put(job);
    this.#emit({ type: "job-updated", job });
    return job;
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #emit(event: ManagerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#log(`listener failed: ${String(error)}`);
      }
    }
  }
}
