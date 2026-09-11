# Stremio Offline

Persistent offline downloads for **stock Stremio**. A local runtime on `127.0.0.1` acts as a normal Stremio addon: it mirrors the streams of your existing source addons as `⬇ OFFLINE` entries, downloads them in the background when tapped, and serves them back to Stremio's own player as `✅ OFFLINE` once complete.

Full product and architecture spec: [docs/DESIGN.md](docs/DESIGN.md).
Spike status and build order: [docs/SPIKES.md](docs/SPIKES.md).

## Layout

```text
packages/
  models/          shared types (Stremio protocol, OfflineSource, DownloadJob, ...)
  addon-core/      manifest + stream/catalog/meta handlers + HTTP adapter
  addon-proxy/     upstream addon client, source normaliser, deduplicator
  download-core/   jobs, persistence, source registry (action tokens), engine interface
apps/
  desktop-runtime/ Node runtime: addon server, action endpoint, URI protocol handler, media serving
  android-runtime/ Kotlin: deep-link activity, foreground service (scaffold)
docs/
```

## Dev

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm spike:1      # start the hello-offline addon for Spike 1
```

Requires Node 22+ and pnpm 9.
