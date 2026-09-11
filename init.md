# Stremio Offline

## Goal

Add genuine persistent offline downloading to stock Stremio while keeping the entire normal user workflow inside Stremio.

The experience should be:

```text
Stremio
  ↓
open movie / episode
  ↓
normal stream list

Torrentio
4K REMUX ...

Torrentio
1080p WEB-DL ...

Stremio Offline
⬇ 4K REMUX • 61 GB

Stremio Offline
⬇ 1080p WEB-DL • 9.4 GB
```

Tap:

```text
⬇ 1080p WEB-DL
```

and the source is queued in the background.

No separate media browser.
No copying magnet links.
No separate downloader workflow.

Later, return to the same Stremio title:

```text
Stremio Offline
✅ OFFLINE • 1080p WEB-DL
```

Tap it and Stremio plays the local file.

---

# 1. What Stremio allows

Stremio addons provide resources such as catalogs, metadata, streams and subtitles. A Stream Object can contain a direct `url`, torrent `infoHash + fileIdx`, or an `externalUrl`. There is currently no native addon `"download"` resource or extension API that allows an addon to inject a new Stremio toolbar button.

Therefore:

```text
PURE REMOTE ADDON
       ✗
cannot persist files locally
cannot run background torrent client
cannot inject native Download button
```

But Stremio explicitly supports addons running from `127.0.0.1`, and Stremio itself ships its Local Files addon this way.

Therefore the architecture becomes:

```text
                 STREMIO
                    │
             Stremio protocol
                    │
                    ▼
       http://127.0.0.1:PORT
       ┌────────────────────┐
       │ Stremio Offline    │
       │ Local Addon        │
       └─────────┬──────────┘
                 │
        queries configured
         source addons
                 │
        ┌────────┼─────────┐
        ▼        ▼         ▼
    Torrentio   TPB+     others
                 │
                 ▼
       source normalisation
                 │
        ┌────────┴────────┐
        ▼                 ▼
     torrent             HTTP
 infoHash/fileIdx         URL
        │                 │
        └────────┬────────┘
                 ▼
         background engine
                 │
                 ▼
          persistent file
```

To the user, **the local service is the addon**.

---

# 2. Distribution

One package per platform:

```text
Stremio Offline for Windows
Stremio Offline for Android
```

First launch performs:

```text
1. start local service
2. register URI/action handler
3. open Stremio addon install URL
4. user presses Install once
```

After that the user normally never opens our app.

Desktop:

```text
StremioOffline.exe
    ├── local addon HTTP server
    ├── background download engine
    ├── SQLite
    ├── protocol handler
    └── optional tray icon
```

Android:

```text
Stremio Offline APK
    ├── local addon HTTP server
    ├── foreground download service
    ├── torrent engine
    ├── Room/SQLite
    └── deep-link activity
```

---

# 3. Addon manifest

Local manifest:

```text
http://127.0.0.1:PORT/manifest.json
```

Resources:

```json
{
  "resources": [
    "stream",
    "catalog",
    "meta"
  ],
  "types": [
    "movie",
    "series"
  ],
  "idPrefixes": [
    "tt"
  ]
}
```

Why `catalog` and `meta` as well as `stream` becomes important later:

**Downloads remain browsable from inside Stremio even without internet.**

---

# 4. Upstream addon integration

Stremio Offline acts as a proxy/aggregator around existing stream addons.

Stremio's addon documentation explicitly describes addons requesting/proxying responses from other addons, so this is consistent with the architecture rather than scraping another addon's webpage.

Configuration:

```text
SOURCE ADDONS

✓ Torrentio
✓ ThePirateBay+
✓ Another Stremio stream addon
```

Internally store each upstream transport URL:

```ts
interface SourceAddon {
    id: string
    manifestUrl: string
    transportUrl: string
    enabled: boolean
}
```

For:

```text
movie / tt0816692
```

we request:

```text
<upstream>/stream/movie/tt0816692.json
```

For:

```text
series / tt11280740:2:4
```

request the equivalent series stream resource.

Then normalize the returned Stream Objects.

---

# 5. Supported offline source types

## Torrent

The ideal source:

```json
{
  "infoHash": "...",
  "fileIdx": 4,
  "sources": [...]
}
```

Stremio defines this specifically as a BitTorrent source, with `fileIdx` identifying the desired video within the torrent.

Normalize:

