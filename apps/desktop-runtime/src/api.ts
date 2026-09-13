import { createHash, timingSafeEqual } from "node:crypto";
import { readJsonBody, sendJson, type RouteHandler } from "@stremio-offline/addon-core";
import { parseActionUri, type ActionRequest } from "./action.ts";

export interface ApiOptions {
  /** The install secret from runtime.json. */
  secret: string;
  version: string;
  /** Handles a parsed action URI; whatever it returns is echoed to the dispatcher. A throw becomes a 400. */
  onAction: (action: ActionRequest) => Promise<unknown> | unknown;
  /** Backs GET /api/jobs when present. */
  listJobs?: () => Promise<unknown>;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function bearerMatches(header: string | undefined, secret: string): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!match) return false;
  return timingSafeEqual(digest(match[1] ?? ""), digest(secret));
}

/**
 * /api/*: the privileged surface. Every request needs the install secret, and
 * no CORS headers are ever sent, so a webpage open on this machine can neither
 * read from it nor get a preflight past the browser (DESIGN §21).
 */
export function apiRoute(options: ApiOptions): RouteHandler {
  return async ({ req, res, url, method }) => {
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return false;

    if (!bearerMatches(req.headers.authorization, options.secret)) {
      sendJson(res, 401, { error: "install secret required" });
      return true;
    }

    if (url.pathname === "/api/health" && method === "GET") {
      sendJson(res, 200, { ok: true, version: options.version });
      return true;
    }

    if (url.pathname === "/api/jobs" && method === "GET" && options.listJobs) {
      sendJson(res, 200, { jobs: await options.listJobs() });
      return true;
    }

    if (url.pathname === "/api/action" && method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return true;
      }
      const uri = typeof body === "object" && body !== null ? (body as { uri?: unknown }).uri : undefined;
      const action = typeof uri === "string" ? parseActionUri(uri) : null;
      if (!action) {
        sendJson(res, 400, { error: 'body must be { "uri": "stremio-offline://..." }' });
        return true;
      }
      try {
        const result = await options.onAction(action);
        sendJson(res, 200, { ok: true, action: action.action, result: result ?? null });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  };
}
