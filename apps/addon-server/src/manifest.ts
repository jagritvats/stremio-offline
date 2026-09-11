// The manifest Stremio fetches when someone installs this addon by URL.
//
// Shape is fixed by DESIGN.md section 3: stream + catalog + meta over movie and
// series, `tt` ids. `catalog` and `meta` are not optional extras — they are what
// keeps a finished download browsable inside Stremio with no internet, which is
// the entire product.

import type { IncomingConfig } from "./config.ts";

export type Manifest = {
  id: string;
  version: string;
  name: string;
  description: string;
  logo?: string;
  resources: string[];
  types: string[];
  idPrefixes: string[];
  catalogs: Array<{ type: string; id: string; name: string; extra?: unknown[] }>;
  behaviorHints: Record<string, boolean>;
};

// Bumping this is what makes an installed client re-fetch the manifest. Stremio
// caches it, so a change to resources or catalogs that does NOT bump the version
// reaches nobody who already installed the addon.
export const ADDON_VERSION = "0.0.1";

export function buildManifest(config: IncomingConfig): Manifest {
  // With no upstream source addons configured there is nothing to mirror, so the
  // addon declares `configurationRequired` and Stremio sends the user to
  // `/configure` instead of installing an addon that could only ever answer with
  // empty stream lists.
  const configured = config.sources.length > 0;

  return {
    id: "app.synpse.soffline",
    version: ADDON_VERSION,
    name: "Stremio Offline",
    description:
      "Mirrors the streams of your existing source addons as downloadable entries. " +
      "Pair with the Stremio Offline runtime on your device to keep them for offline playback.",
    resources: ["stream", "catalog", "meta"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],

    // One catalog: what this user has taken offline. It is served by the local
    // runtime, not by this host — see the note in main.ts about why the hosted
    // half can never answer it on its own.
    catalogs: [
      { type: "movie", id: "soffline-movies", name: "Offline — Movies" },
      { type: "series", id: "soffline-series", name: "Offline — Series" },
    ],

    behaviorHints: {
      configurable: true,
      configurationRequired: !configured,
    },
  };
}
