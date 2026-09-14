import type {
  CatalogResponse,
  DownloadJob,
  MediaType,
  MetaResponse,
  OfflineMeta,
  StremioMeta,
  StremioMetaPreview,
  StremioVideo,
} from "@stremio-offline/models";

const PAGE_SIZE = 100;

/** Snapshot a Stremio meta so the title stays browsable without internet (DESIGN §11). */
export function snapshotMeta(meta: StremioMeta, type: MediaType, now: number = Date.now()): OfflineMeta {
  const snapshot: OfflineMeta = { type, imdbId: meta.id, title: meta.name, savedAt: now };
  if (meta.poster) snapshot.poster = meta.poster;
  if (meta.background) snapshot.background = meta.background;
  if (meta.description) snapshot.description = meta.description;
  if (meta.videos?.length) snapshot.videos = meta.videos.map((video) => ({ ...video }));
  return snapshot;
}

/**
 * A job belongs in the library when it holds bytes, or will. A failed download
 * holds nothing: listing it under "Offline Movies" promises a title that cannot
 * be played and, once every job for it has failed, nothing there can fix it.
 */
export function isLibraryJob(job: Pick<DownloadJob, "status">): boolean {
  return job.status !== "error";
}

/** Title-level ids of this type that the library should show, most recently touched first. */
export function libraryMediaIds(type: MediaType, jobs: DownloadJob[]): string[] {
  const latest = new Map<string, number>();
  for (const job of jobs) {
    if (job.media.type !== type || !isLibraryJob(job)) continue;
    latest.set(job.media.mediaId, Math.max(latest.get(job.media.mediaId) ?? 0, job.updatedAt));
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

function titleOf(mediaId: string, jobs: DownloadJob[]): string {
  return jobs.find((job) => job.media.mediaId === mediaId)?.media.title || mediaId;
}

/** A catalog row: the snapshot when there is one, else what the jobs know. */
export function catalogEntry(
  type: MediaType,
  mediaId: string,
  jobs: DownloadJob[],
  meta: OfflineMeta | undefined,
): StremioMetaPreview {
  if (!meta) return { id: mediaId, type, name: titleOf(mediaId, jobs), description: "Downloaded with Stremio Offline" };
  const entry: StremioMetaPreview = { id: meta.imdbId, type, name: meta.title, posterShape: "poster" };
  if (meta.poster) entry.poster = meta.poster;
  if (meta.background) entry.background = meta.background;
  if (meta.description) entry.description = meta.description;
  return entry;
}

/** "Offline Movies" / "Offline Series": every title with a job, searchable and paged the Stremio way. */
export function buildCatalog(
  type: MediaType,
  jobs: DownloadJob[],
  metas: ReadonlyMap<string, OfflineMeta>,
  extra: Record<string, string>,
): CatalogResponse {
  const search = extra["search"]?.trim().toLowerCase() ?? "";
  const skip = Math.max(0, Number(extra["skip"]) || 0);
  const entries = libraryMediaIds(type, jobs).map((id) => catalogEntry(type, id, jobs, metas.get(id)));
  const matching = search ? entries.filter((entry) => entry.name.toLowerCase().includes(search)) : entries;
  return { metas: matching.slice(skip, skip + PAGE_SIZE) };
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Meta for a title we hold; null when we hold nothing, so Stremio asks its other addons. */
export function buildMeta(
  type: MediaType,
  mediaId: string,
  jobs: DownloadJob[],
  meta: OfflineMeta | undefined,
): MetaResponse | null {
  const mine = jobs.filter((job) => job.media.type === type && job.media.mediaId === mediaId && isLibraryJob(job));
  if (!meta && mine.length === 0) return null;

  const full: StremioMeta = catalogEntry(type, mediaId, mine, meta);
  if (meta?.videos?.length) {
    full.videos = meta.videos;
  } else if (type === "series") {
    // No snapshot: list the episodes we have, so they stay reachable offline.
    const videos = new Map<string, StremioVideo>();
    for (const job of mine) {
      const { videoId, season, episode } = job.media;
      if (!videoId || season === undefined || episode === undefined) continue;
      videos.set(videoId, { id: videoId, title: `S${pad2(season)}E${pad2(episode)}`, season, episode });
    }
    full.videos = [...videos.values()].sort(
      (a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0),
    );
  }
  return { meta: full };
}
