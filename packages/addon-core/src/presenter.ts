import type {
  DownloadJob,
  NormalizedSource,
  StremioStream,
  StremioStreamBehaviorHints,
} from "@stremio-offline/models";
import { formatBytes, formatPercent } from "./format.ts";

export const DEFAULT_ACTION_SCHEME = "stremio-offline";

export interface PresenterOptions {
  /** Base URL of the local runtime as reachable by Stremio's player, e.g. "http://127.0.0.1:34701". */
  mediaBaseUrl: string;
  /** URI scheme registered with the OS for action dispatch. */
  actionScheme?: string;
}

/** Build an action URI such as "stremio-offline://enqueue/<token>". */
export function actionUri(scheme: string, action: string, ...parts: string[]): string {
  const tail = parts.map((part) => encodeURIComponent(part)).join("/");
  return `${scheme}://${action}${tail ? `/${tail}` : ""}`;
}

export function mediaUrl(mediaBaseUrl: string, jobId: string): string {
  return `${mediaBaseUrl.replace(/\/+$/, "")}/media/${encodeURIComponent(jobId)}`;
}

function heading(prefix: string, quality: string | undefined): string {
  return quality ? `${prefix} • ${quality}` : prefix;
}

function describe(...lines: Array<string | undefined>): string {
  return lines.filter((line): line is string => typeof line === "string" && line.length > 0).join("\n");
}

function withSize(label: string, size: number | undefined): string {
  const formatted = formatBytes(size);
  return formatted ? `${label} • ${formatted}` : label;
}

/** "⬇ OFFLINE" entry: tapping it enqueues the source (DESIGN §6). */
export function downloadActionStream(
  source: NormalizedSource,
  token: string,
  opts: PresenterOptions,
): StremioStream {
  const scheme = opts.actionScheme ?? DEFAULT_ACTION_SCHEME;
  return {
    name: heading("⬇ OFFLINE", source.quality),
    description: describe(withSize(source.label, source.size), source.providers.join(" + ")),
    externalUrl: actionUri(scheme, "enqueue", token),
  };
}

/** "✅ OFFLINE" entry: a direct URL Stremio's player streams from the local runtime (DESIGN §10). */
export function completedStream(job: DownloadJob, opts: PresenterOptions): StremioStream {
  const hints: StremioStreamBehaviorHints = {
    bingeGroup: job.quality ? `stremio-offline-${job.quality}` : "stremio-offline",
  };
  const filename = job.localPath.split(/[\\/]/).pop();
  if (filename) hints.filename = filename;
  if (job.totalBytes) hints.videoSize = job.totalBytes;
  return {
    name: heading("✅ OFFLINE", job.quality),
    description: describe(withSize(job.label, job.totalBytes), "Stored on this device"),
    url: mediaUrl(opts.mediaBaseUrl, job.id),
    behaviorHints: hints,
  };
}

/** Entry reflecting a job that is queued, transferring, paused or failed (DESIGN §9). */
export function jobStatusStream(job: DownloadJob, opts: PresenterOptions): StremioStream {
  const scheme = opts.actionScheme ?? DEFAULT_ACTION_SCHEME;
  const percent = formatPercent(job.bytesDownloaded, job.totalBytes);
  const total = formatBytes(job.totalBytes);
  const done = formatBytes(job.bytesDownloaded) ?? "0 B";
  const progressLine = total ? `${job.label} • ${done} / ${total}` : job.label;

  switch (job.status) {
    case "complete":
      return completedStream(job, opts);
    case "queued":
      return {
        name: "🕓 QUEUED",
        description: describe(withSize(job.label, job.totalBytes), "Waiting to start"),
        externalUrl: actionUri(scheme, "job", job.id),
      };
    case "resolving":
    case "downloading":
      return {
        name: percent ? `⏳ ${percent} DOWNLOADED` : "⏳ DOWNLOADING",
        description: describe(progressLine, "Tap to pause"),
        externalUrl: actionUri(scheme, "pause", job.id),
      };
    case "paused":
      return {
        name: percent ? `⏸ PAUSED • ${percent}` : "⏸ PAUSED",
        description: describe(progressLine, "Tap to resume"),
        externalUrl: actionUri(scheme, "resume", job.id),
      };
    case "error":
      return {
        name: "⚠ FAILED",
        description: describe(job.label, job.error ?? "Download failed", "Tap to retry"),
        externalUrl: actionUri(scheme, "retry", job.id),
      };
  }
}

/** Pick the stream entry for a source given the job (if any) already attached to it. */
export function presentSource(
  source: NormalizedSource,
  job: DownloadJob | undefined,
  token: string,
  opts: PresenterOptions,
): StremioStream {
  return job ? jobStatusStream(job, opts) : downloadActionStream(source, token, opts);
}
