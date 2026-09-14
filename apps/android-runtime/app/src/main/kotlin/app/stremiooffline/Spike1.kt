package app.stremiooffline

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicReference

/**
 * Spike 1 on Android, the make-or-break test of DESIGN section 7: does tapping a
 * stream whose externalUrl is a stremio-offline:// URI reach this app?
 *
 * This mirrors apps/desktop-runtime/src/spike1.ts on purpose, down to the entry
 * text, so the same tap can be compared across platforms. Nothing is downloaded
 * and nothing is persisted: the spike is a yes/no answer, not a feature.
 */
const val ACTION_SCHEME = "stremio-offline"
const val ADDON_ID = "community.stremio-offline.local"
const val ADDON_VERSION = "0.0.1"

/** The desktop runtime's port, so the install URL is the same sentence on both. */
const val ADDON_PORT = 34701

data class ReceivedAction(val action: String, val id: String, val atMillis: Long)

/**
 * Shared between the deep-link activity and the service. Both run in this app's
 * single process, so an in-memory record is enough to answer the spike; the real
 * runtime will put jobs in a database instead.
 */
object Spike1 {
    private val actions = AtomicReference<List<ReceivedAction>>(emptyList())

    fun record(action: ReceivedAction) {
        actions.updateAndGet { it + action }
    }

    fun received(): List<ReceivedAction> = actions.get()

    fun installUrl(): String = "http://127.0.0.1:$ADDON_PORT/manifest.json"

    /** Manifest served at /manifest.json. No catalogs: this spike holds no library. */
    fun manifestJson(): String =
        JSONObject()
            .put("id", ADDON_ID)
            .put("version", ADDON_VERSION)
            .put("name", "Stremio Offline (Spike 1)")
            .put(
                "description",
                "Spike 1 of Stremio Offline: every title gets one TEST DOWNLOAD entry that opens " +
                    "$ACTION_SCHEME://test. It downloads nothing.",
            )
            .put("resources", JSONArray().put("stream"))
            .put("types", JSONArray().put("movie").put("series"))
            .put("idPrefixes", JSONArray().put("tt"))
            .put("catalogs", JSONArray())
            .put("behaviorHints", JSONObject().put("configurable", false).put("configurationRequired", false))
            .toString()

    /**
     * One entry per title. Before any action arrives it invites a tap; afterwards
     * it reports that the handler fired, so the spike can be read from inside
     * Stremio without looking at the phone's logcat.
     */
    fun streamsJson(id: String): String {
        val last = received().lastOrNull()
        val stream =
            if (last == null) {
                JSONObject()
                    .put("name", "⬇ TEST DOWNLOAD")
                    .put("description", "Spike 1: tap to test the $ACTION_SCHEME:// handler\nNothing is downloaded")
            } else {
                val count = received().size
                JSONObject()
                    .put("name", "✅ HANDLER OK")
                    .put(
                        "description",
                        "App received $count action${if (count == 1) "" else "s"}, last for ${last.id}\nTap to test again",
                    )
            }
        stream.put("externalUrl", testActionUri(id))
        return JSONObject().put("streams", JSONArray().put(stream)).toString()
    }

    fun testActionUri(id: String): String = "$ACTION_SCHEME://test?id=" + java.net.URLEncoder.encode(id, "UTF-8")
}
