import type { StremioManifest } from "@stremio-offline/models";

export const ADDON_ID = "community.stremio-offline.local";
export const ADDON_NAME = "Stremio Offline";
export const CATALOG_MOVIES_ID = "stremio-offline.movies";
export const CATALOG_SERIES_ID = "stremio-offline.series";

export interface ManifestOptions {
  version: string;
  name?: string;
  description?: string;
  logo?: string;
  /** Expose the offline library catalogs and meta (DESIGN §11). Default true. */
  library?: boolean;
}

/** Manifest served at /manifest.json (DESIGN §3). */
export function buildManifest(opts: ManifestOptions): StremioManifest {
  const library = opts.library ?? true;
  const manifest: StremioManifest = {
    id: ADDON_ID,
    version: opts.version,
    name: opts.name ?? ADDON_NAME,
    description:
      opts.description ??
      "Download streams from your other addons for offline playback, then play them back from this device.",
    resources: library ? ["stream", "catalog", "meta"] : ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: library
      ? [
          { type: "movie", id: CATALOG_MOVIES_ID, name: "Offline Movies" },
          { type: "series", id: CATALOG_SERIES_ID, name: "Offline Series" },
        ]
      : [],
    behaviorHints: { configurable: false, configurationRequired: false },
  };
  if (opts.logo) manifest.logo = opts.logo;
  return manifest;
}
