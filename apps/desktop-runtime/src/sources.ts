// Source addon management for the CLI. The runtime re-reads runtime.json on
// every stream request, so changes made here reach a running runtime without a
// restart. Changing the storage folder does need one.

import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { UpstreamClient } from "@stremio-offline/addon-proxy";
import { transportUrlFromManifestUrl, type SourceAddon } from "@stremio-offline/models";
import { loadOrCreateConfig, updateConfig } from "./config.ts";

/** Host only: a manifest URL can carry credentials, so this is the only form of one that gets printed. */
export function describeSource(source: SourceAddon): string {
  let host = "?";
  try {
    host = new URL(source.manifestUrl).host;
  } catch {
    // keep "?"
  }
  return `${source.id}  ${source.enabled ? "on " : "off"}  ${source.name}  (${host})`;
}

export async function listSources(home: string): Promise<SourceAddon[]> {
  return (await loadOrCreateConfig(home)).sources;
}

/** Validate the addon by fetching its manifest, then store it. Re-adding a known transport URL updates it. */
export async function addSource(home: string, client: UpstreamClient, manifestUrl: string): Promise<SourceAddon> {
  const url = manifestUrl.trim().replace(/^stremio:\/\//i, "https://");
  if (!/^https?:\/\//i.test(url)) throw new Error("expected an http(s) addon manifest URL");
  const manifest = await client.fetchManifest(url, "new-source");
  const servesStreams = manifest.resources.some((resource) => (typeof resource === "string" ? resource : resource.name) === "stream");
  if (!servesStreams) throw new Error(`"${manifest.name}" does not serve streams`);

  const transportUrl = transportUrlFromManifestUrl(url);
  const current = (await loadOrCreateConfig(home)).sources;
  const existing = current.find((source) => source.transportUrl === transportUrl);
  const source: SourceAddon = existing
    ? { ...existing, name: manifest.name, manifestUrl: url, enabled: true }
    : { id: newSourceId(current), name: manifest.name, manifestUrl: url, transportUrl, enabled: true };
  await updateConfig(home, (config) => {
    const index = config.sources.findIndex((candidate) => candidate.transportUrl === transportUrl);
    if (index >= 0) config.sources[index] = source;
    else config.sources.push(source);
  });
  return source;
}

function newSourceId(taken: SourceAddon[]): string {
  for (;;) {
    const id = randomBytes(3).toString("hex");
    if (!taken.some((source) => source.id === id)) return id;
  }
}

export async function removeSource(home: string, id: string): Promise<boolean> {
  let removed = false;
  await updateConfig(home, (config) => {
    const before = config.sources.length;
    config.sources = config.sources.filter((source) => source.id !== id);
    removed = config.sources.length < before;
  });
  return removed;
}

export async function setSourceEnabled(home: string, id: string, enabled: boolean): Promise<boolean> {
  let found = false;
  await updateConfig(home, (config) => {
    const source = config.sources.find((candidate) => candidate.id === id);
    if (source) {
      source.enabled = enabled;
      found = true;
    }
  });
  return found;
}

/** Store an absolute download folder, creating it so a typo fails here rather than at the first download. */
export async function setStorageDir(home: string, dir: string): Promise<string> {
  const absolute = resolve(dir);
  await mkdir(absolute, { recursive: true });
  await updateConfig(home, (config) => {
    config.storageDir = absolute;
  });
  return absolute;
}
