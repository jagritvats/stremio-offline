import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { DownloadJob, HttpSource, OfflineSource } from "@stremio-offline/models";
import type { DownloadEngine, EngineEvents, EngineProgress } from "./manager.ts";

export interface HttpEngineOptions {
  /** Injected by tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Least time between two progress events for one job. Default 500 ms. */
  progressIntervalMs?: number;
  userAgent?: string;
  now?: () => number;
  /** Retries after a transient failure, on top of the first attempt. Default 3. */
  retries?: number;
  /** First backoff, doubled each retry. Default 2000 ms. */
  retryDelayMs?: number;
  log?: (message: string) => void;
}

/** Validators saved next to a partial file, so a resume can ask the server whether the file changed. */
interface PartMeta {
  etag?: string;
  lastModified?: string;
}

interface Run {
  controller: AbortController;
  done: Promise<void>;
}

/** Where one job's bytes are going, carried across retries of the same transfer. */
interface TransferState {
  /** The path the manager planned, before any extension was learned. */
  planned: string;
  /** Where the bytes actually go now. */
  target: string;
}

const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  "video/mp4": ".mp4",
  "video/x-matroska": ".mkv",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "video/mp2t": ".ts",
};

const EXTENSION = /^\.[a-z0-9]{1,5}$/i;

export function partPath(localPath: string): string {
  return `${localPath}.part`;
}

function partMetaPath(localPath: string): string {
  return `${localPath}.part.json`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The extension the server suggests: Content-Disposition first, then the URL path, then the content type. */
export function suggestedExtension(contentDisposition: string | null, url: string, contentType: string | null): string {
  const disposition = /filename\*=(?:utf-8'')?([^;]+)|filename="([^"]+)"|filename=([^;]+)/i.exec(contentDisposition ?? "");
  const name = disposition?.[1] ?? disposition?.[2] ?? disposition?.[3];
  const fromDisposition = name ? extname(safeDecode(name.trim())) : "";
  if (EXTENSION.test(fromDisposition)) return fromDisposition.toLowerCase();
  try {
    const fromPath = extname(new URL(url).pathname);
    if (EXTENSION.test(fromPath)) return fromPath.toLowerCase();
  } catch {
    // not a URL; fall through
  }
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSION_BY_TYPE[type] ?? "";
}

export function parseContentRange(header: string | null): { start: number; end: number; total?: number } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(header ?? "");
  if (!match) return undefined;
  const range = { start: Number(match[1]), end: Number(match[2]) };
  return match[3] === "*" ? range : { ...range, total: Number(match[3]) };
}

/**
 * A failure of one transfer attempt. `transient` says whether trying again could
 * plausibly work: a dropped connection or a 503 yes, a 404 or a full disk no.
 */
class TransferError extends Error {
  readonly transient: boolean;

  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "TransferError";
    this.transient = transient;
  }
}

/** Permanent local failures. Retrying a full disk just fails again, more slowly. */
const FATAL_FS_CODES = new Set(["ENOSPC", "EACCES", "EPERM", "EROFS", "EISDIR", "ENAMETOOLONG"]);

export function isTransientFailure(error: unknown): boolean {
  if (error instanceof TransferError) return error.transient;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && FATAL_FS_CODES.has(code)) return false;
  // Everything left is a fetch-level failure: a reset, a DNS blip, a dropped TLS session.
  return true;
}

/** HTTP statuses worth trying again: overload, rate limit, request timeout. */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/** A timer that gives up as soon as the job is paused or cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Error text that never carries the URL: upstream URLs can embed credentials. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = typeof cause?.code === "string" ? ` (${cause.code})` : "";
  return `${error.message}${code}`;
}

/**
 * Downloads `http` sources with Range resume (DESIGN §5). The transfer runs
 * in the background after `start` returns; a partial file lives at
 * `<localPath>.part` until it is complete, which is what makes a restart
 * continue where the previous process stopped.
 */
export class HttpEngine implements DownloadEngine {
  readonly #fetch: typeof globalThis.fetch;
  readonly #interval: number;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly #retries: number;
  readonly #retryDelayMs: number;
  readonly #log: (message: string) => void;
  readonly #runs = new Map<string, Run>();

  constructor(options: HttpEngineOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#interval = options.progressIntervalMs ?? 500;
    this.#userAgent = options.userAgent ?? "stremio-offline/0.0.1";
    this.#now = options.now ?? Date.now;
    this.#retries = Math.max(0, Math.floor(options.retries ?? 3));
    this.#retryDelayMs = Math.max(0, options.retryDelayMs ?? 2000);
    this.#log = options.log ?? (() => {});
  }

  supports(source: OfflineSource): boolean {
    return source.type === "http";
  }

