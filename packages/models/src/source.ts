export interface TorrentSource {
  type: "torrent";
  /** Lower-case hex (40 chars) or base32 (32 chars) info hash. */
  infoHash: string;
  /** Index of the wanted file inside the torrent; whole torrent when absent. */
  fileIdx?: number;
  trackers?: string[];
  filename?: string;
  size?: number;
}

export interface HttpSource {
  type: "http";
  url: string;
  requestHeaders?: Record<string, string>;
  filename?: string;
  size?: number;
}

export type OfflineSource = TorrentSource | HttpSource;

/** Stable identity of a source: torrent = infoHash + fileIdx, http = url. */
export function sourceKey(source: OfflineSource): string {
  if (source.type === "torrent") {
    return `torrent:${source.infoHash.toLowerCase()}:${source.fileIdx ?? "-"}`;
  }
  return `http:${source.url}`;
}

/** A configured upstream stream addon. manifestUrl may embed user credentials: never log it. */
export interface SourceAddon {
  id: string;
  name: string;
  manifestUrl: string;
  transportUrl: string;
  enabled: boolean;
}

/** Derive the addon transport base URL from its manifest URL. */
export function transportUrlFromManifestUrl(manifestUrl: string): string {
  let url = manifestUrl.trim().replace(/^stremio:\/\//i, "https://");
  url = url.replace(/\/manifest\.json(\?.*)?$/i, "");
  return url.replace(/\/+$/, "");
}

/** An upstream stream reduced to something we can download, plus display metadata. */
export interface NormalizedSource {
  /** sourceKey(source) */
  key: string;
  source: OfflineSource;
  /** Names of the upstream addons that offered this source. */
  providers: string[];
  /** Short heading, e.g. "1080p WEB-DL". */
  label: string;
  /** Detected quality bucket, e.g. "4K", "1080p", "CAM". */
  quality?: string;
  /** Extra tags such as "REMUX", "HDR". */
  tags?: string[];
  size?: number;
}
