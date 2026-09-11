/**
 * Subset of the Stremio addon protocol used by Stremio Offline.
 * Reference: https://github.com/Stremio/stremio-addon-sdk/tree/master/docs/api/responses
 */

export interface StremioManifestResource {
  name: string;
  types: string[];
  idPrefixes?: string[];
}

export interface StremioCatalogExtra {
  name: string;
  isRequired?: boolean;
  options?: string[];
  optionsLimit?: number;
}

export interface StremioManifestCatalog {
  type: string;
  id: string;
  name: string;
  extra?: StremioCatalogExtra[];
}

export interface StremioManifestBehaviorHints {
  adult?: boolean;
  p2p?: boolean;
  configurable?: boolean;
  configurationRequired?: boolean;
}

export interface StremioManifest {
  id: string;
  version: string;
  name: string;
  description?: string;
  logo?: string;
  background?: string;
  contactEmail?: string;
  resources: Array<string | StremioManifestResource>;
  types: string[];
  idPrefixes?: string[];
  catalogs: StremioManifestCatalog[];
  behaviorHints?: StremioManifestBehaviorHints;
}

export interface StremioProxyHeaders {
  request?: Record<string, string>;
  response?: Record<string, string>;
}

export interface StremioStreamBehaviorHints {
  countryWhitelist?: string[];
  notWebReady?: boolean;
  bingeGroup?: string;
  proxyHeaders?: StremioProxyHeaders;
  videoHash?: string;
  videoSize?: number;
  filename?: string;
}

export interface StremioSubtitle {
  id: string;
  url: string;
  lang: string;
}

/** A Stream Object. Exactly one of url / ytId / infoHash / externalUrl is expected. */
export interface StremioStream {
  url?: string;
  ytId?: string;
  infoHash?: string;
  fileIdx?: number;
  externalUrl?: string;
  name?: string;
  title?: string;
  description?: string;
  sources?: string[];
  subtitles?: StremioSubtitle[];
  behaviorHints?: StremioStreamBehaviorHints;
}

export interface StremioVideo {
  id: string;
  title: string;
  released?: string;
  thumbnail?: string;
  season?: number;
  episode?: number;
  overview?: string;
  available?: boolean;
}

export interface StremioMetaPreview {
  id: string;
  type: string;
  name: string;
  poster?: string;
  posterShape?: "square" | "poster" | "landscape";
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  imdbRating?: string;
  genres?: string[];
}

export interface StremioMeta extends StremioMetaPreview {
  videos?: StremioVideo[];
  runtime?: string;
  released?: string;
  language?: string;
  country?: string;
  behaviorHints?: { defaultVideoId?: string | null };
}

export interface StreamsResponse {
  streams: StremioStream[];
}

export interface CatalogResponse {
  metas: StremioMetaPreview[];
}

export interface MetaResponse {
  meta: StremioMeta;
}
