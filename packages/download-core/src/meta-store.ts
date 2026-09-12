import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaType, OfflineMeta } from "@stremio-offline/models";

/** Metadata snapshots taken at enqueue time, so the library stays browsable offline (DESIGN §11). */
export interface MetaStore {
  get(type: MediaType, imdbId: string): Promise<OfflineMeta | undefined>;
  put(meta: OfflineMeta): Promise<void>;
}

export class MemoryMetaStore implements MetaStore {
  readonly #metas = new Map<string, OfflineMeta>();

  async get(type: MediaType, imdbId: string): Promise<OfflineMeta | undefined> {
    const meta = this.#metas.get(`${type}:${imdbId}`);
    return meta ? structuredClone(meta) : undefined;
  }

  async put(meta: OfflineMeta): Promise<void> {
    this.#metas.set(`${meta.type}:${meta.imdbId}`, structuredClone(meta));
  }
}

/** One JSON file per title under `dir`. The id is percent-encoded into the filename, so it can never name a path. */
export class JsonDirMetaStore implements MetaStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async get(type: MediaType, imdbId: string): Promise<OfflineMeta | undefined> {
    try {
      return JSON.parse(await readFile(this.#path(type, imdbId), "utf8")) as OfflineMeta;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async put(meta: OfflineMeta): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const path = this.#path(meta.type, meta.imdbId);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(meta), "utf8");
    await rename(tmp, path);
  }

  #path(type: MediaType, imdbId: string): string {
    if (!imdbId || imdbId.length > 200) throw new Error("invalid meta id");
    return join(this.#dir, `${type}-${encodeURIComponent(imdbId)}.json`);
  }
}
