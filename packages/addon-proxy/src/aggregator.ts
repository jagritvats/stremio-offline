import type { MediaType, NormalizedSource, SourceAddon } from "@stremio-offline/models";
import { dedupeSources, sortSources } from "./deduplicator.ts";
import { normalizeStreams } from "./source-normalizer.ts";
import type { UpstreamClient } from "./upstream-client.ts";

export interface AggregateError {
  addonId: string;
  message: string;
}

export interface AggregateResult {
  sources: NormalizedSource[];
  errors: AggregateError[];
}

/**
 * Ask every enabled source addon for its streams, normalise, dedupe and sort.
 * One failing addon never hides the others' results.
 */
export async function collectOfflineSources(
  client: UpstreamClient,
  addons: SourceAddon[],
  type: MediaType,
  id: string,
): Promise<AggregateResult> {
  const enabled = addons.filter((addon) => addon.enabled);
  const settled = await Promise.allSettled(enabled.map((addon) => client.fetchStreams(addon, type, id)));

  const sources: NormalizedSource[] = [];
  const errors: AggregateError[] = [];
  for (const [index, result] of settled.entries()) {
    const addon = enabled[index];
    if (!addon) continue;
    if (result.status === "fulfilled") {
      sources.push(...normalizeStreams(result.value, addon.name));
    } else {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({ addonId: addon.id, message });
    }
  }

  return { sources: sortSources(dedupeSources(sources)), errors };
}
