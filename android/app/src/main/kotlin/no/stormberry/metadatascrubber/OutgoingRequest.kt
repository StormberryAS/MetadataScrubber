package no.stormberry.metadatascrubber

/**
 * Checks what the page asks the app to do with a finished file, before a single byte is
 * accepted. Pure Kotlin, unit tested on the JVM.
 *
 * The page sends one "out-begin" message per file: what to do with it (save, share or
 * copy), its name, its MIME type, its size and the number of chunks that follow. All of it
 * comes from JavaScript, so all of it is treated as untrusted:
 *  - the action is one of three exact words, nothing else;
 *  - the type is one of the five picture types the app handles, and a copy is a PNG only
 *    (the page draws a fresh PNG for the clipboard, without the file's details);
 *  - the size is above zero and at most [MAX_BYTES], and the chunk count is exactly the
 *    one that size gives at [ChunkAssembler.CHUNK_BYTES] per chunk;
 *  - the name is cut to a safe file name with the right extension (see [FileNames]); a
 *    copy is always called image.png, whatever the page says.
 * There is no field for an address or a path: the app writes the bytes into its own
 * cache/outgoing/ folder and hands out only that file.
 */
object OutgoingRequest {
    enum class Action(val wire: String) { SAVE("save"), SHARE("share"), COPY("copy") }

    /** A request that passed every check. [name] is already safe to use as a file name. */
    data class Valid(val action: Action, val name: String, val mime: String, val size: Long, val chunks: Int)

    /** Same ceiling as the chunk reassembly; a 30 MB photo, or its PNG copy, is far inside it. */
    const val MAX_BYTES: Long = ChunkAssembler.DEFAULT_MAX_BYTES

    /** Longest name the page may send, before it is cut to [FileNames.MAX_LENGTH]. */
    const val MAX_NAME_INPUT = 1024

    const val COPY_NAME = "image.png"
    const val COPY_MIME = "image/png"

    fun parse(action: String?, name: String?, mime: String?, size: Long, chunks: Int): Valid? {
        val a = Action.entries.firstOrNull { it.wire == action } ?: return null
        val m = ImageTypes.normalise(mime) ?: return null
        if (!ImageTypes.isSupported(m)) return null
        if (a == Action.COPY && m != COPY_MIME) return null
        if (size <= 0 || size > MAX_BYTES) return null
        if (chunks.toLong() != chunksFor(size)) return null
        if (name != null && name.length > MAX_NAME_INPUT) return null
        val safe = if (a == Action.COPY) COPY_NAME else FileNames.sanitise(name, m)
        return Valid(a, safe, m, size, chunks)
    }

    fun chunksFor(size: Long): Long = (size + ChunkAssembler.CHUNK_BYTES - 1) / ChunkAssembler.CHUNK_BYTES
}
