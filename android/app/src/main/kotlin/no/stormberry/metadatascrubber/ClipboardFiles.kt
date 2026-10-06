package no.stormberry.metadatascrubber

import java.io.File
import java.util.UUID

/**
 * The copied picture's 2-minute life (1.0.1; Marcos, 2026-10-06: "do the 2 minutes limit on
 * the app, including the message"). Plain java.io, so it is unit tested on the JVM.
 *
 * A copied PNG lives in cache/clipboard/<millis>-<random>/image.png, where <millis> is the
 * wall-clock time of the Copy. The folder name is the record of when it was copied, so the
 * age survives the app being killed, and nothing else has to be stored.
 *
 *  - [adopt] moves a finished PNG in and deletes every older copy at once: a newer Copy
 *    replaces the previous one and starts its own 2 minutes.
 *  - [isExpired] is the single rule: expired once [LIFETIME_MS] have passed, and also when
 *    the time in the name is more than [FUTURE_TOLERANCE_MS] ahead of the clock (the clock
 *    was set back, so the age cannot be trusted) or the name cannot be read.
 *  - [sweep] deletes every expired copy; the app runs it at start, when it comes back, when
 *    it goes to the background, on memory pressure and when its own timer fires.
 *  - [isExpiredPath] answers the FileProvider (OutgoingProvider) for an address it is asked
 *    to open, so an expired copy can never be read, whatever happened to the timer.
 */
class ClipboardFiles(cacheDir: File, private val clock: () -> Long = System::currentTimeMillis) {
    val root: File = File(cacheDir, DIR)

    /**
     * Moves [png] (a checked PNG in the share cache) to a new copy folder named for now,
     * after deleting every older copy. Returns the new file. Throws when the move fails;
     * [png] is then left where it was for the caller to delete.
     */
    fun adopt(png: File): File {
        clear()
        val dir = File(root, "${clock()}-${UUID.randomUUID()}")
        check(dir.mkdirs()) { "could not create $dir" }
        val target = File(dir, NAME)
        if (!png.renameTo(target)) {
            dir.delete()
            throw IllegalStateException("could not move the copy")
        }
        png.parentFile?.delete()
        return target
    }

    /** Milliseconds this copy has left, 0 when it has expired. */
    fun remainingMs(file: File, now: Long = clock()): Long {
        val copiedAt = copiedAt(file.parentFile?.name) ?: return 0
        if (isExpired(file.parentFile!!.name, now)) return 0
        return (copiedAt + LIFETIME_MS - now).coerceIn(0, LIFETIME_MS)
    }

    /** The one rule. A name that does not parse counts as expired. */
    fun isExpired(dirName: String?, now: Long = clock()): Boolean {
        val copiedAt = copiedAt(dirName) ?: return true
        val age = now - copiedAt
        return age >= LIFETIME_MS || age < -FUTURE_TOLERANCE_MS
    }

    /**
     * For the FileProvider: [segments] are the path segments of a content address, for
     * example [clipboard, 1759700000000-<uuid>, image.png]. True when the address is a copy
     * that has expired (or is not a well-formed copy address); false for anything that is
     * not under clipboard/, which this rule does not govern.
     */
    fun isExpiredPath(segments: List<String>, now: Long = clock()): Boolean {
        if (segments.firstOrNull() != PATH_NAME) return false
        if (segments.size != 3 || segments[2] != NAME) return true
        return isExpired(segments[1], now)
    }

    /** Deletes every expired copy folder. Returns the folders removed. */
    fun sweep(now: Long = clock()): List<File> {
        val gone = mutableListOf<File>()
        root.listFiles()?.forEach { dir ->
            if (!dir.isDirectory || isExpired(dir.name, now)) {
                dir.deleteRecursively()
                gone += dir
            }
        }
        return gone
    }

    /** The live copy, if any: the newest folder that has not expired. */
    fun current(now: Long = clock()): File? =
        root.listFiles()
            ?.filter { it.isDirectory && !isExpired(it.name, now) }
            ?.maxByOrNull { copiedAt(it.name) ?: Long.MIN_VALUE }
            ?.let { File(it, NAME) }
            ?.takeIf { it.isFile }

    /**
     * True when [file], a copy the page was told about, can no longer be pasted: deleted (by
     * the timer, the alarm, the provider or a newer Copy) or past its 2 minutes. False for null.
     */
    fun hasEnded(file: File?, now: Long = clock()): Boolean =
        file != null && (!file.isFile || isExpired(file.parentFile?.name, now))

    /** Deletes every copy, live or not. */
    fun clear() {
        root.listFiles()?.forEach { it.deleteRecursively() }
    }

    private fun copiedAt(dirName: String?): Long? {
        val m = NAME_PATTERN.matchEntire(dirName ?: return null) ?: return null
        return m.groupValues[1].toLongOrNull()
    }

    companion object {
        /** Must match the cache-path in res/xml/file_paths.xml. */
        const val DIR = "clipboard"

        /** The name the FileProvider gives that cache-path (its first path segment). */
        const val PATH_NAME = "clipboard"
        const val NAME = "image.png"
        const val LIFETIME_MS = 2 * 60 * 1000L
        const val FUTURE_TOLERANCE_MS = 5_000L
        private val NAME_PATTERN = Regex("""(\d{1,15})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}""")
    }
}
