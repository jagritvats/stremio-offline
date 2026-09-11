import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DownloadJob } from "@stremio-offline/models";

export interface JobStore {
  init(): Promise<void>;
  all(): Promise<DownloadJob[]>;
  get(id: string): Promise<DownloadJob | undefined>;
  put(job: DownloadJob): Promise<void>;
  delete(id: string): Promise<void>;
}

export class MemoryJobStore implements JobStore {
  readonly #jobs = new Map<string, DownloadJob>();

  async init(): Promise<void> {}

  async all(): Promise<DownloadJob[]> {
    return [...this.#jobs.values()].map((job) => structuredClone(job));
  }

  async get(id: string): Promise<DownloadJob | undefined> {
    const job = this.#jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  async put(job: DownloadJob): Promise<void> {
    this.#jobs.set(job.id, structuredClone(job));
  }

  async delete(id: string): Promise<void> {
    this.#jobs.delete(id);
  }
}

interface JobsFile {
  version: 1;
  jobs: DownloadJob[];
}

/**
 * Whole-file JSON persistence with atomic replace. Good enough until the job
 * count justifies SQLite; the interface is what the rest of the code depends on.
 */
export class JsonFileJobStore implements JobStore {
  readonly #path: string;
  readonly #jobs = new Map<string, DownloadJob>();
  #writes: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async init(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<JobsFile>;
    for (const job of parsed.jobs ?? []) this.#jobs.set(job.id, job);
  }

  async all(): Promise<DownloadJob[]> {
    return [...this.#jobs.values()].map((job) => structuredClone(job));
  }

  async get(id: string): Promise<DownloadJob | undefined> {
    const job = this.#jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  async put(job: DownloadJob): Promise<void> {
    this.#jobs.set(job.id, structuredClone(job));
    await this.#flush();
  }

  async delete(id: string): Promise<void> {
    if (this.#jobs.delete(id)) await this.#flush();
  }

  #flush(): Promise<void> {
    const run = this.#writes.then(() => this.#write());
    this.#writes = run.catch(() => undefined);
    return run;
  }

  async #write(): Promise<void> {
    const file: JobsFile = { version: 1, jobs: [...this.#jobs.values()] };
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
    await rename(tmp, this.#path);
  }
}
