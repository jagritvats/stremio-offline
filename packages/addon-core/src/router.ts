import {
  isMediaType,
  type CatalogResponse,
  type MediaType,
  type MetaResponse,
  type StremioManifest,
  type StreamsResponse,
} from "@stremio-offline/models";

export interface AddonRequest {
  method: string;
  /** URL path without query string, e.g. "/stream/movie/tt0816692.json". */
  path: string;
}

export interface AddonResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface AddonHandlers {
  manifest(): StremioManifest;
  stream(type: MediaType, id: string): Promise<StreamsResponse>;
  catalog?(type: MediaType, id: string, extra: Record<string, string>): Promise<CatalogResponse>;
  /** Return null when this addon has no meta for the id, so Stremio falls back to other addons. */
  meta?(type: MediaType, id: string): Promise<MetaResponse | null>;
}

export interface RouterOptions {
  onError?: (path: string, error: unknown) => void;
}

export type AddonRouter = (req: AddonRequest) => Promise<AddonResponse | null>;

/** Addon endpoints are fetched cross-origin by Stremio's web UI, so they must be permissive. */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const ADDON_RESOURCES = new Set(["stream", "catalog", "meta"]);

function json(status: number, payload: unknown): AddonResponse {
  return {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(payload),
  };
}

const notFound = (): AddonResponse => json(404, { error: "not found" });

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Catalog extra is one URL-encoded segment: "search=dune&skip=20". */
function parseExtra(raw: string | undefined): Record<string, string> {
  const extra: Record<string, string> = {};
  if (!raw) return extra;
  for (const [key, value] of new URLSearchParams(raw)) extra[key] = value;
  return extra;
}

/**
 * Routes Stremio addon protocol requests. Returns null for paths that are not
 * addon routes so the caller can serve its other endpoints (media, api, ...).
 */
export function createAddonRouter(handlers: AddonHandlers, options: RouterOptions = {}): AddonRouter {
  return async (req) => {
    const segments = req.path.replace(/^\/+/, "").split("/");
    const last = segments[segments.length - 1];
    if (last === undefined || !last.endsWith(".json")) return null;
    segments[segments.length - 1] = last.slice(0, -".json".length);

    const resource = segments[0] ?? "";
    const isManifest = resource === "manifest" && segments.length === 1;
    if (!isManifest && !ADDON_RESOURCES.has(resource)) return null;

    const method = req.method.toUpperCase();
    if (method === "OPTIONS") return { status: 204, headers: { ...CORS_HEADERS }, body: "" };
    if (method !== "GET" && method !== "HEAD") return json(405, { error: "method not allowed" });

    try {
      if (isManifest) return json(200, handlers.manifest());

      const type = decode(segments[1] ?? "");
      const id = decode(segments[2] ?? "");
      if (!type || !id || !isMediaType(type)) return notFound();

      if (resource === "stream" && segments.length === 3) {
        return json(200, await handlers.stream(type, id));
      }
      if (resource === "catalog" && handlers.catalog && segments.length <= 4) {
        return json(200, await handlers.catalog(type, id, parseExtra(segments[3])));
      }
      if (resource === "meta" && handlers.meta && segments.length === 3) {
        const meta = await handlers.meta(type, id);
        return meta ? json(200, meta) : notFound();
      }
      return notFound();
    } catch (error) {
      options.onError?.(req.path, error);
      return json(500, { error: "internal error" });
    }
  };
}
