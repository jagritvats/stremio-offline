import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SourceAddon } from "@stremio-offline/models";

export const DEFAULT_PORT = 34701;

/**
 * The runtime's own state. Lives outside the repo, readable by this user only.
 * `secret` is the install secret of DESIGN §21: every /api/* request must carry
 * it. `sources` hold upstream addon URLs, which can carry credentials, which is
 * why the file is 0600 and nothing in it is ever logged.
 */
export interface RuntimeConfig {
  version: 1;
  port: number;
  secret: string;
  /** Finished downloads go under here, in Movies/ and Series/. */
  storageDir: string;
  sources: SourceAddon[];
}

/** $STREMIO_OFFLINE_HOME, or ~/.stremio-offline. Absolute, so the OS-launched dispatcher finds it from any cwd. */
export function runtimeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["STREMIO_OFFLINE_HOME"] || join(homedir(), ".stremio-offline");
}

export function configPath(home: string): string {
  return join(home, "runtime.json");
}

export function defaultStorageDir(): string {
  return join(homedir(), "Downloads", "Stremio Offline");
}

function isSourceAddon(value: unknown): value is SourceAddon {
  if (typeof value !== "object" || value === null) return false;
  const source = value as Record<string, unknown>;
  const text = (key: string): boolean => typeof source[key] === "string" && (source[key] as string).length > 0;
  return text("id") && text("name") && text("manifestUrl") && text("transportUrl") && typeof source["enabled"] === "boolean";
}

export async function readConfig(home: string): Promise<RuntimeConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(configPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const malformed = new Error(`${configPath(home)} is malformed; delete it to start over`);
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw malformed;
  const { port, secret, storageDir, sources } = parsed as Record<string, unknown>;
  if (typeof secret !== "string" || secret.length < 32 || typeof port !== "number" || !Number.isInteger(port)) {
    throw malformed;
  }
  return {
    version: 1,
    port,
    secret,
    storageDir: typeof storageDir === "string" && storageDir.length > 0 ? storageDir : defaultStorageDir(),
    sources: Array.isArray(sources) ? sources.filter(isSourceAddon) : [],
  };
}

/** Load the config, minting the install secret on first run. `port` overrides (and replaces) the stored one. */
export async function loadOrCreateConfig(home: string, port?: number): Promise<RuntimeConfig> {
  const existing = await readConfig(home);
  const config: RuntimeConfig = {
    version: 1,
    port: port ?? existing?.port ?? DEFAULT_PORT,
    secret: existing?.secret ?? randomBytes(32).toString("hex"),
    storageDir: existing?.storageDir ?? defaultStorageDir(),
    sources: existing?.sources ?? [],
  };
  if (!existing || existing.port !== config.port) await writeConfig(home, config);
  return config;
}

/** Read-modify-write runtime.json, creating it (and the install secret) on a first run. */
export async function updateConfig(home: string, mutate: (config: RuntimeConfig) => void): Promise<RuntimeConfig> {
  const config = await loadOrCreateConfig(home);
  mutate(config);
  await writeConfig(home, config);
  return config;
}

/** Atomic replace: the running runtime re-reads this file while the CLI edits it. */
export async function writeConfig(home: string, config: RuntimeConfig): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = configPath(home);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
