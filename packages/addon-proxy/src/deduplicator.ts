import type { NormalizedSource } from "@stremio-offline/models";

/**
 * Merge sources that share an identity (infoHash + fileIdx, or URL) so one
 * torrent offered by three addons shows once with all providers (DESIGN §13).
 */
export function dedupeSources(sources: NormalizedSource[]): NormalizedSource[] {
  const byKey = new Map<string, NormalizedSource>();

  for (const candidate of sources) {
    const existing = byKey.get(candidate.key);
    if (!existing) {
      byKey.set(candidate.key, structuredClone(candidate));
      continue;
    }

    for (const provider of candidate.providers) {
      if (!existing.providers.includes(provider)) existing.providers.push(provider);
    }
    if (existing.size === undefined && candidate.size !== undefined) {
      existing.size = candidate.size;
      existing.source.size = candidate.size;
    }
    if (!existing.quality && candidate.quality) {
      existing.quality = candidate.quality;
      existing.label = candidate.label;
    }
    if (!existing.tags?.length && candidate.tags?.length) existing.tags = [...candidate.tags];
    if (!existing.source.filename && candidate.source.filename) existing.source.filename = candidate.source.filename;
    if (existing.source.type === "torrent" && candidate.source.type === "torrent") {
      const trackers = new Set([...(existing.source.trackers ?? []), ...(candidate.source.trackers ?? [])]);
      if (trackers.size > 0) existing.source.trackers = [...trackers];
    }
  }

  return [...byKey.values()];
}

const QUALITY_RANK: Readonly<Record<string, number>> = { "4K": 0, "1080p": 1, "720p": 2, "480p": 3, CAM: 9 };
const UNKNOWN_RANK = 5;

/** Best quality first, then larger files first within a quality. */
export function sortSources(sources: NormalizedSource[]): NormalizedSource[] {
  const rank = (source: NormalizedSource): number =>
    source.quality ? (QUALITY_RANK[source.quality] ?? UNKNOWN_RANK) : UNKNOWN_RANK;
  return [...sources].sort((a, b) => rank(a) - rank(b) || (b.size ?? 0) - (a.size ?? 0));
}
