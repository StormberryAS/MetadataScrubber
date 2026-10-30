package no.stormberry.metadatascrubber

import java.io.InputStream
import java.io.OutputStream

/**
 * Writes the new file into the document Android's save screen returned, and tidies up after a
 * failure without ever deleting a file MetadataScrubber did not write (1.1.1, ported from
 * CheckLink's SaveTarget). Pure Kotlin over [Document], unit tested with a stand-in.
 *
 *  - A storage app that refuses "wt" (write and truncate) gets plain "w", which some storage
 *    apps do not truncate. Saving over an older, longer file could then leave that file's end,
 *    with its own metadata (the video of a Motion Photo, say), after the clean picture. So after
 *    a plain "w" the document's size must equal the picture's length: a size that differs fails
 *    the save, and the mixed file is deleted. (Android's own storage accepts "wt".)
 *  - The picture's length is read before the copy, and every byte of it must be copied: a picture
 *    that ends early fails the save, so a shortened file is never kept as a finished one.
 *  - The save screen can return an existing file that the person chose to replace. Such a file
 *    is deleted after a failure only once MetadataScrubber has opened it for writing, when its
 *    old content is gone anyway. Before that (the waiting file gone after Android stopped the
 *    app, or unreadable) only an empty document is removed, normally the one the save screen has
 *    just made (a 0-byte file the person chose holds nothing to lose). A document of unknown or
 *    non-zero size is left exactly as it was.
 *  - A document whose size the storage app does not give (a stream with no file behind it) is
 *    taken as written: such a stream is the document's whole new content.
 */
object SaveTarget {
    interface Document {
        /** A stream that writes the document in [mode] ("wt" or "w"); null or an exception when refused. */
        fun open(mode: String): OutputStream?

        /** The document's size in bytes, or null when the storage app does not say. */
        fun size(): Long?

        /** Deletes the document, best effort. */
        fun delete()
    }

    /** The clean file: its [length] in bytes, read before the copy, and how to [open] it. */
    class Picture(val length: Long, val open: () -> InputStream)

    /**
     * Writes [picture] into [doc], or only tidies up when [picture] is null or cannot be opened
     * (nothing may be written). The picture is opened before the document, so a file that is gone
     * never costs the person the file they chose to replace. True only when all [Picture.length]
     * bytes were written and, after a plain "w", the document reports that size or none.
     */
    fun save(doc: Document, picture: Picture?): Boolean {
        val input = try {
            picture?.open?.invoke()
        } catch (_: Exception) {
            null
        }
        if (picture == null || input == null) {
            dropIfEmpty(doc)
            return false
        }
        var opened = false
        val ok = try {
            val truncated = try {
                doc.open("wt")
            } catch (_: Exception) {
                null
            }
            val out = truncated ?: doc.open("w") ?: error("no stream")
            opened = true
            val written = out.use { input.copyTo(it) }
            check(written == picture.length) { "the picture was not read whole" }
            if (truncated == null) {
                val size = doc.size()
                check(size == null || size == picture.length) { "an older file's end is left after the picture" }
            }
            true
        } catch (_: Exception) {
            false
        } finally {
            try {
                input.close()
            } catch (_: Exception) {
                // The picture was read (or not); closing it changes nothing written.
            }
        }
        if (!ok) {
            if (opened) doc.delete() else dropIfEmpty(doc)
        }
        return ok
    }

    /** Removes the document only when it is empty: one the save screen made and nothing filled. */
    private fun dropIfEmpty(doc: Document) {
        val size = try {
            doc.size()
        } catch (_: Exception) {
            null
        }
        if (size == 0L) doc.delete()
    }
}
