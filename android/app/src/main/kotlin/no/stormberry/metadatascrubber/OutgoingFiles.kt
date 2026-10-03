package no.stormberry.metadatascrubber

import java.io.File
import java.util.UUID

/**
 * The share cache: cache/outgoing/<random>/<name>. Each new file gets its own random
 * folder, so the receiving app sees the real file name and two results with the same name
 * never overwrite each other. Plain java.io, so it is unit tested on the JVM.
 *
 * The whole folder is emptied when the app starts fresh, and a saved file's own folder is
 * removed after the save, so finished pictures do not pile up on the device.
 */
class OutgoingFiles(cacheDir: File) {
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

    companion object {
        /** Must match the cache-path in res/xml/file_paths.xml. */
        const val DIR = "outgoing"
    }
}
