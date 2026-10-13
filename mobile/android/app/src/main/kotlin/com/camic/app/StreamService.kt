package com.camic.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the Camic process eligible to use the
 * camera/microphone while the app is backgrounded (screen off / app switch).
 *
 * Without this, Android 10+ moves the app to a cached/background proc state
 * and Camera2 throws CAMERA_DISABLED ("cannot open camera from background"),
 * which kills the stream. A camera-typed foreground service keeps proc state
 * important so the encoders keep running. A partial wake lock keeps the CPU
 * from sleeping so the UDP stream doesn't stall with the screen off.
 */
class StreamService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Camic is active")
            .setContentText("Camera + mic are available as a wireless webcam.")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        // Foreground with the CAMERA type so camera access survives backgrounding.
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
        } else {
            startForeground(NOTIF_ID, notification)
        }

        // Partial wake lock: CPU stays awake so the UDP stream keeps flowing
        // with the screen off (screen itself can still turn off).
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Camic:stream").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

    override fun onDestroy() {
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Throwable) {}
        wakeLock = null
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(CHANNEL_ID, "Camic streaming", NotificationManager.IMPORTANCE_LOW)
            channel.setShowBadge(false)
            mgr.createNotificationChannel(channel)
        }
    }

    companion object {
        private const val CHANNEL_ID = "camic_stream"
        private const val NOTIF_ID = 4748

        /** Start the foreground service (safe from any context). */
        fun start(context: Context) {
            try {
                val intent = Intent(context, StreamService::class.java)
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
                else context.startService(intent)
            } catch (_: Throwable) { /* best-effort */ }
        }

        /** Stop the foreground service. */
        fun stop(context: Context) {
            try { context.stopService(Intent(context, StreamService::class.java)) } catch (_: Throwable) {}
        }
    }
}
