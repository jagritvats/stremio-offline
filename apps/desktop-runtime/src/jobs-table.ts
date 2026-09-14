import { formatBytes, formatPercent } from "@stremio-offline/addon-core";
import type { DownloadJob } from "@stremio-offline/models";

/** Short id, enough to type back into a command, long enough not to collide. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

function progressOf(job: DownloadJob): string {
  if (job.status === "complete") return formatBytes(job.totalBytes) ?? "done";
  const percent = formatPercent(job.bytesDownloaded, job.totalBytes);
  const done = formatBytes(job.bytesDownloaded) ?? "0 B";
  const total = formatBytes(job.totalBytes);
  if (percent && total) return `${percent}  ${done} / ${total}`;
  return job.bytesDownloaded > 0 ? done : total ? `— / ${total}` : "—";
}

/** One line per job, columns padded to line up. Never prints a URL. */
export function jobsTable(jobs: DownloadJob[]): string[] {
  if (jobs.length === 0) return ["no downloads yet"];
  const rows = [...jobs]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((job) => {
      const title = job.media.season !== undefined && job.media.episode !== undefined
        ? `${job.media.title} S${String(job.media.season).padStart(2, "0")}E${String(job.media.episode).padStart(2, "0")}`
        : job.media.title;
      return {
        id: shortId(job.id),
        status: job.status,
        progress: progressOf(job),
        detail: `${title} • ${job.label}${job.status === "error" && job.error ? `  (${job.error})` : ""}`,
      };
    });
  const width = (pick: (row: (typeof rows)[number]) => string): number =>
    Math.max(...rows.map((row) => pick(row).length));
  const statusWidth = width((row) => row.status);
  const progressWidth = width((row) => row.progress);
  return rows.map(
    (row) => `${row.id}  ${row.status.padEnd(statusWidth)}  ${row.progress.padEnd(progressWidth)}  ${row.detail}`,
  );
}

/** Resolve a short id typed by the user back to a full job id. */
export function resolveJobId(jobs: DownloadJob[], typed: string): string {
  const matches = jobs.filter((job) => job.id === typed || job.id.startsWith(typed));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) throw new Error(`no job matches "${typed}"; run \`pnpm runtime jobs\` to list them`);
  throw new Error(`"${typed}" matches ${matches.length} jobs; use more characters`);
}
