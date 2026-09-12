export const ACTION_SCHEME = "stremio-offline";

/** A parsed action URI: "stremio-offline://enqueue/<token>", "stremio-offline://test?id=123". */
export interface ActionRequest {
  action: string;
  /** Path segments after the action, decoded. */
  args: string[];
  /** Query parameters. */
  params: Record<string, string>;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** null for anything that is not a well-formed stremio-offline:// URI. */
export function parseActionUri(uri: string): ActionRequest | null {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    return null;
  }
  if (url.protocol !== `${ACTION_SCHEME}:`) return null;
  const action = url.hostname.toLowerCase();
  if (!action) return null;
  const args = url.pathname.split("/").filter((segment) => segment.length > 0).map(decode);
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) params[key] = value;
  return { action, args, params };
}
