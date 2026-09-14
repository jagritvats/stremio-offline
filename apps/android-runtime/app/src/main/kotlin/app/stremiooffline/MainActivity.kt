package app.stremiooffline

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.text.DateFormat
import java.util.Date

/**
 * The only screen. It starts the runtime, shows the URL to paste into Stremio,
 * and lists the actions that have arrived, so Spike 1 can be run and read
 * without a cable or logcat.
 *
 * Built in code rather than XML: it is a label, two buttons and a log, and the
 * real configuration screen belongs to a later spike.
 */
class MainActivity : Activity() {

    private lateinit var status: TextView
    private lateinit var log: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestNotificationPermission()

        val pad = (16 * resources.displayMetrics.density).toInt()
        val root =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(pad, pad, pad, pad)
            }

        root.addView(
            TextView(this).apply {
                text = "Stremio Offline — Spike 1"
                textSize = 22f
            },
        )
        root.addView(
            TextView(this).apply {
                text =
                    "Start the runtime, then in Stremio: Addons, paste the URL below, Install. " +
                        "Open any title and tap “⬇ TEST DOWNLOAD”."
                setPadding(0, pad / 2, 0, pad / 2)
            },
        )

        status =
            TextView(this).apply {
                setTextIsSelectable(true)
                setPadding(0, 0, 0, pad / 2)
            }
        root.addView(status)

        val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        buttons.addView(
            Button(this).apply {
                text = "Start runtime"
                setOnClickListener {
                    RuntimeService.start(this@MainActivity)
                    refresh()
                }
            },
        )
        buttons.addView(
            Button(this).apply {
                text = "Stop"
                setOnClickListener {
                    RuntimeService.stop(this@MainActivity)
                    refresh()
                }
            },
        )
        root.addView(buttons)

        root.addView(
            TextView(this).apply {
                text = "Actions received"
                setPadding(0, pad, 0, pad / 4)
                gravity = Gravity.START
            },
        )
        log =
            TextView(this).apply {
                movementMethod = ScrollingMovementMethod()
                setTextIsSelectable(true)
            }
        root.addView(
            ScrollView(this).apply {
                addView(log)
                layoutParams =
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0).apply { weight = 1f }
            },
        )

        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        status.text = "Install URL: ${Spike1.installUrl()}"
        val received = Spike1.received()
        log.text =
            if (received.isEmpty()) {
                "Nothing yet. A tap in Stremio should appear here."
            } else {
                val time = DateFormat.getTimeInstance()
                received.reversed().joinToString("\n") { action ->
                    "${time.format(Date(action.atMillis))}  ${action.action}  ${action.id}"
                }
            }
    }

    private fun requestNotificationPermission() {
        // The runtime is a foreground service, and without this its notification is
        // silently dropped on Android 13+, which makes the service look broken.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
}