```ts
type TorrentSource = {
    kind: "torrent"
    infoHash: string
    fileIdx?: number
    trackers: string[]
    size?: number
    filename?: string
}
```

This means a season pack does NOT require downloading the entire season.

Example:

```text
Show.S02/
    episode01.mkv
    episode02.mkv
    episode03.mkv
```

with:

```text
fileIdx = 1
```

downloads only the selected episode.

---

## HTTP

For:

```json
{
  "url": "https://...."
}
```

normalize:

```ts
type HttpSource = {
    kind: "http"
    url: string
    requestHeaders?: Record<string,string>
    filename?: string
    size?: number
}
```

Support:

```text
Range requests
resume
redirects
ETag
Last-Modified
temporary URLs
proxyHeaders
```

The current Stremio stream spec supports direct URLs and proxy request headers.

---

# 6. Seamless Stremio UX

For each downloadable upstream source:

```text
Torrentio

4K DV/HDR
REMUX • 67 GB
```

our addon returns:

```text
Stremio Offline

⬇ 4K DV/HDR
REMUX • 67 GB
```

Crucially, it is another **Stream Object**, so it naturally appears in Stremio's existing stream picker.

Example conceptually:

```json
{
  "name": "⬇ OFFLINE • 4K",
  "description": "REMUX • HDR • 67 GB\nTorrentio",
  "externalUrl": "stremio-offline://enqueue/<TOKEN>"
}
```

The token references a source descriptor already stored by our local runtime.

Do NOT put:

```text
magnet:?...
API keys
debrid credentials
complete upstream URLs
```

into the action URI.

Use:

```text
stremio-offline://enqueue/a8c92...
```

instead.

---

# 7. The one technical spike we must validate first

This is the most important unknown before building anything substantial:

### Does every target Stremio client cleanly dispatch our custom `externalUrl` scheme?

The current SDK officially supports `externalUrl`, while older Stremio protocol documentation additionally describes platform-specific external URIs for Android/iOS.

Before building the engine, make:

```text
hello-offline addon
```

which returns:

```text
⬇ TEST DOWNLOAD
```

with:

```text
stremio-offline://test?id=123
```

Then verify:

```text
Windows Stremio  ✓/✗
Android Stremio  ✓/✗
```

Desired Android behavior:

```text
tap stream
    ↓
our transparent activity receives Intent
    ↓
queue action
    ↓
finish()
    ↓
Stremio remains / returns foreground
```

Desired Windows behavior:

```text
tap stream
    ↓
registered URI protocol
    ↓
running daemon receives command
    ↓
no visible application window
```

If this works, the product is viable on **unmodified Stremio**.

If Stremio/browser handling interferes with arbitrary URI schemes, this becomes the first thing to solve.

Do not build the torrent engine before passing this spike.

---

# 8. Download action lifecycle

User taps:

```text
⬇ 1080p • 8.2 GB
```

Runtime receives:

```text
enqueue(sourceToken)
```

Response should require no second UI.

Android notification:

```text
Interstellar

███████░░░░░ 58%

6.2 MB/s • 18 min

[Pause] [Cancel]
```

Windows:

```text
background download
```

with tray/notification optional.

The user stays in Stremio.

---

# 9. Dynamic stream state

This is where integration starts feeling native.

Before downloading:

```text
⬇ OFFLINE
1080p • 8.2 GB
```

During download:

```text
⏳ 58% DOWNLOADED
1080p • 4.8 / 8.2 GB
```

After completion:

```text
✅ OFFLINE
1080p • 8.2 GB
```

Because the addon stream endpoint is dynamic, every time Stremio asks for the title's streams our local addon checks the download DB.

Pseudo:

```ts
if (completed(mediaId, source)) {
    return localPlaybackStream
}

if (downloading(mediaId, source)) {
    return progressAction
}

return downloadAction
```

---

# 10. Local playback

Once finished:

```json
{
  "name": "✅ OFFLINE • 1080p",
  "description": "Stored on this device",
  "url": "http://127.0.0.1:PORT/media/JOB_ID"
}
```

Our server supports:

```http
HEAD
GET
Range: bytes=x-y
```

so Stremio's own player can seek normally.

Therefore playback remains:

```text
Stremio UI
   ↓
Stremio player
   ↓
localhost
   ↓
downloaded .mkv
```

We're not building a media player.

---

# 11. True Offline catalog

