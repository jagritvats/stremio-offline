import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { sendJson, type RouteHandler } from "./http.ts";
import { CORS_HEADERS } from "./router.ts";

export interface MediaFile {
  path: string;
}

/** Maps a job id to the file it may serve; undefined for anything that is not a finished download. */
export type MediaResolver = (jobId: string) => Promise<MediaFile | undefined>;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".ts": "video/mp2t",
  ".mp3": "audio/mpeg",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range` header against a file of `size` bytes.
 * null: serve the whole file (absent, malformed or multi-range headers are ignored, as RFC 9110 allows).
 * "unsatisfiable": answer 416.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText && !endText) return null;
  if (!startText) {
    const suffix = Number(endText);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  if (start >= size) return "unsatisfiable";
  const end = endText ? Math.min(Number(endText), size - 1) : size - 1;
  if (end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * GET/HEAD /media/:jobId with Range support, so Stremio's own player can seek
 * (DESIGN §10). Only files the resolver hands out are ever served: the id is a
 * job id, never a path (DESIGN §21).
 */
export function mediaRoute(resolve: MediaResolver): RouteHandler {
  return async ({ req, res, url, method }) => {
    const match = /^\/media\/([^/]+)$/.exec(url.pathname);
    if (!match) return false;
    const base: Record<string, string> = { ...CORS_HEADERS, "Accept-Ranges": "bytes" };

    if (method === "OPTIONS") {
      res.writeHead(204, base);
      res.end();
      return true;
    }
    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { error: "method not allowed" }, base);
      return true;
    }

    let jobId = match[1] ?? "";
    try {
      jobId = decodeURIComponent(jobId);
    } catch {
      // keep the raw id
    }
    const file = await resolve(jobId);
    const info = file ? await stat(file.path).catch(() => undefined) : undefined;
    if (!file || !info?.isFile()) {
      sendJson(res, 404, { error: "not found" }, base);
      return true;
    }

    const size = info.size;
    const range = parseRange(req.headers.range, size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { ...base, "Content-Range": `bytes */${size}` });
      res.end();
      return true;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const headers: Record<string, string> = {
      ...base,
      "Content-Type": contentTypeFor(file.path),
      "Content-Length": String(size === 0 ? 0 : end - start + 1),
      "Last-Modified": info.mtime.toUTCString(),
      "Cache-Control": "no-store",
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);

    if (method === "HEAD" || size === 0) {
      res.end();
      return true;
    }
    const stream = createReadStream(file.path, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return true;
  };
}
