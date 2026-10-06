package no.stormberry.metadatascrubber

import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import java.io.FileNotFoundException

/**
 * The app's FileProvider, with one rule added: a copied picture (cache/clipboard/) can be
 * read for 2 minutes after the Copy and never after (ClipboardFiles.isExpired). Shared files
 * (cache/outgoing/) are served exactly as before.
 *
 * This is where the 2 minutes are enforced, because it is the only code every paste has to
 * go through: an app that pastes opens the address here, and Android starts or wakes this
 * app's process for it even when it has been in the background, frozen or killed. Timers in
 * the app cannot promise that (Android freezes a background app's process), so they only
 * tidy up early. On a request for an expired copy, the provider deletes it, withdraws every
 * read grant for its address, and refuses.
 */
class OutgoingProvider : FileProvider() {

    private fun expired(uri: Uri): Boolean {
        val ctx = context ?: return true
        val clips = ClipboardFiles(ctx.cacheDir)
        if (!clips.isExpiredPath(uri.pathSegments)) return false
        // Delete whatever has expired (taking back its grants), and the grant for this address.
        ClipExpiry.sweep(ctx)
        try {
            ctx.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: Exception) {
            // Nothing granted, or the address is malformed; it is refused either way.
        }
        return true
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        if (expired(uri)) throw FileNotFoundException("expired")
        return super.openFile(uri, mode)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        // An expired copy has no name and no size: an empty answer.
        if (expired(uri)) return MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), 0)
        return super.query(uri, projection, selection, selectionArgs, sortOrder)
    }

    override fun getType(uri: Uri): String? {
        if (expired(uri)) return null
        return super.getType(uri)
    }

}
