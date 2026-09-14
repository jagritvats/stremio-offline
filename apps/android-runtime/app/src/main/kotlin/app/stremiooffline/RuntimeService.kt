package app.stremiooffline

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Keeps the addon answering. Android stops background work aggressively, so a
 * listening socket only survives inside a foreground service with a visible
 * notification (DESIGN section 19). The download engine will live here too.
 */
class RuntimeService : Service() {

    private val server = AddonServer()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        try {
            server.start()
        } catch (error: Exception) {
            // Most often the port is already taken by a second copy of this app.
            Log.e(TAG, "the addon server could not start", error)
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        server.stop()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startForegroundCompat() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Stremio Offline runtime", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps the local addon reachable by Stremio."
            },
        )

        val open =
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val notification: Notification =
            Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("Stremio Offline")
                .setContentText("Addon running on ${Spike1.installUrl()}")
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setOngoing(true)
                .setContentIntent(open)
                .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        private const val TAG = "RuntimeService"
        private const val CHANNEL_ID = "stremio-offline-runtime"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            context.startForegroundService(Intent(context, RuntimeService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RuntimeService::class.java))
        }
    }
}
