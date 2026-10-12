package no.stormberry.metadatascrubber

import java.io.File
import java.util.UUID

/**
 * Where a photo taken in the app waits for the page (1.1.0): cache/camera/<uuid>/photo.jpg.
 * Plain java.io, so it is unit tested on the JVM, like [ClipboardFiles].
 *
 * The folder is private to the app and is NOT in res/xml/file_paths.xml, so the
 * FileProvider can never hand it to another app. Nothing here reaches the gallery.
 *
 *  - [newPhoto] makes a new folder and returns its photo.jpg.part; the camera screen writes
 *    the checked JPEG there, and [commit] renames it to photo.jpg. That rename is the only
 *    moment a photo becomes readable, so a half-written file is never handed over.
 *  - The camera screen hands MainActivity only the folder's UUID, never a path; [resolve]
 *    turns it back into the file and accepts nothing but a UUID naming a regular file
 *    directly inside its own folder, reached without a symbolic link.
 *  - [delete] removes that one photo's folder as soon as the page has the bytes; [clear]
 *    removes every folder at a fresh start, and [clearExcept] every folder but the photo
 *    still on its way to the page whenever the page comes back into view, so a photo left
 *    by a process that never came back does not stay on the device.
 */
class CameraFiles(cacheDir: File) {
    val root: File = File(cacheDir, DIR)

    /** A new, empty folder for one photo; returns the .part file to write into it. */
    fun newPhoto(): File {
        val dir = File(root, UUID.randomUUID().toString())
        check(dir.mkdirs()) { "could not create $dir" }
        return File(dir, PART_NAME)
    }

    /**
     * Renames a finished [part] from [newPhoto] to photo.jpg and returns the photo's UUID,
     * or null (with the folder deleted) when it is not one of ours or the rename fails.
     */
    fun commit(part: File): String? {
        val dir = part.parentFile
        val id = dir?.name
        if (part.name != PART_NAME || id == null || !UUID_PATTERN.matches(id) || !isOwnFolder(dir)) {
            deleteFolder(dir)
            return null
        }
        val target = File(dir, NAME)
        if (!part.isFile || !part.renameTo(target)) {
            deleteFolder(dir)
            return null
        }
        return id
    }

    /** The photo named by [id], or null unless it is a finished photo of ours. */
    fun resolve(id: String?): File? {
        if (id == null || !UUID_PATTERN.matches(id)) return null
        val canonicalRoot = root.canonicalFile
        val expected = File(File(canonicalRoot, id), NAME)
        // A symbolic link anywhere below the root makes the canonical path differ.
        if (expected.canonicalFile != expected) return null
        return expected.takeIf { it.isFile }
    }

    /** The UUID of a photo returned by [resolve], or null. */
    fun idOf(file: File): String? = file.parentFile?.name?.takeIf { resolve(it)?.canonicalFile == file.canonicalFile }

    /**
     * Deletes [file] and its own folder, and nothing else. Returns false when the file is
     * not inside a photo folder of ours, in which case nothing is touched.
     */
    fun delete(file: File): Boolean {
        val dir = file.parentFile ?: return false
        if (!isOwnFolder(dir)) return false
        return dir.deleteRecursively()
    }

    /** Deletes every photo folder, finished or not. Returns how many folders were removed. */
    fun clear(): Int = clearExcept(emptySet())

    /**
     * Deletes every photo folder, finished or not, except those named by [keep] (the photo
     * waiting for the page, one still being checked). Returns how many were removed.
     */
    fun clearExcept(keep: Set<String>): Int {
        var n = 0
        root.listFiles()?.forEach { if (it.name !in keep && it.deleteRecursively()) n++ }
        return n
    }

    /** A direct child of the root, named by a UUID, not a symbolic link. */
    private fun isOwnFolder(dir: File): Boolean {
        val canonicalRoot = root.canonicalFile
        val expected = File(canonicalRoot, dir.name)
        return UUID_PATTERN.matches(dir.name) && dir.canonicalFile == expected && expected.canonicalFile == expected
    }

    private fun deleteFolder(dir: File?) {
        if (dir != null && isOwnFolder(dir)) dir.deleteRecursively()
    }

    companion object {
        /** Deliberately NOT a cache-path in res/xml/file_paths.xml. */
        const val DIR = "camera"
        const val NAME = "photo.jpg"
        const val PART_NAME = "photo.jpg.part"
        private val UUID_PATTERN = Regex("""[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}""")
    }
}
