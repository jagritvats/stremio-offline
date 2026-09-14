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
  /** Transfers running at once; the rest wait as "queued". Default 2. */
  maxConcurrent?: number;
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
  readonly #maxConcurrent: number;
  readonly #listeners = new Set<ManagerListener>();
  /** Jobs handed to the engine. Everything else with an active status is waiting for a slot. */
  readonly #running = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();
  #work: Promise<unknown> = Promise.resolve();

  constructor(options: DownloadManagerOptions) {
    this.#store = options.store;
    this.#engine = options.engine;
    this.#storageDir = options.storageDir;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => randomBytes(8).toString("hex"));
    this.#log = options.log ?? (() => {});
    this.#maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 2));
  }

/**
   * Load persisted jobs. A previous process may have died mid-transfer, so every
   * job that was active goes back to "queued" and the queue starts as many as
   * the concurrency limit allows; the engine resumes each from its partial file.
   */
  async init(): Promise<void> {
    await this.#store.init();
    await this.#serial(async () => {
      for (const job of await this.#store.all()) {
        if (!isActiveJob(job)) continue;
        this.#log(`resuming job ${job.id} (was ${job.status})`);
        if (job.status !== "queued") {
          await this.#patch(job.id, (j) => {
            j.status = "queued";
          });
        }
      }
    });
    await this.#pump();
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
    if (start) await this.#pump();
    return job;
  }

  async pause(id: string): Promise<DownloadJob | undefined> {
    return this.#serial(async () => {
      const current = await this.#store.get(id);
      if (!current || !isActiveJob(current)) return current;
      await this.#engine.pause(current);
      this.#running.delete(id);
      const paused = await this.#patch(id, (j) => {
        j.status = "paused";
      });
      this.#schedulePump();
      return paused;
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
    if (start && job) await this.#pump();
    return job;
  }

  async cancel(id: string, deleteFiles = true): Promise<boolean> {
    return this.#serial(async () => {
      const job = await this.#store.get(id);
      if (!job) return false;
      await this.#engine.cancel(job, deleteFiles);
      this.#running.delete(id);
      await this.#store.delete(id);
      this.#emit({ type: "job-removed", jobId: id });
      this.#schedulePump();
      return true;
    });
  }

  /** Jobs the engine is transferring right now, as opposed to waiting for a slot. */
  get running(): number {
    return this.#running.size;
  }

  /**
   * Resolves once every queued mutation, engine event and queue pump has settled.
   * Each can schedule the next, so this waits until a full pass adds nothing new.
   */
  async idle(): Promise<void> {
    for (let pass = 0; pass < 50; pass += 1) {
      const queue = this.#queue;
      const work = this.#work;
      await queue.catch(() => undefined);
      await work.catch(() => undefined);
      if (this.#queue === queue && this.#work === work) return;
    }
    this.#log("idle() gave up waiting for the job queue to settle");
  }

  /** Start as many waiting jobs as the concurrency limit allows. */
  async #pump(): Promise<void> {
    const claimed = await this.#serial(() => this.#claimSlots());
    for (const job of claimed) await this.#startEngine(job);
  }

  /** Fire a pump after the current serial task, for callers that must not await it. */
  #schedulePump(): void {
    this.#work = this.#work
      .then(
        () => this.#pump(),
        () => this.#pump(),
      )
      .catch((error: unknown) => this.#log(`queue pump failed: ${String(error)}`));
  }

  /** Take the oldest waiting jobs, up to the free slots. Callers must hold the serial queue. */
  async #claimSlots(): Promise<DownloadJob[]> {
    const free = this.#maxConcurrent - this.#running.size;
    if (free <= 0) return [];
    const waiting = (await this.#store.all())
      .filter((job) => isActiveJob(job) && !this.#running.has(job.id))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .slice(0, free);
    for (const job of waiting) this.#running.add(job.id);
    return waiting;
  }

  async #startEngine(job: DownloadJob): Promise<void> {
    try {
      await this.#engine.start(job, this.#eventsFor(job.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log(`job ${job.id}: engine failed to start: ${message}`);
      this.#running.delete(job.id);
      await this.#serial(() =>
        this.#patch(job.id, (j) => {
          j.status = "error";
          j.error = message;
        }),
      );
      this.#schedulePump();
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
      complete: (result) => {
        this.#running.delete(jobId);
        apply((j) => {
          j.status = "complete";
          j.localPath = result.localPath;
          j.totalBytes = result.totalBytes;
          j.bytesDownloaded = result.totalBytes;
          delete j.error;
        });
        this.#schedulePump();
      },
      error: (message) => {
        this.#running.delete(jobId);
        apply((j) => {
          j.status = "error";
          j.error = message;
        });
        this.#schedulePump();
      },
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
