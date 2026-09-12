import type { Server } from "node:http";
import { addonRoute, createAddonRouter, createLocalServer, type AddonHandlers } from "@stremio-offline/addon-core";
import { apiRoute, type ApiOptions } from "./api.ts";

export interface RuntimeServerOptions extends ApiOptions {
  handlers: AddonHandlers;
  log?: (message: string) => void;
}

/**
 * The local runtime's HTTP surface: public addon routes (manifest, stream, …)
 * and the secret-guarded /api/* routes. The caller binds it, and binds it to
 * 127.0.0.1 only.
 */
export function createRuntimeServer(options: RuntimeServerOptions): Server {
  const log = options.log ?? (() => {});
  const router = createAddonRouter(options.handlers, {
    onError: (path, error) => log(`addon request ${path} failed: ${String(error)}`),
  });
  return createLocalServer([addonRoute(router), apiRoute(options)], {
    onError: (error) => log(`request failed: ${String(error)}`),
  });
}
