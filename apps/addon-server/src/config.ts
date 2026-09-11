// Per-install configuration, carried in the install URL itself.
//
//   https://soffline.synpse.app/<base64url-json>/manifest.json
//
// This is how Torrentio carries a debrid key, and it is the only shape that lets
// a hosted addon be per-user while the server stores nothing. There is no
// database here and no account: the user's install URL IS their configuration,
// so a redeploy, a rollback or a wiped container loses nothing.
//
// READ THIS BEFORE ADDING LOGGING
// ------------------------------------------------------------------------
// DESIGN.md section 16 requires that configured upstream addon URLs never reach
// our servers. Hosting the addon breaks that guarantee on its own: the config
// rides in the path, so it reaches this process on every single request. That is
// an accepted consequence of installing by URL rather than running the addon on
// localhost, and it is the reason this module exists rather than a `config`
// table.
//
// What is still in our control is that the URL must never come to REST anywhere:
// not in an access log, not in an error message, not in an exception that gets
// reported. `redact()` below is the only sanctioned way to put an upstream URL
// anywhere near a log line, and nginx-style path logging must stay off at the
// edge. A transport URL can carry a user's debrid credentials.

export type SourceAddon = {
  // The upstream addon's transport URL, e.g. a configured Torrentio manifest.
  transportUrl: string;
  enabled: boolean;
};

export type IncomingConfig = {
  sources: SourceAddon[];
  // Quality filters from DESIGN.md section 15. Empty means "no filtering".
  qualities: string[];
};

export const EMPTY_CONFIG: IncomingConfig = { sources: [], qualities: [] };

// Reduces a URL to origin + path shape, dropping every query parameter and every
// path segment that could be a credential. Use this and nothing else when an
// upstream URL has to appear in output.
export function redact(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host}/<redacted>`;
  } catch {
    return "<unparseable-url>";
  }
}

// Decodes the config segment. Returns EMPTY_CONFIG for anything malformed rather
// than throwing: a bad segment should land the user on /configure, not on a 500
// that quotes their own credentials back at them in a stack trace.
export function parseConfig(segment: string | undefined): IncomingConfig {
  if (!segment) return EMPTY_CONFIG;

  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_CONFIG;

    const raw = parsed as Record<string, unknown>;
    const sources = Array.isArray(raw["sources"]) ? raw["sources"] : [];
    const qualities = Array.isArray(raw["qualities"]) ? raw["qualities"] : [];

    return {
      sources: sources
        .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
        .map((s) => ({
          transportUrl: String(s["transportUrl"] ?? ""),
          enabled: s["enabled"] !== false,
        }))
        // Only http(s). A `file:` or `data:` transport URL would turn the
        // upstream fetch into a way to read this container's own filesystem.
        .filter((s) => /^https?:\/\//i.test(s.transportUrl)),
      qualities: qualities.map((q) => String(q)),
    };
  } catch {
    return EMPTY_CONFIG;
  }
}

export function encodeConfig(config: IncomingConfig): string {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}
