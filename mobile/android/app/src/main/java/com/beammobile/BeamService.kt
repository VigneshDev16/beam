package com.beammobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * Keeps the receiver alive while "Receive files" is on.
 *
 * Android freezes a plain background process within a minute or two of leaving
 * the app — which is exactly the moment someone switches to their laptop to
 * send something. A foreground service (and the notification that comes with
 * it) is the only supported way to stay listening, and the notification
 * doubles as the honest signal that a port is open.
 */
class BeamService : Service() {

  companion object {
    private const val CHANNEL_STATUS = "beam-status"
    private const val CHANNEL_ARRIVALS = "beam-arrivals"
    private const val STATUS_ID = 4711
    private var nextArrivalId = 5000

    fun start(ctx: Context) {
      val intent = Intent(ctx, BeamService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
    }

    fun stop(ctx: Context) {
      ctx.stopService(Intent(ctx, BeamService::class.java))
    }

    private fun manager(ctx: Context) =
        ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    fun ensureChannels(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val status =
          NotificationChannel(
              CHANNEL_STATUS, "Receiving", NotificationManager.IMPORTANCE_LOW)
      status.description = "Shown while Beam is listening for incoming files"
      val arrivals =
          NotificationChannel(
              CHANNEL_ARRIVALS, "Files received", NotificationManager.IMPORTANCE_DEFAULT)
      arrivals.description = "One notification per file that arrives"
      manager(ctx).createNotificationChannel(status)
      manager(ctx).createNotificationChannel(arrivals)
    }

    /** Tell the person a file landed, even if they're in another app. */
    fun notifyArrival(ctx: Context, name: String, sender: String) {
      ensureChannels(ctx)
      val builder =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(ctx, CHANNEL_ARRIVALS)
          } else {
            @Suppress("DEPRECATION") Notification.Builder(ctx)
          }
      val notification =
          builder
              .setContentTitle(name)
              .setContentText("Received from $sender")
              .setSmallIcon(android.R.drawable.stat_sys_download_done)
              .setContentIntent(openApp(ctx))
              .setAutoCancel(true)
              .build()
      try {
        manager(ctx).notify(nextArrivalId++, notification)
      } catch (e: SecurityException) {
        // Notifications not granted (Android 13+). The file still arrived.
      }
    }

    private fun openApp(ctx: Context): PendingIntent {
      val intent =
          Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
          }
      return PendingIntent.getActivity(
          ctx, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannels(this)
    startForeground(STATUS_ID, statusNotification())
    // Not sticky: the HTTP server lives in the app process, so a restarted
    // service on its own would show "ready to receive" with nothing listening.
    return START_NOT_STICKY
  }

  private fun statusNotification(): Notification {
    val builder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          Notification.Builder(this, CHANNEL_STATUS)
        } else {
          @Suppress("DEPRECATION") Notification.Builder(this)
        }
    return builder
        .setContentTitle("Beam is ready to receive")
        .setContentText("Other devices on this Wi-Fi can send you files")
        .setSmallIcon(android.R.drawable.stat_sys_download)
        .setContentIntent(openApp(this))
        .setOngoing(true)
        .build()
  }
}