This should be part of V1.5 because it makes the product much stronger.

Addon exposes:

```text
Discover
    ↓
Offline Movies

Discover
    ↓
Offline Series
```

When a download is created, snapshot metadata:

```ts
OfflineMeta {
    type
    imdbId
    title
    poster
    background
    description
    videos[]
}
```

Then:

```text
Internet disconnected

Open Stremio

Discover
  → Offline Movies
       → Interstellar
       → Dune
       → Arrival
```

Because:

```text
catalog
meta
stream
```

are all being served from localhost.

No remote Cinemeta request needs to succeed for our downloaded library.

---

# 12. Series UX

Inside an episode:

```text
SEVERANCE
S02 E04

Torrentio ...
Torrentio ...

Stremio Offline
⬇ 1080p • WEB-DL • 2.8 GB

Stremio Offline
⬇ 4K • WEB-DL • 7.3 GB
```

Once complete:

```text
Stremio Offline
✅ OFFLINE • 1080p
```

Later we can add a local catalog action:

```text
Download season
```

but this cannot be a native Stremio toolbar action.

A practical implementation would expose:

```text
Stremio Offline
⬇ Download S02
```

which launches our action handler and resolves episodes in the background.

---

# 13. Source deduplication

Torrent identity:

```text
infoHash + fileIdx
```

If three configured addons expose the same torrent:

```text
Torrentio
TPB+
Another addon
```

do not show three Offline entries.

Merge:

```ts
{
    source: { infoHash, fileIdx },
    providers: [
        "Torrentio",
        "TPB+"
    ]
}
```

Display:

```text
⬇ 1080p WEB-DL • 7.9 GB
Torrentio + TPB+
```

---

# 14. Don't duplicate every Stremio stream unnecessarily

There are two operating modes.

## Companion mode

Keep Torrentio etc installed normally.

Their existing streams remain:

```text
Torrentio
▶ 1080p WEB-DL
```

We only expose:

```text
Stremio Offline
⬇ 1080p WEB-DL
```

Best initial product.

---

## Proxy mode

Eventually the user can disable the original provider and use:

```text
Stremio Offline
```

as a wrapper.

We return:

```text
▶ PLAY • 1080p
⬇ OFFLINE • 1080p

▶ PLAY • 4K
⬇ OFFLINE • 4K
```

Both come from the same upstream source.

This gives us considerably more control over filtering, deduplication and presentation.

But Companion Mode should ship first because it cannot break users' existing playback setup.

---

# 15. Configuration

The only non-Stremio interface we actually need is initial configuration.

Example:

```text
STREMIO OFFLINE

Source addons

Torrentio
https://configured-addon/.../manifest.json

TPB+
https://.../manifest.json

Storage

D:\Movies

Quality filters
☑ 1080p
☑ 2160p
☐ CAM

[Install into Stremio]
```

After setup:

```text
Close configuration.
Never open it again unless needed.
```

Stremio addons officially support configuration pages as part of their manifest/config flow.

---

# 16. Importing existing Stremio addons

V1:

```text
paste configured addon URL
```

V2:

```text
Import my Stremio addon configuration
```

Do not make account integration mandatory for the first release.

Configured provider URLs can contain user-specific options or credentials, so they must:

```text
remain local
never enter telemetry
never be written to logs
never be uploaded to our servers
```

We can make the entire application serverless.

---

# 17. Architecture

```text
packages/
│
├── addon-core
│   ├── manifest
│   ├── stream-handler
│   ├── catalog-handler
│   └── meta-handler
│
├── addon-proxy
│   ├── upstream-client
│   ├── source-normalizer
│   └── deduplicator
│
├── download-core
│   ├── jobs
│   ├── persistence
│   ├── resume
│   └── source-resolver
│
└── models

apps/
│
├── desktop-runtime
│
└── android-runtime
```

Shared source representation:

```ts
type OfflineSource =
    | {
        type: "torrent"
        infoHash: string
        fileIdx?: number
        trackers?: string[]
        filename?: string
        size?: number
      }
    | {
        type: "http"
        url: string
        requestHeaders?: Record<string,string>
        filename?: string
        size?: number
      }
```

---

# 18. Download persistence

Every job:

