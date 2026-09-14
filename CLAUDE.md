# Stremio Offline — agent notes

- Spec: `docs/DESIGN.md`. Build order and spike status: `docs/SPIKES.md`. Do not build the torrent engine before Spike 1 passes.
- TypeScript monorepo (pnpm workspaces). Packages export `./src/index.ts` directly; there is no build step. `tsx` runs TS, `node --test` runs `*.test.ts`. Keep syntax erasable (no `enum`, no parameter properties) — `erasableSyntaxOnly` is on.
- Relative imports use explicit `.ts` extensions.
- Runtime binds `127.0.0.1` only. Privileged endpoints (`/api/*`) require the install secret; addon endpoints (`/manifest.json`, `/stream`, `/catalog`, `/meta`, `/media`) are public with permissive CORS.
- Never log or persist upstream addon URLs into anything that could leave the machine; they can contain credentials.
- Android app lives in `apps/android-runtime` (Gradle, not part of the pnpm workspace). It holds Spike 1 only — loopback addon server, `stremio-offline://` activity, foreground service, no dependencies — and has never been compiled; say so rather than implying it works.
- `apps/desktop-runtime` keeps its state under `~/.stremio-offline` (or `$STREMIO_OFFLINE_HOME`): `runtime.json` (port, install secret, source addons, storage dir), `jobs.json`, `meta/`. `pnpm runtime` starts it; `pnpm runtime sources add <url>` adds a source addon; `pnpm spike:1` runs the Spike 1 addon; `pnpm register` registers the `stremio-offline://` handler; `main.ts dispatch <uri>` is what the OS runs.
- Only the HTTP download engine exists. The torrent engine (Spike 4) is not built; do not add it before Spike 1 passes. `DownloadManager` runs two transfers at once by default and queues the rest; `HttpEngine` retries transient failures with a doubling backoff and resumes from `<file>.part`.
- `pnpm runtime jobs [pause|resume|cancel <id>]` drives downloads from the terminal through `/api`. CLI output must never contain an upstream URL.
- The offline catalog and meta list only titles with a job that is not `error` (`isLibraryJob`): Discover must never promise a title that cannot be played.
