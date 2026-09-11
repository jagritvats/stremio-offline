export type MediaType = "movie" | "series";

export const MEDIA_TYPES: readonly MediaType[] = ["movie", "series"];

export function isMediaType(value: string): value is MediaType {
  return (MEDIA_TYPES as readonly string[]).includes(value);
}

/** Identifies what the user is looking at in Stremio: a movie, or one episode of a series. */
export interface MediaRef {
  type: MediaType;
  /** Title-level id, e.g. "tt0816692". */
  mediaId: string;
  /** Video-level id, e.g. "tt11280740:2:4" for an episode; equals mediaId for movies. */
  videoId?: string;
  season?: number;
  episode?: number;
  title?: string;
}

/**
 * Parse the id Stremio passes to /stream/:type/:id.
 * Series ids look like "tt11280740:2:4" (imdb:season:episode).
 */
export function parseMediaId(type: MediaType, id: string): MediaRef {
  const trimmed = id.trim();
  if (type === "series") {
    const parts = trimmed.split(":");
    const mediaId = parts[0] ?? trimmed;
    const ref: MediaRef = { type, mediaId, videoId: trimmed };
    if (parts.length >= 3) {
      const season = Number(parts[1]);
      const episode = Number(parts[2]);
      if (Number.isInteger(season)) ref.season = season;
      if (Number.isInteger(episode)) ref.episode = episode;
    }
    return ref;
  }
  return { type, mediaId: trimmed, videoId: trimmed };
}

/** Key identifying the exact playable item (movie or episode) a job belongs to. */
export function mediaScopeKey(ref: Pick<MediaRef, "type" | "mediaId" | "videoId">): string {
  return `${ref.type}:${ref.videoId ?? ref.mediaId}`;
}
