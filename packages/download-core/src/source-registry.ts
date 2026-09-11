import { randomBytes } from "node:crypto";
import { mediaScopeKey, type JobMedia, type NormalizedSource } from "@stremio-offline/models";

export interface RegisteredSource {
  token: string;
  source: NormalizedSource;
  media: JobMedia;
  createdAt: number;
}

export interface SourceRegistryOptions {
  /** How long a token stays valid after it was last shown to Stremio. Default 24h. */
  ttlMs?: number;
  now?: () => number;
  newToken?: () => string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Maps short-lived opaque tokens to source descriptors, so action URIs never
 * carry magnets, upstream URLs or credentials (DESIGN §6, §21).
 */
export class SourceRegistry {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #newToken: () => string;
  readonly #byToken = new Map<string, RegisteredSource>();
  readonly #byIdentity = new Map<string, string>();

  constructor(options: SourceRegistryOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#newToken = options.newToken ?? (() => randomBytes(16).toString("hex"));
  }

  /** Register (or refresh) a source for a media item and return its token. */
  register(source: NormalizedSource, media: JobMedia): string {
    this.prune();
    const identity = SourceRegistry.#identity(media, source.key);
    const existingToken = this.#byIdentity.get(identity);
    const existing = existingToken ? this.#byToken.get(existingToken) : undefined;
    if (existingToken && existing) {
      existing.source = source;
      existing.media = media;
      existing.createdAt = this.#now();
      return existingToken;
    }
    const token = this.#newToken();
    this.#byToken.set(token, { token, source, media, createdAt: this.#now() });
    this.#byIdentity.set(identity, token);
    return token;
  }

  resolve(token: string): RegisteredSource | undefined {
    this.prune();
    return this.#byToken.get(token);
  }

  prune(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [token, entry] of this.#byToken) {
      if (entry.createdAt < cutoff) {
        this.#byToken.delete(token);
        this.#byIdentity.delete(SourceRegistry.#identity(entry.media, entry.source.key));
      }
    }
  }

  get size(): number {
    return this.#byToken.size;
  }

  static #identity(media: JobMedia, sourceKey: string): string {
    return `${mediaScopeKey(media)}|${sourceKey}`;
  }
}
