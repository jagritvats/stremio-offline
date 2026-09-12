# Spikes

Build order from [DESIGN.md §23](DESIGN.md#23-critical-build-order). Each spike must pass before the next is started.

| # | Spike | Windows | Android | Notes |
|---|-------|---------|---------|-------|
| 1 | Action integration (`externalUrl` → custom URI handler) | ☐ | ☐ | make-or-break · runnable: `pnpm spike:1` |
| 2 | Local playback (`url` → localhost file endpoint with Range) | ☐ | ☐ | runnable: `pnpm runtime` with an HTTP source |
| 3 | Upstream proxy (normalise one source addon into `⬇ OFFLINE`) | ☐ | ☐ | runnable: `pnpm runtime` |
| 4 | Torrent (infoHash + fileIdx → file → `✅ OFFLINE`) | ☐ | ☐ | not started: gated on Spike 1 (CLAUDE.md) |
| 5 | Persistence (queue → kill → restart → resume → offline play) | ☐ | ☐ | runnable: `pnpm runtime` with an HTTP source |

Legend: ☐ not run · ✅ pass · ❌ fail (link the finding)

## Plan

What is built, and what is next in the order it gets done.

Built and unit-tested:

- `models`; `addon-core` (manifest, router, presenter, `/media` with Range, offline catalog + meta); `addon-proxy` (upstream client incl. meta, normaliser, dedupe, aggregator); `download-core` (job store, meta store, source registry, download manager, HTTP engine with Range resume).
- `apps/desktop-runtime`: the runtime (`pnpm runtime`). Stream handler over the configured source addons; `enqueue/<token>` plus pause, resume, retry and cancel actions; `/media/<jobId>`; the offline library; jobs and metadata snapshots persisted under `~/.stremio-offline`; partial downloads resumed on restart. Plus the Spike 1 addon, the `stremio-offline://` dispatcher and OS registration.
- `apps/addon-server`: the hosted install-by-URL half; empty stream list on purpose.

Not built:

- The torrent engine (Spike 4). CLAUDE.md gates it on Spike 1. Until it exists the runtime lists only sources an engine can transfer, so torrent streams from upstream addons are not offered as `⬇ OFFLINE` yet (the log says how many were hidden).
- `apps/android-runtime` (README only).

Next, in order:

1. **Spike 1 on Windows** (below). Everything hinges on it.
2. **Spikes 2, 3 and 5 against real Stremio** with an HTTP source (below): seeking, subtitles and resume in Stremio's player; kill and restart mid-download; play with the network off.
3. **Torrent engine** (Spike 4), behind the same `DownloadEngine` interface, picked by `source.type`.
4. **Android**: a deep-link activity that does what `dispatch` does (POST the URI to `/api/action` with the install secret), then the runtime pieces in Kotlin.

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

## Running the runtime (Spikes 2, 3 and 5, with an HTTP source)

Same install secret, port and handler as Spike 1. Stop `pnpm spike:1` first: they share the port, and the two addons share an id, so installing one replaces the other in Stremio.

```sh
pnpm register                                       # once
pnpm runtime sources add <manifest URL of a stream addon>   # validated by fetching its manifest
pnpm runtime storage "D:\Movies"                    # optional; default is ~/Downloads/Stremio Offline
pnpm runtime                                        # leave it running
```

`sources list`, `sources remove <id>`, `sources enable|disable <id>` manage the addons; the running runtime picks up source changes on the next stream request, a storage change needs a restart. Install `http://127.0.0.1:34701/manifest.json` into Stremio.

- **Spike 3.** Open a title. Every downloadable upstream stream is listed once as `⬇ OFFLINE • <quality>` with its size and the providers offering it; the same source from two addons is one entry. Only `http(s)` sources are offered today; torrent streams wait for Spike 4.
- **Spike 2.** Tap an HTTP entry. The terminal logs `queued`, `downloading` and `complete`; in Stremio the entry reads `⏳ N% DOWNLOADED` while it runs and `✅ OFFLINE` when done. Tap that: Stremio's own player plays `http://127.0.0.1:34701/media/<jobId>`. Check seeking, resume-from-position and subtitles.
- **Spike 5.** Tap an entry, stop the runtime mid-download (Ctrl-C), start it again: the log shows `downloading` again and the `.part` file grows from where it stopped. Once complete, disconnect from the network and restart Stremio: Discover → Offline Movies / Offline Series lists the title, and its `✅ OFFLINE` entry plays.

State lives in `~/.stremio-offline`: `runtime.json` (port, install secret, source addons, storage folder), `jobs.json`, and `meta/` (metadata snapshots taken when a download is queued). Finished files go to `<storage>/Movies/<Title>/` and `<storage>/Series/<Title>/`; a download in progress is `<file>.part`. `apps/desktop-runtime/src/runtime.test.ts` shows the smallest source addon this can be tested against.
