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
  readonly #runs = new Map<string, Run>();

  constructor(options: HttpEngineOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#interval = options.progressIntervalMs ?? 500;
    this.#userAgent = options.userAgent ?? "stremio-offline/0.0.1";
    this.#now = options.now ?? Date.now;
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
        await this.#transfer(job, source, events, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) events.error(describe(error));
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

  async #transfer(job: DownloadJob, source: HttpSource, events: EngineEvents, signal: AbortSignal): Promise<void> {
    let target = job.localPath;
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
      throw new Error("upstream rejected the resume range; the partial file was discarded");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`upstream responded ${response.status}`);
    }

    let append = false;
    let total: number | undefined;
    if (response.status === 206) {
      const range = parseContentRange(response.headers.get("content-range"));
      if (!range || range.start !== offset) {
        await response.body?.cancel();
        throw new Error("upstream answered with an unexpected range");
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
      }
    }

    const progress = (bytes: number): void => {
      const update: EngineProgress = { bytesDownloaded: bytes };
      if (total !== undefined) update.totalBytes = total;
      if (target !== job.localPath) update.localPath = target;
      events.progress(update);
    };

    const body = response.body;
    if (!body) throw new Error("upstream sent no body");

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
      throw new Error(`transfer ended after ${written} of ${total} bytes`);
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
