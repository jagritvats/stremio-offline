import {
  sourceKey,
  type HttpSource,
  type NormalizedSource,
  type OfflineSource,
  type StremioStream,
  type StremioStreamBehaviorHints,
  type TorrentSource,
} from "@stremio-offline/models";

const HEX_HASH = /^[0-9a-f]{40}$/i;
const BASE32_HASH = /^[a-z2-7]{32}$/i;

export function isInfoHash(value: string): boolean {
  return HEX_HASH.test(value) || BASE32_HASH.test(value);
}

/** Parse a magnet URI into a torrent source; null when it carries no usable btih. */
export function parseMagnet(uri: string): TorrentSource | null {
  if (!/^magnet:\?/i.test(uri)) return null;
  const params = new URLSearchParams(uri.slice("magnet:?".length));
  const xt = params.getAll("xt").find((value) => /^urn:btih:/i.test(value));
  if (!xt) return null;
  const infoHash = xt.slice("urn:btih:".length);
  if (!isInfoHash(infoHash)) return null;
  const source: TorrentSource = { type: "torrent", infoHash: infoHash.toLowerCase() };
  const trackers = params.getAll("tr").filter((tracker) => tracker.length > 0);
  if (trackers.length > 0) source.trackers = trackers;
  const displayName = params.get("dn");
  if (displayName) source.filename = displayName;
  return source;
}

/** Stream.sources entries look like "tracker:udp://..." or "dht:<hash>". */
export function extractTrackers(sources: string[] | undefined): string[] {
  return (sources ?? [])
    .filter((entry) => entry.startsWith("tracker:"))
    .map((entry) => entry.slice("tracker:".length))
    .filter((tracker) => tracker.length > 0);
}

function applyHints<T extends OfflineSource>(source: T, hints: StremioStreamBehaviorHints | undefined): T {
  if (hints?.filename) source.filename = hints.filename;
  if (typeof hints?.videoSize === "number" && hints.videoSize > 0) source.size = Math.round(hints.videoSize);
  return source;
}

/** Reduce a Stream Object to a downloadable source; null for ytId / externalUrl / unsupported schemes. */
export function toOfflineSource(stream: StremioStream): OfflineSource | null {
  const hints = stream.behaviorHints;

  if (typeof stream.infoHash === "string" && isInfoHash(stream.infoHash)) {
    const torrent: TorrentSource = { type: "torrent", infoHash: stream.infoHash.toLowerCase() };
    if (typeof stream.fileIdx === "number" && Number.isInteger(stream.fileIdx) && stream.fileIdx >= 0) {
      torrent.fileIdx = stream.fileIdx;
    }
    const trackers = extractTrackers(stream.sources);
    if (trackers.length > 0) torrent.trackers = trackers;
    return applyHints(torrent, hints);
  }

  if (typeof stream.url === "string") {
    const magnet = parseMagnet(stream.url);
    if (magnet) return applyHints(magnet, hints);
    if (/^https?:\/\//i.test(stream.url)) {
      const http: HttpSource = { type: "http", url: stream.url };
      const requestHeaders = hints?.proxyHeaders?.request;
      if (requestHeaders && Object.keys(requestHeaders).length > 0) http.requestHeaders = { ...requestHeaders };
      return applyHints(http, hints);
    }
  }

  return null;
}

const QUALITY_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(2160p|4k|uhd)\b/i, "4K"],
  [/\b1080p\b/i, "1080p"],
  [/\b720p\b/i, "720p"],
  [/\b480p\b/i, "480p"],
  [/\b(cam|camrip|hdcam|hdts|telesync|telecine)\b/i, "CAM"],
];

const TAG_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bremux\b/i, "REMUX"],
  [/\b(blu-?ray|bdrip|brrip)\b/i, "BluRay"],
  [/\bweb-?dl\b/i, "WEB-DL"],
  [/\bwebrip\b/i, "WEBRip"],
  [/\bhdtv\b/i, "HDTV"],
  [/\b(dv|dolby\.?vision)\b/i, "DV"],
  [/\bhdr(10\+?)?\b/i, "HDR"],
  [/\b(x265|hevc|h\.?265)\b/i, "HEVC"],
];

export function detectQuality(text: string): string | undefined {
  return QUALITY_RULES.find(([pattern]) => pattern.test(text))?.[1];
}

export function detectTags(text: string): string[] {
  return TAG_RULES.filter(([pattern]) => pattern.test(text)).map(([, tag]) => tag);
}

const SIZE_UNITS: Readonly<Record<string, number>> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

/** Find a size such as "💾 9.38 GB" in provider text. */
export function parseSizeText(text: string): number | undefined {
  const match = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)\b/i.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]?.replace(",", "."));
  const multiplier = SIZE_UNITS[match[2]?.toUpperCase() ?? ""];
  if (!Number.isFinite(value) || multiplier === undefined) return undefined;
  return Math.round(value * multiplier);
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0);
  return line ? line.slice(0, 60) : undefined;
}

/** Normalise one upstream Stream Object from `provider`; null if it cannot be downloaded. */
export function normalizeStream(stream: StremioStream, provider: string): NormalizedSource | null {
  const source = toOfflineSource(stream);
  if (!source) return null;

  const text = [stream.name, stream.title, stream.description, source.filename]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  const quality = detectQuality(text);
  const tags = detectTags(text);
  const size = source.size ?? parseSizeText(text);
  if (size !== undefined && source.size === undefined) source.size = size;

  const parts = [quality, ...tags.slice(0, 2)].filter((part): part is string => !!part);
  const label = parts.length > 0 ? parts.join(" ") : (firstLine(stream.title ?? stream.description) ?? "Unknown quality");

  const normalized: NormalizedSource = { key: sourceKey(source), source, providers: [provider], label };
  if (quality) normalized.quality = quality;
  if (tags.length > 0) normalized.tags = tags;
  if (size !== undefined) normalized.size = size;
  return normalized;
}

export function normalizeStreams(streams: StremioStream[], provider: string): NormalizedSource[] {
  return streams
    .map((stream) => normalizeStream(stream, provider))
    .filter((source): source is NormalizedSource => source !== null);
}