```ts
interface DownloadJob {
    id: string

    media: {
        type: "movie" | "series"
        mediaId: string
        videoId?: string
        season?: number
        episode?: number
        title: string
    }

    source: OfflineSource

    status:
        | "queued"
        | "resolving"
        | "downloading"
        | "paused"
        | "complete"
        | "error"

    bytesDownloaded: number
    totalBytes?: number

    localPath: string
    createdAt: number
}
```

Torrent session state must also survive process termination.

Acceptance test:

```text
download → 37%
kill runtime
restart phone/PC
runtime starts
download resumes near 37%
```

---

# 19. Android

Use:

```text
Kotlin
Foreground Service
Room
Storage Access Framework
libtorrent/native torrent engine
```

The foreground service is important because Android aggressively limits background activity.

User chooses storage once:

```text
Downloads/Stremio Offline/
```

Then downloads continue with notifications.

Our action Activity should be practically invisible:

```text
DeepLinkActivity
   ↓
service.enqueue()
   ↓
finish()
```

---

# 20. Desktop

A lightweight daemon/tray application:

```text
Rust
    or
small native runtime

SQLite
torrent engine
HTTP server
URI protocol handler
```

Startup:

```text
start with OS
bind only 127.0.0.1
```

No Electron application required.

A browser configuration UI served from:

```text
127.0.0.1
```

is enough.

---

# 21. Security

The localhost server must NOT be a completely open RPC interface.

Protect every privileged operation.

Example:

```text
http://127.0.0.1:PORT
```

is reachable by arbitrary webpages in the user's browser.

Therefore:

```text
random install secret
action tokens
strict CORS
CSRF protections
origin checks where applicable
short-lived enqueue tokens
no arbitrary filesystem paths
no arbitrary command execution
```

An action token should map to:

```text
known source #18372
```

not:

```text
download whatever URL appears in query string
```

---

# 22. Why not use Stremio's existing cache?

Because it isn't the product we're trying to build.

As of August 19, 2026, Stremio itself says native offline downloading is unsupported; desktop can retain files through its cache, currently configurable up to 10 GB.

Cache is:

```text
evictable
size constrained
not an explicit library
not download-managed
not equivalent across platforms
```

We need:

```text
persistent
user-selected
pause/resume
visible
non-evicting
offline library
```

---

# 23. Critical build order

### Spike 1 — action integration

Build:

```text
localhost addon
↓
one movie
↓
one stream:
⬇ TEST
↓
custom URI handler invoked
```

Pass on:

```text
Windows
Android
```

This is the make-or-break test.

---

### Spike 2 — local playback

Download/public test file manually.

Return:

```text
✅ OFFLINE
```

from addon with:

```text
url = localhost file endpoint
```

Verify:

```text
Stremio player
seeking
subtitles
resume
Android
Windows
```

---

### Spike 3 — upstream proxy

Configure one legal/test Stremio stream addon.

Request:

```text
stream/movie/ID
```

Normalize its streams and create corresponding:

```text
⬇ OFFLINE
```

entries.

---

### Spike 4 — torrent

Use a public-domain/test torrent:

```text
infoHash
fileIdx
```

Queue from Stremio.

Download.

Return:

```text
✅ OFFLINE
```

Play in Stremio.

---

### Spike 5 — persistence

```text
queue
kill
restart
resume
complete
disable internet
play
```

After these five pass, we have the product.

---

# 24. MVP definition

MVP is complete when this works:

```text
1. Install Stremio Offline runtime.

2. Press "Install into Stremio".

3. Add one existing source addon URL.

4. Open any compatible movie in normal Stremio.

5. Existing provider streams appear normally.

6. Stremio Offline entries also appear:

   ⬇ 1080p
   ⬇ 4K

7. Tap ⬇ 1080p.

8. Download begins without requiring another selection.

9. Close Stremio.

10. Download continues.

11. Restart device.

12. Download resumes.

13. Open the movie again.

14. Stream list now shows:

    ✅ OFFLINE • 1080p

15. Disable internet.

16. Select it.

17. Movie plays using Stremio's own player.
```

That is the product.

---

# 25. Longer-term killer feature

Eventually:

```text
Stremio
Discover
↓
Offline Library
```

with:

```text
Movies
Series
Episodes
Downloaded
Downloading
```

and automatic rules:

```text
When a new episode becomes available:
    prefer 1080p
    prefer WEB-DL
    max 6 GB
    download automatically
```

At that point this isn't merely a torrent downloader attached to Stremio.

It becomes:

> **the offline layer of the Stremio addon ecosystem.**
