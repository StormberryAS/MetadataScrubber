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
 * Ending the copied picture's 2 minutes (1.0.1), and a shared file's 10 minutes (1.1.0),
 * from wherever the app happens to be.
 *
 * Three layers, none of which needs a permission:
 *  1. OutgoingProvider refuses an expired copy or shared file, deletes it and withdraws its
 *     grants. Every read goes through it, and Android wakes or starts the app for it, so no
 *     read can succeed after the time whatever else happened. This is the guarantee.
 *  2. A Handler timer in MainActivity deletes them on time while the app is running, and
 *     also clears the clipboard if it still holds the picture (only the app in focus may).
 *  3. An inexact, non-waking AlarmManager alarm to ClipExpiryReceiver (not exported) deletes
 *     them when the app is in the background: Android freezes a background app's process, so
 *     its Handler stops, but an alarm brings it back. Inexact alarms need no permission and
 *     may come a little late (and wait while the screen is off); exact alarms would need
 *     SCHEDULE_EXACT_ALARM, and a foreground service or WorkManager would add permissions,
 *     which the app does not take. One alarm serves both: it is set for whichever ends first.
 * And a sweep whenever the app starts, comes back, goes to the background or is short of
 * memory removes anything past its time, for example after the app was killed.
 */
object ClipExpiry {
    private const val ACTION = "no.stormberry.metadatascrubber.action.CLIP_EXPIRED"

    /** Time added to every timer, so the sweep it starts finds the copy or file expired. */
    const val SLACK_MS = 250L

    fun authority(context: Context) = "${context.packageName}.outgoing"

    /**
     * Deletes every expired copy and shared file, withdraws their read grants, and sets the
     * alarm for whatever is still live (or cancels it). Returns the deleted copies only, for
     * the clipboard check.
     */
    fun sweep(context: Context): List<File> {
        val clips = ClipboardFiles(context.cacheDir)
        val gone = clips.sweep().map { File(it, ClipboardFiles.NAME) }
        gone.forEach { revoke(context, it) }
        OutgoingFiles(context.cacheDir).sweepShared().forEach { revoke(context, it) }
        schedule(context)
        return gone
    }

    /**
     * Milliseconds until the live copy or the next shared file ends, plus [SLACK_MS] so the
     * sweep then finds it expired; null when nothing is live.
     */
    fun nextDueMs(context: Context): Long? {
        val clips = ClipboardFiles(context.cacheDir)
        val clip = clips.current()?.let { clips.remainingMs(it) }
        val share = OutgoingFiles(context.cacheDir).nextShareEndMs()
        return listOfNotNull(clip, share).minOrNull()?.plus(SLACK_MS)
    }

    /** Sets (or moves) the background alarm to the next end, or cancels it. Returns the delay. */
    fun schedule(context: Context): Long? {
        val next = nextDueMs(context)
        if (next == null) cancelAlarm(context) else setAlarm(context, next)
        return next
    }

    fun revoke(context: Context, file: File) {
        try {
            context.revokeUriPermission(FileProvider.getUriForFile(context, authority(context), file), Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: Exception) {
            // Nothing was granted for it.
        }
    }

    private fun setAlarm(context: Context, inMs: Long) {
        try {
            context.getSystemService(AlarmManager::class.java)
                ?.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + inMs, pending(context))
        } catch (_: Exception) {
            // The provider still refuses the copy or shared file after its time.
        }
    }

    private fun cancelAlarm(context: Context) {
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
        // Deletes what has ended and sets the alarm again for anything still live, such as
        // a newer copy or a later share.
        ClipExpiry.sweep(context.applicationContext)
    }
}
