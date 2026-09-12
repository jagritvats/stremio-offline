# Spikes

Build order from [DESIGN.md §23](DESIGN.md#23-critical-build-order). Each spike must pass before the next is started.

| # | Spike | Windows | Android | Notes |
|---|-------|---------|---------|-------|
| 1 | Action integration (`externalUrl` → custom URI handler) | ☐ | ☐ | make-or-break · runnable, see below |
| 2 | Local playback (`url` → localhost file endpoint with Range) | ☐ | ☐ | |
| 3 | Upstream proxy (normalise one source addon into `⬇ OFFLINE`) | ☐ | ☐ | |
| 4 | Torrent (infoHash + fileIdx → file → `✅ OFFLINE`) | ☐ | ☐ | |
| 5 | Persistence (queue → kill → restart → resume → offline play) | ☐ | ☐ | |

Legend: ☐ not run · ✅ pass · ❌ fail (link the finding)

## Plan

The libraries are ahead of the spikes. `models`, `addon-core`, `addon-proxy` and `download-core` are built and unit-tested, with `NoopEngine` standing in for a transfer engine. `apps/addon-server`, the hosted install-by-URL half, serves a real manifest and an empty stream list on purpose. `apps/desktop-runtime` is the bare minimum that makes Spike 1 runnable and nothing more. `apps/android-runtime` is a README.

Each step unblocks the next. Nothing past step 1 starts until Spike 1 is recorded as ✅ on Windows.

1. **Spike 1** — run it (below) on Windows. Android needs the Kotlin deep-link activity that does what `dispatch` does: POST the URI to the runtime's `/api/action` with the install secret, then `finish()`.
2. **Spike 2** — `/media/:jobId` in the runtime: `HEAD`/`GET` with `Range` over a file on disk. `completedStream()` in addon-core already builds the `✅ OFFLINE` entry for it.
3. **Spike 3** — the real `stream` handler: `collectOfflineSources` → `SourceRegistry.register` → `presentSource`, and `enqueue/<token>` on `/api/action` → `DownloadManager.enqueue`, still on `NoopEngine`. Source addon URLs join `runtime.json` and go nowhere else.
4. **Spike 4** — the first `DownloadEngine`: HTTP with Range and resume, then torrent (`infoHash` + `fileIdx`), replacing `NoopEngine`.
5. **Spike 5** — `JsonFileJobStore` wired into the runtime, start with the OS, the kill/restart/resume acceptance test, `OfflineMeta` snapshots for the offline catalogs.

## Running Spike 1

The runtime binds `127.0.0.1:34701` and keeps its state in `~/.stremio-offline/runtime.json` (`STREMIO_OFFLINE_HOME` moves it, `STREMIO_OFFLINE_PORT` changes the port). That file holds the install secret every `/api/*` request must carry; the OS-launched dispatcher reads it from there.

```sh
pnpm install
pnpm register     # once: register stremio-offline:// with the OS, for the current user
pnpm spike:1      # leave it running
```

`pnpm register` writes `HKCU\Software\Classes\stremio-offline` on Windows, or `~/.local/share/applications/stremio-offline.desktop` plus the `x-scheme-handler` default on Linux (needs `xdg-utils`). macOS is not supported: owning a URL scheme there needs an app bundle. The registered handler is `node` running `apps/desktop-runtime/src/main.ts dispatch <uri>` through tsx, by absolute path, so it works from any cwd but breaks if the checkout moves. Re-run `pnpm register` after moving it.

Then, in Stremio:

1. Addons → search box → paste `http://127.0.0.1:34701/manifest.json` → Install.
2. Open any movie or episode. The stream list shows **⬇ TEST DOWNLOAD** from *Stremio Offline (Spike 1)*.
3. Tap it.

**Pass:** the terminal prints `[spike1] received test action for <id>`, and re-opening the title shows **✅ HANDLER OK** instead. Stremio stays in front. On Windows a console window may flash: that is the dispatcher process exiting, to be hidden once the spike passes.

**Fail:** nothing arrives, or Stremio (or a browser it hands off to) shows a prompt that goes nowhere. Record ❌ in the table with exactly what happened, per client: app version, and whether it was the Qt shell or the web UI.

Without Stremio, everything but the tap can be exercised by opening the URI the way the OS would (`start "" "stremio-offline://test?id=tt1"` on Windows, `xdg-open` on Linux), or by calling the dispatcher directly:

```sh
pnpm runtime dispatch "stremio-offline://test?id=tt0816692"
```
