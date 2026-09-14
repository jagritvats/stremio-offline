# android-runtime

The Android half of Stremio Offline. Right now it is **Spike 1 only**: the app
serves the hello-offline addon on loopback and catches the `stremio-offline://`
URI that Stremio opens when a stream entry is tapped. It downloads nothing.

Gradle project, deliberately outside the pnpm workspace. It shares no tooling
with the TypeScript packages, only the protocol they both speak.

## Status

> **Not compiled.** These sources were written without an Android SDK available
> and have never been built or run. Treat the first `./gradlew assembleDebug` as
> part of the work, not as a formality: expect to fix version pins and whatever
> the compiler finds. Nothing here has been proven beyond review.

| | |
|---|---|
| Built | loopback addon server, deep-link activity, foreground service, one screen |
| Not built | downloads, `/media` playback, the offline library, storage selection, the torrent engine |

## What each file is for

| File | Why it exists |
|---|---|
| `Spike1.kt` | The addon's manifest and stream JSON, and the in-memory record of actions received. Mirrors `apps/desktop-runtime/src/spike1.ts` so the same tap can be compared across platforms. |
| `AddonServer.kt` | An HTTP server on `127.0.0.1:34701` serving `/manifest.json` and `/stream/{type}/{id}.json`. Hand-rolled: three routes should not introduce a dependency before the spike answers its question. |
| `RuntimeService.kt` | A foreground service, because Android will not leave a listening socket running in the background (DESIGN §19). |
| `DeepLinkActivity.kt` | The thing being tested. Translucent, no history, excluded from recents, finished inside `onCreate`, so Stremio never leaves the foreground (DESIGN §7). |
| `MainActivity.kt` | Start and stop the runtime, show the install URL, list the actions that arrived. Enough to run the spike without a cable. |

There are no third-party dependencies. `org.json`, `Notification.Builder` and
`ServerSocket` are all framework APIs.

## Running Spike 1

Needs Android Studio, or a command-line SDK with `ANDROID_HOME` set and a
`local.properties` naming it. `minSdk` is 26, `compileSdk` 35.

```sh
cd apps/android-runtime
./gradlew assembleDebug
./gradlew installDebug        # a connected device or emulator
```

Then, on the device:

1. Open **Stremio Offline** and press **Start runtime**. A notification appears.
2. In Stremio: Addons, paste `http://127.0.0.1:34701/manifest.json`, Install.
3. Open any movie or episode. The stream list shows **⬇ TEST DOWNLOAD**.
4. Tap it.

**Pass:** a toast reads `Stremio Offline: test received`, Stremio stays in front,
the app's screen lists the action, and re-opening the title in Stremio shows
**✅ HANDLER OK**. Record ✅ in [`docs/SPIKES.md`](../../docs/SPIKES.md) with the
Android and Stremio versions.

**Fail:** nothing arrives, or Android offers a chooser, or Stremio swallows the
URI. Record ❌ with exactly what happened. That outcome is the whole reason this
spike exists, and it decides whether the Android product is viable on unmodified
Stremio at all.

## Known gaps to close before this is a runtime

- **A `dataSync` foreground service has a daily runtime cap on Android 14+.** A
  long download will need either a different service type or work that survives
  being stopped and resumed.
- **Actions are in memory.** A killed process forgets them. Real jobs need Room,
  or the same on-disk shape the desktop runtime uses.
- **There is no install secret.** The desktop runtime puts every privileged
  operation behind one (DESIGN §21) and this app serves nothing privileged yet.
  The moment it can enqueue or write files, it needs the same check: any app on
  the device can reach a loopback port.
- **Storage is not chosen.** DESIGN §19 wants the Storage Access Framework and a
  folder the user picks once.
