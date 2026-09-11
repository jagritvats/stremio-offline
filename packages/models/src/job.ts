import type { MediaRef, MediaType } from "./media.ts";
import type { OfflineSource } from "./source.ts";
import type { StremioVideo } from "./stremio.ts";

export type JobStatus = "queued" | "resolving" | "downloading" | "paused" | "complete" | "error";

export const JOB_STATUSES: readonly JobStatus[] = [
  "queued",
  "resolving",
  "downloading",
  "paused",
  "complete",
  "error",
];

/** Statuses in which the engine is (or should be) working on the job. */
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["queued", "resolving", "downloading"];

export interface JobMedia extends MediaRef {
  title: string;
}

export interface DownloadJob {
  id: string;
  media: JobMedia;
  source: OfflineSource;
  /** sourceKey(source), stored for lookup. */
  sourceKey: string;
  /** Display label captured at enqueue time, e.g. "1080p WEB-DL". */
  label: string;
  quality?: string;
  status: JobStatus;
  bytesDownloaded: number;
  totalBytes?: number;
  /** Planned or final path of the downloaded file. */
  localPath: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export function isActiveJob(job: Pick<DownloadJob, "status">): boolean {
  return ACTIVE_JOB_STATUSES.includes(job.status);
}

/** Metadata snapshot so downloads stay browsable without internet (DESIGN §11). */
export interface OfflineMeta {
  type: MediaType;
  imdbId: string;
  title: string;
  poster?: string;
  background?: string;
  description?: string;
  videos?: StremioVideo[];
  savedAt: number;
}
