package no.stormberry.metadatascrubber

/**
 * Makes a file name safe to write into the share cache and to offer to the system "save"
 * screen. The page already names results like `image.minimal.jpg`, but the name part is
 * typed by the user, so it is treated as untrusted here: no path separators, no control
 * characters, no names that mean "this folder", and an extension that matches the bytes.
 */
object FileNames {
    /** Longest name kept, in characters. Well under the 255-byte limit of common filesystems. */
    const val MAX_LENGTH = 120

    private const val FALLBACK_STEM = "image"

    // Reserved on Windows or FAT (which SD cards and USB sticks use), or a path separator.
    private val RESERVED = Regex("""[\\/:*?"<>|]""")
    // C0 and C1 controls, zero-width characters and every bidirectional override or
    // isolate, which can make "gpj.exe" display as "exe.jpg". Written as code points so
    // the source itself stays plain ASCII.
    private val CONTROL_RANGES = listOf(
        0x0000..0x001F, 0x007F..0x009F, 0x200B..0x200F, 0x202A..0x202E, 0x2066..0x2069, 0xFEFF..0xFEFF,
    )

    private fun isControl(c: Char): Boolean = CONTROL_RANGES.any { c.code in it }
    private val SPACES = Regex("""\s+""")

    /**
     * Returns a safe name for a file of type [mime]. The extension always matches [mime]: a
     * name without one gets it, and a name ending in a different picture extension has the
     * right one appended rather than silently mislabelling the bytes.
     */
    fun sanitise(name: String?, mime: String): String {
        val ext = ImageTypes.extensionFor(mime) ?: throw IllegalArgumentException("unsupported type $mime")
        var n = (name ?: "")
        // Keep only the last path segment, whichever separator was used.
        n = n.substringAfterLast('/').substringAfterLast('\\')
        n = n.filterNot(::isControl)
        n = RESERVED.replace(n, "_")
        n = SPACES.replace(n, " ").trim()
        // Leading dots would hide the file; trailing dots and spaces are dropped by Windows.
        n = n.trimStart('.', ' ').trimEnd('.', ' ')

        var stem: String
        val dot = n.lastIndexOf('.')
        val currentExt = if (dot > 0) n.substring(dot + 1) else ""
        stem = if (currentExt.isNotEmpty() && ImageTypes.extensionMatches(currentExt, mime)) n.substring(0, dot) else n
        val finalExt = if (currentExt.isNotEmpty() && ImageTypes.extensionMatches(currentExt, mime)) currentExt.lowercase() else ext

        stem = stem.trimEnd('.', ' ')
        if (stem.isEmpty()) stem = FALLBACK_STEM
        val room = MAX_LENGTH - finalExt.length - 1
        if (stem.length > room) stem = truncate(stem, room).trimEnd('.', ' ').ifEmpty { FALLBACK_STEM }
        return "$stem.$finalExt"
    }

    /** Cuts to [max] characters without splitting a surrogate pair. */
    private fun truncate(s: String, max: Int): String {
        if (s.length <= max) return s
        var end = max
        if (end > 0 && end < s.length && Character.isHighSurrogate(s[end - 1])) end -= 1
        return s.substring(0, end)
    }

    /**
     * A display name for a picture shared INTO the app. Only shown by the page; it never
     * becomes an output name, because the page names results itself.
     */
    fun incomingDisplayName(name: String?, mime: String, index: Int): String {
        val ext = ImageTypes.extensionFor(mime) ?: "bin"
        val base = name?.substringAfterLast('/')?.substringAfterLast('\\')?.filterNot(::isControl)?.trim()
        return if (base.isNullOrEmpty()) "shared-${index + 1}.$ext" else truncate(base, 200)
    }
}
