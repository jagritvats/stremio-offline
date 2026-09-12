import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 34701;

/**
 * Everything the URI dispatcher needs to reach the running runtime. Lives
 * outside the repo, readable by this user only. `secret` is the install secret
 * of DESIGN §21: every /api/* request must carry it, and it never leaves this
 * machine.
 */
export interface RuntimeConfig {
  version: 1;
  port: number;
  secret: string;
}

/** $STREMIO_OFFLINE_HOME, or ~/.stremio-offline. Absolute, so the OS-launched dispatcher finds it from any cwd. */
export function runtimeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["STREMIO_OFFLINE_HOME"] || join(homedir(), ".stremio-offline");
}

export function configPath(home: string): string {
  return join(home, "runtime.json");
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
  const { port, secret } = parsed as Partial<RuntimeConfig>;
  if (typeof secret !== "string" || secret.length < 32 || typeof port !== "number" || !Number.isInteger(port)) {
    throw malformed;
  }
  return { version: 1, port, secret };
}

/** Load the config, minting the install secret on first run. `port` overrides (and replaces) the stored one. */
export async function loadOrCreateConfig(home: string, port?: number): Promise<RuntimeConfig> {
  const existing = await readConfig(home);
  const config: RuntimeConfig = {
    version: 1,
    port: port ?? existing?.port ?? DEFAULT_PORT,
    secret: existing?.secret ?? randomBytes(32).toString("hex"),
  };
  if (!existing || existing.port !== config.port) await writeConfig(home, config);
  return config;
}

export async function writeConfig(home: string, config: RuntimeConfig): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = configPath(home);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // `mode` above only applies when the file is created; keep an existing one private too. No-op on Windows.
  await chmod(path, 0o600);
}
