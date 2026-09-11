import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddonRouter } from "./router.ts";

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
}

/** Return true once the request has been fully answered; false to let the next route try. */
export type RouteHandler = (ctx: RouteContext) => Promise<boolean> | boolean;

export interface LocalServerOptions {
  onError?: (error: unknown) => void;
}

/** Minimal sequential router over node:http. The caller decides the bind address (127.0.0.1!). */
export function createLocalServer(routes: RouteHandler[], options: LocalServerOptions = {}): Server {
  return createServer(async (req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      for (const route of routes) {
        if (await route({ req, res, url, method })) return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      options.onError?.(error);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    }
  });
}

export function listen(server: Server, port: number, host = "127.0.0.1"): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (address && typeof address === "object") resolve({ host: address.address, port: address.port });
      else resolve({ host, port });
    });
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

export function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** Adapt an addon router to a RouteHandler. */
export function addonRoute(router: AddonRouter): RouteHandler {
  return async ({ res, url, method }) => {
    const result = await router({ method, path: url.pathname });
    if (!result) return false;
    res.writeHead(result.status, {
      ...result.headers,
      ...(result.body ? { "Content-Length": Buffer.byteLength(result.body) } : {}),
    });
    res.end(method === "HEAD" ? undefined : result.body);
    return true;
  };
}
