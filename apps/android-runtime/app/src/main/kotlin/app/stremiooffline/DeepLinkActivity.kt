package app.stremiooffline

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.Toast

/**
 * What Spike 1 is actually testing. Stremio opens the stream's externalUrl,
 * Android dispatches it here, this records it and finishes immediately.
 *
 * It must stay practically invisible: translucent, no history, excluded from
 * recents (see AndroidManifest), and finished inside onCreate, so Stremio is
 * still in front when the user looks up (DESIGN section 7).
 */
class DeepLinkActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val uri = intent?.data
        if (uri == null || uri.scheme != ACTION_SCHEME) {
            Log.w(TAG, "ignoring an intent that is not a $ACTION_SCHEME:// URI")
            finish()
            return
        }

        // stremio-offline://test?id=tt0816692 -> action "test"; the path carries an
        // enqueue token instead, once there is something to enqueue.
        val action = uri.host.orEmpty().lowercase()
        val id = uri.getQueryParameter("id") ?: uri.pathSegments.firstOrNull() ?: "?"
        Spike1.record(ReceivedAction(action, id, System.currentTimeMillis()))
        Log.i(TAG, "received action \"$action\" for $id")

        // The addon has to stay reachable for the entry to flip to HANDLER OK, and
        // a tap is a good moment to notice the service was killed.
        RuntimeService.start(this)

        // A toast, not a screen: proof the handler fired without taking focus.
        Toast.makeText(this, "Stremio Offline: $action received", Toast.LENGTH_SHORT).show()
        finish()
    }

    private companion object {
        const val TAG = "DeepLinkActivity"
    }
}
