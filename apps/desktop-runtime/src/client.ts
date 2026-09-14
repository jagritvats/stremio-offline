// Talks to a running runtime over the loopback interface, as the CLI.
//
// The install secret comes from runtime.json, which only this user can read, and
// it never appears in output: privileged calls are made here and the results are
// printed, so nothing has to hand the secret around.

import type { DownloadJob } from "@stremio-offline/models";
import { readConfig } from "./config.ts";

export interface RuntimeClient {
  port: number;
  /** Send an action URI to the runtime. Returns what it reported. */
  action(uri: string): Promise<string>;
  jobs(): Promise<DownloadJob[]>;
  /** The raw response body, for callers that want to echo the runtime verbatim. */
  raw(uri: string): Promise<string>;
}

function unavailable(port: number): Error {
  return new Error(`the runtime is not running on 127.0.0.1:${port}`);
}

/** Connect to the runtime described by runtime.json. Throws a message worth printing. */
export async function connect(home: string): Promise<RuntimeClient> {
  const config = await readConfig(home);
  if (!config) throw new Error(`no runtime state in ${home}; start the runtime first (pnpm runtime)`);
  const { port, secret } = config;
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${secret}` };

  const raw = async (uri: string): Promise<string> => {
    const response = await fetch(`${base}/api/action`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ uri }),
    }).catch(() => {
      throw unavailable(port);
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`the runtime rejected the action (${response.status}): ${body}`);
    return body;
  };

  return {
    port,
    raw,
    action: async (uri) => {
      const parsed: unknown = JSON.parse(await raw(uri));
      const result = (parsed as { result?: unknown }).result;
      return typeof result === "string" ? result : JSON.stringify(parsed);
    },
    jobs: async () => {
      const response = await fetch(`${base}/api/jobs`, { headers: auth }).catch(() => {
        throw unavailable(port);
      });
      if (!response.ok) throw new Error(`the runtime answered ${response.status} for the job list`);
      return ((await response.json()) as { jobs: DownloadJob[] }).jobs;
    },
  };
}