  start(job: DownloadJob, events: EngineEvents): void {
    if (job.source.type !== "http") {
      events.error(`HttpEngine cannot download a ${job.source.type} source`);
      return;
    }
    const source = job.source;
    const previous = this.#runs.get(job.id);
    const controller = new AbortController();
    const run: Run = { controller, done: Promise.resolve() };
    run.done = (async () => {
      if (previous) {
        previous.controller.abort();
        await previous.done;
      }
      try {
        await this.#attempt(job, source, events, controller.signal);
      } finally {
        if (this.#runs.get(job.id) === run) this.#runs.delete(job.id);
      }
    })();
    this.#runs.set(job.id, run);
  }

  /** Stops the transfer and keeps the partial file for a later resume. */
  async pause(job: DownloadJob): Promise<void> {
    const run = this.#runs.get(job.id);
    if (!run) return;
    run.controller.abort();
    await run.done;
  }

  async cancel(job: DownloadJob, deleteFiles: boolean): Promise<void> {
    await this.pause(job);
    if (!deleteFiles || !job.localPath) return;
    for (const path of [partPath(job.localPath), partMetaPath(job.localPath), job.localPath]) {
      await rm(path, { force: true });
    }
  }

  /**
   * One transfer, retried with a doubling backoff while the failure looks
   * transient. Each retry resumes from the partial file, so a blip at 90% costs
   * the blip and not the 90%.
   */
  async #attempt(job: DownloadJob, source: HttpSource, events: EngineEvents, signal: AbortSignal): Promise<void> {
    // Shared across attempts: the first response may rename the target by adding
    // the extension the server implies, and a retry has to resume from THAT
    // partial file rather than start a second one under the original name.
    const state: TransferState = { planned: job.localPath, target: job.localPath };
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#transfer(state, source, events, signal);
        return;
      } catch (error) {
        if (signal.aborted) return;
        const detail = describe(error);
        if (attempt >= this.#retries || !isTransientFailure(error)) {
          events.error(detail);
          return;
        }
        const delay = this.#retryDelayMs * 2 ** attempt;
        this.#log(`job ${job.id}: ${detail}; retrying in ${Math.round(delay / 100) / 10}s (${attempt + 1}/${this.#retries})`);
        await sleep(delay, signal);
        if (signal.aborted) return;
      }
    }
  }

  async #transfer(state: TransferState, source: HttpSource, events: EngineEvents, signal: AbortSignal): Promise<void> {
    let target = state.target;
    let part = partPath(target);
    let offset = (await stat(part).catch(() => undefined))?.size ?? 0;
    const saved = offset > 0 ? await readPartMeta(target) : undefined;

    // Upstream proxy headers first, lower-cased so ours replace rather than duplicate them.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(source.requestHeaders ?? {})) headers[name.toLowerCase()] = value;
    headers["user-agent"] ??= this.#userAgent;
    if (offset > 0) {
      headers["range"] = `bytes=${offset}-`;
      const validator = saved?.etag ?? saved?.lastModified;
      if (validator) headers["if-range"] = validator;
    }

    events.status("resolving");
    const response = await this.#fetch(source.url, { headers, signal, redirect: "follow" });

    if (response.status === 416) {
      // The partial file is at least as long as the server's copy. Equal means done; anything else means start over.
      const total = parseContentRange(response.headers.get("content-range"))?.total;
      await response.body?.cancel();
      if (total !== undefined && total === offset) {
        await this.#finish(target, offset, events);
        return;
      }
      await rm(part, { force: true });
      // The partial file is gone, so a retry starts from zero and can succeed.
      throw new TransferError("upstream rejected the resume range; the partial file was discarded", true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TransferError(`upstream responded ${response.status}`, isTransientStatus(response.status));
    }

    let append = false;
    let total: number | undefined;
    if (response.status === 206) {
      const range = parseContentRange(response.headers.get("content-range"));
      if (!range || range.start !== offset) {
        await response.body?.cancel();
        throw new TransferError("upstream answered with an unexpected range", false);
      }
      append = true;
      if (range.total !== undefined) total = range.total;
    } else {
      // 200: the whole file, because the server ignores Range or the file changed under If-Range. Start over.
      offset = 0;
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > 0) total = length;
    }

    // First contact with the server is the moment the real filename becomes known.
    if (offset === 0 && !extname(target)) {
      const extension = suggestedExtension(
        response.headers.get("content-disposition"),
        response.url || source.url,
        response.headers.get("content-type"),
      );
      if (extension) {
        target = `${target}${extension}`;
        part = partPath(target);
        state.target = target;
      }
    }

    const progress = (bytes: number): void => {
      const update: EngineProgress = { bytesDownloaded: bytes };
      if (total !== undefined) update.totalBytes = total;
      if (target !== state.planned) update.localPath = target;
      events.progress(update);
    };

    const body = response.body;
    if (!body) throw new TransferError("upstream sent no body", false);

    await mkdir(dirname(part), { recursive: true });
    const validators: PartMeta = {};
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    if (etag) validators.etag = etag;
    if (lastModified) validators.lastModified = lastModified;
    await writeFile(partMetaPath(target), JSON.stringify(validators), "utf8");

    progress(offset);
    const handle = await open(part, append ? "a" : "w");
    let written = offset;
    let lastEmit = this.#now();
    try {
      for await (const chunk of body) {
        await handle.write(chunk);
        written += chunk.byteLength;
        const now = this.#now();
        if (now - lastEmit >= this.#interval) {
          lastEmit = now;
          progress(written);
        }
      }
    } finally {
      await handle.close();
    }

    if (total !== undefined && written !== total) {
      // A short body is a dropped connection: the next attempt resumes from what landed.
      throw new TransferError(`transfer ended after ${written} of ${total} bytes`, true);
    }
    await this.#finish(target, written, events);
  }

  async #finish(target: string, bytes: number, events: EngineEvents): Promise<void> {
    await rename(partPath(target), target);
    await rm(partMetaPath(target), { force: true });
    events.complete({ localPath: target, totalBytes: bytes });
  }
}

async function readPartMeta(target: string): Promise<PartMeta | undefined> {
  try {
    return JSON.parse(await readFile(partMetaPath(target), "utf8")) as PartMeta;
  } catch {
    return undefined;
  }
}
