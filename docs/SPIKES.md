# Spikes

Build order from [DESIGN.md §23](DESIGN.md#23-critical-build-order). Each spike must pass before the next is started.

| # | Spike | Windows | Android | Notes |
|---|-------|---------|---------|-------|
| 1 | Action integration (`externalUrl` → custom URI handler) | ☐ | ☐ | make-or-break |
| 2 | Local playback (`url` → localhost file endpoint with Range) | ☐ | ☐ | |
| 3 | Upstream proxy (normalise one source addon into `⬇ OFFLINE`) | ☐ | ☐ | |
| 4 | Torrent (infoHash + fileIdx → file → `✅ OFFLINE`) | ☐ | ☐ | |
| 5 | Persistence (queue → kill → restart → resume → offline play) | ☐ | ☐ | |

Legend: ☐ not run · ✅ pass · ❌ fail (link the finding)
