package no.stormberry.metadatascrubber

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.core.content.FileProvider
import java.io.File

/**
 * Ending the copied picture's 2 minutes, from wherever the app happens to be (1.0.1).
 *
 * Three layers, none of which needs a permission:
 *  1. OutgoingProvider refuses an expired copy, deletes it and withdraws its grants. Every
 *     paste goes through it, and Android wakes or starts the app for it, so no paste can
 *     succeed after 2 minutes whatever else happened. This is the guarantee.
 *  2. A Handler timer in MainActivity deletes the copy on time while the app is running, and
 *     also clears the clipboard if it still holds the picture (only the app in focus may).
 *  3. An inexact, non-waking AlarmManager alarm to ClipExpiryReceiver (not exported) deletes
 *     it when the app is in the background: Android freezes a background app's process, so
 *     its Handler stops, but an alarm brings it back. Inexact alarms need no permission and
 *     may come a little late (and wait while the screen is off); exact alarms would need
 *     SCHEDULE_EXACT_ALARM, and a foreground service or WorkManager would add permissions,
 *     which the app does not take.
 * And a sweep whenever the app starts, comes back, goes to the background or is short of
 * memory removes any copy past its time, for example after the app was killed.
 */
object ClipExpiry {
    private const val ACTION = "no.stormberry.metadatascrubber.action.CLIP_EXPIRED"

    fun authority(context: Context) = "${context.packageName}.outgoing"

    /** Deletes every expired copy and withdraws its read grants. Returns the deleted files. */
    fun sweep(context: Context): List<File> {
        val clips = ClipboardFiles(context.cacheDir)
        val gone = clips.sweep().map { File(it, ClipboardFiles.NAME) }
        gone.forEach { revoke(context, it) }
        if (clips.current() == null) cancelAlarm(context)
        return gone
    }

    fun revoke(context: Context, file: File) {
        try {
            context.revokeUriPermission(FileProvider.getUriForFile(context, authority(context), file), Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: Exception) {
            // Nothing was granted for it.
        }
    }

    /** Sets (or moves) the background alarm to the live copy's end. */
    fun setAlarm(context: Context, inMs: Long) {
        try {
            context.getSystemService(AlarmManager::class.java)
                ?.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + inMs, pending(context))
        } catch (_: Exception) {
            // The provider still refuses the copy after its time.
        }
    }

    fun cancelAlarm(context: Context) {
        try {
            context.getSystemService(AlarmManager::class.java)?.cancel(pending(context))
        } catch (_: Exception) {
        }
    }

    private fun pending(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context, 0,
            Intent(context, ClipExpiryReceiver::class.java).setAction(ACTION),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    internal fun isOurs(intent: Intent?) = intent?.action == ACTION
}

/** The background alarm's target. Not exported: only this app's own PendingIntent reaches it. */
class ClipExpiryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!ClipExpiry.isOurs(intent)) return
        val app = context.applicationContext
        val clips = ClipboardFiles(app.cacheDir)
        ClipExpiry.sweep(app)
        // A newer copy may have started meanwhile: keep the alarm for its end.
        clips.current()?.let { ClipExpiry.setAlarm(app, clips.remainingMs(it) + 250) }
    }
}
