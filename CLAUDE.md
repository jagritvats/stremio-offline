# Stremio Offline — agent notes

- Spec: `docs/DESIGN.md`. Build order and spike status: `docs/SPIKES.md`. Do not build the torrent engine before Spike 1 passes.
- TypeScript monorepo (pnpm workspaces). Packages export `./src/index.ts` directly; there is no build step. `tsx` runs TS, `node --test` runs `*.test.ts`. Keep syntax erasable (no `enum`, no parameter properties) — `erasableSyntaxOnly` is on.
- Relative imports use explicit `.ts` extensions.
- Runtime binds `127.0.0.1` only. Privileged endpoints (`/api/*`) require the install secret; addon endpoints (`/manifest.json`, `/stream`, `/catalog`, `/meta`, `/media`) are public with permissive CORS.
- Never log or persist upstream addon URLs into anything that could leave the machine; they can contain credentials.
- Android app lives in `apps/android-runtime` (Gradle, not part of the pnpm workspace).
