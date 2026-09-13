# Stremio Offline — agent notes

- Spec: `docs/DESIGN.md`. Build order and spike status: `docs/SPIKES.md`. Do not build the torrent engine before Spike 1 passes.
- TypeScript monorepo (pnpm workspaces). Packages export `./src/index.ts` directly; there is no build step. `tsx` runs TS, `node --test` runs `*.test.ts`. Keep syntax erasable (no `enum`, no parameter properties) — `erasableSyntaxOnly` is on.
- Relative imports use explicit `.ts` extensions.
- Runtime binds `127.0.0.1` only. Privileged endpoints (`/api/*`) require the install secret; addon endpoints (`/manifest.json`, `/stream`, `/catalog`, `/meta`, `/media`) are public with permissive CORS.
- Never log or persist upstream addon URLs into anything that could leave the machine; they can contain credentials.
- Android app lives in `apps/android-runtime` (Gradle, not part of the pnpm workspace).
- `apps/desktop-runtime` keeps its state under `~/.stremio-offline` (or `$STREMIO_OFFLINE_HOME`): `runtime.json` (port, install secret, source addons, storage dir), `jobs.json`, `meta/`. `pnpm runtime` starts it; `pnpm runtime sources add <url>` adds a source addon; `pnpm spike:1` runs the Spike 1 addon; `pnpm register` registers the `stremio-offline://` handler; `main.ts dispatch <uri>` is what the OS runs.
- Only the HTTP download engine exists. The torrent engine (Spike 4) is not built; do not add it before Spike 1 passes.
