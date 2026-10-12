package no.stormberry.metadatascrubber

import java.io.File
import java.util.UUID

/**
 * The share cache: cache/outgoing/<random>/<name>. Each new file gets its own random
 * folder, so the receiving app sees the real file name and two results with the same name
 * never overwrite each other. Plain java.io, so it is unit tested on the JVM.
 *
 * A saved file's own folder is removed after the save, and so is the folder of a save that
 * was cancelled or failed (1.1.0), so finished pictures do not pile up on the device.
 *
 * A shared file (1.1.0) moves, just before the share sheet opens, to a folder named for the
 * moment it was shared, cache/outgoing/<millis>-<random>/<name>, like a copied picture's
 * (ClipboardFiles). The app it goes to can read it for [SHARE_LIFETIME_MS], then it is
 * deleted ([sweepShared]): the folder name is the record of when it was shared, so the age
 * survives the app being killed. OutgoingProvider serves nothing here but a shared file
 * within its time ([isRefusedPath]). Everything else in the folder goes at a fresh start
 * ([clearExceptLiveShares]).
 */
class OutgoingFiles(cacheDir: File, private val clock: () -> Long = System::currentTimeMillis) {
    val root: File = File(cacheDir, DIR)

    /** A new, empty file for [safeName], which must already be sanitised. */
    fun newFile(safeName: String): File {
        require(safeName.isNotEmpty() && !safeName.contains('/') && !safeName.contains('\\') &&
            safeName != "." && safeName != "..") { "unsafe name" }
        val dir = File(root, UUID.randomUUID().toString())
        check(dir.mkdirs()) { "could not create $dir" }
        return File(dir, safeName)
    }

    /** True when [file] is inside the share cache, so it is ours to read or hand out. */
    fun owns(file: File): Boolean {
        val r = root.canonicalFile
        var f: File? = file.canonicalFile.parentFile
        while (f != null) {
            if (f == r) return true
            f = f.parentFile
        }
        return false
    }

    /**
     * Deletes [file] and its own random folder, and nothing else. Returns false when the
     * file is not one of ours, in which case nothing is touched.
     */
    fun delete(file: File): Boolean {
        if (!owns(file)) return false
        val dir = file.canonicalFile.parentFile ?: return false
        // Only a direct child of the root is a per-file folder; never remove the root itself.
        if (dir.parentFile != root.canonicalFile) return false
        return dir.deleteRecursively()
    }

    /** Deletes everything in the share cache. Returns how many files were removed. */
    fun clear(): Int {
        var n = 0
        root.listFiles()?.forEach { child ->
            child.walkBottomUp().forEach { if (it.isFile) n++; it.delete() }
        }
        return n
    }

    /**
     * Moves [file], a finished result in its own folder here, to a new folder named for now
     * and returns the moved file; its share time starts then. Throws when the move fails, and
     * [file] then stays where it was, for the caller to delete.
     */
    fun markShared(file: File): File {
        require(owns(file) && file.isFile) { "not a finished result of ours" }
        val dir = File(root, "${clock()}-${UUID.randomUUID()}")
        check(dir.mkdirs()) { "could not create $dir" }
        val target = File(dir, file.name)
        if (!file.renameTo(target)) {
            dir.delete()
            throw IllegalStateException("could not move the shared file")
        }
        file.parentFile?.delete()
        return target
    }

    /**
     * The one rule for a shared file's folder: past its [SHARE_LIFETIME_MS], or dated more
     * than [FUTURE_TOLERANCE_MS] ahead of the clock (the clock was set back, so the age
     * cannot be trusted). False for a folder that is not a shared file's.
     */
    fun isShareExpired(dirName: String?, now: Long = clock()): Boolean {
        val sharedAt = sharedAt(dirName) ?: return false
        val age = now - sharedAt
        return age >= SHARE_LIFETIME_MS || age < -FUTURE_TOLERANCE_MS
    }

    /** Deletes every shared file past its time. Returns the files deleted, for their grants. */
    fun sweepShared(now: Long = clock()): List<File> {
        val gone = mutableListOf<File>()
        root.listFiles()?.forEach { dir ->
            if (isShareExpired(dir.name, now)) {
                gone += dir.listFiles()?.toList().orEmpty()
                dir.deleteRecursively()
            }
        }
        return gone
    }

    /** Milliseconds until the next shared file ends, or null when none is live. */
    fun nextShareEndMs(now: Long = clock()): Long? =
        root.listFiles()
            ?.mapNotNull { dir -> sharedAt(dir.name)?.takeIf { !isShareExpired(dir.name, now) } }
            ?.minOrNull()
            ?.let { (it + SHARE_LIFETIME_MS - now).coerceIn(0, SHARE_LIFETIME_MS) }

    /**
     * For the FileProvider: [segments] are the path segments of a content address, for
     * example [outgoing, 1759700000000-<uuid>, image.public.jpg]. True for anything under
     * outgoing/ that is not a shared file within its time: a file waiting for its save screen
     * or still arriving is never handed out, and a shared file past its time is gone. False
     * for addresses outside outgoing/, which this rule does not govern.
     */
    fun isRefusedPath(segments: List<String>, now: Long = clock()): Boolean {
        if (segments.firstOrNull() != PATH_NAME) return false
        if (segments.size != 3 || sharedAt(segments[1]) == null) return true
        return isShareExpired(segments[1], now)
    }

    /**
     * Deletes everything but the shared files still within their time, which the apps they
     * went to may not have read yet. Returns how many files were removed.
     */
    fun clearExceptLiveShares(now: Long = clock()): Int {
        var n = 0
        root.listFiles()?.forEach { child ->
            if (sharedAt(child.name) != null && !isShareExpired(child.name, now)) return@forEach
            child.walkBottomUp().forEach { if (it.isFile) n++; it.delete() }
        }
        return n
    }

    private fun sharedAt(dirName: String?): Long? {
        val m = SHARED_PATTERN.matchEntire(dirName ?: return null) ?: return null
        return m.groupValues[1].toLongOrNull()
    }

    companion object {
        /** Must match the cache-path in res/xml/file_paths.xml. */
        const val DIR = "outgoing"

        /** The name the FileProvider gives that cache-path (its first path segment). */
        const val PATH_NAME = "outgoing"

        /** How long the app a file was shared with can read it (1.1.0). */
        const val SHARE_LIFETIME_MS = 10 * 60 * 1000L
        const val FUTURE_TOLERANCE_MS = 5_000L
        private val SHARED_PATTERN = Regex("""(\d{1,15})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}""")
    }
}
