import type { MediaType, SourceAddon, StremioManifest, StremioMeta, StremioStream } from "@stremio-offline/models";

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<FetchResponseLike>;

export interface UpstreamClientOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  userAgent?: string;
}

/** Deliberately never carries the request URL: transport URLs can embed credentials (DESIGN §16). */
export class UpstreamError extends Error {
  readonly addonId: string;
  readonly status: number | undefined;

  constructor(message: string, addonId: string, status?: number) {
    super(message);
    this.name = "UpstreamError";
    this.addonId = addonId;
    this.status = status;
  }
}

export function streamsUrl(transportUrl: string, type: MediaType, id: string): string {
  return `${transportUrl.replace(/\/+$/, "")}/stream/${type}/${encodeURIComponent(id)}.json`;
}

export function metaUrl(transportUrl: string, type: MediaType, id: string): string {
  return `${transportUrl.replace(/\/+$/, "")}/meta/${type}/${encodeURIComponent(id)}.json`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Fetches resources from configured upstream Stremio addons (DESIGN §4). */
export class UpstreamClient {
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #headers: Record<string, string>;

  constructor(options: UpstreamClientOptions = {}) {
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#headers = {
      Accept: "application/json",
      "User-Agent": options.userAgent ?? "stremio-offline/0.0.1",
    };
  }

  async fetchManifest(manifestUrl: string, addonId = "manifest"): Promise<StremioManifest> {
    const data = await this.#getJson(manifestUrl, addonId);
    if (!isObject(data) || typeof data["id"] !== "string" || !Array.isArray(data["resources"])) {
      throw new UpstreamError("invalid manifest", addonId);
    }
    return data as unknown as StremioManifest;
  }

  async fetchStreams(addon: SourceAddon, type: MediaType, id: string): Promise<StremioStream[]> {
    const data = await this.#getJson(streamsUrl(addon.transportUrl, type, id), addon.id);
    const streams = isObject(data) ? data["streams"] : undefined;
    if (!Array.isArray(streams)) throw new UpstreamError("invalid streams response", addon.id);
    return streams.filter(isObject) as StremioStream[];
  }

  /** Meta for one title; null when the addon has none (404, or an empty meta). */
  async fetchMeta(addon: Pick<SourceAddon, "id" | "transportUrl">, type: MediaType, id: string): Promise<StremioMeta | null> {
    let data: unknown;
    try {
      data = await this.#getJson(metaUrl(addon.transportUrl, type, id), addon.id);
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 404) return null;
      throw error;
    }
    const meta = isObject(data) ? data["meta"] : undefined;
    if (!isObject(meta) || typeof meta["id"] !== "string" || typeof meta["name"] !== "string") return null;
    return meta as unknown as StremioMeta;
  }

  async #getJson(url: string, addonId: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, { signal: controller.signal, headers: this.#headers });
      if (!response.ok) throw new UpstreamError(`upstream responded ${response.status}`, addonId, response.status);
      return await response.json();
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new UpstreamError(timedOut ? "upstream timed out" : "upstream request failed", addonId);
    } finally {
      clearTimeout(timer);
    }
  }
}
