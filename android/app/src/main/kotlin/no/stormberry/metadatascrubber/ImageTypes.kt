package no.stormberry.metadatascrubber

/**
 * The five picture types the app accepts and produces, matching the web page's own list
 * (index.html, #file-input accept). Pure Kotlin, so it is unit tested on the JVM.
 */
object ImageTypes {
    /** MIME type to the extension a file of that type is saved with. */
    private val EXTENSION = linkedMapOf(
        "image/jpeg" to "jpg",
        "image/png" to "png",
        "image/webp" to "webp",
        "image/heic" to "heic",
        "image/heif" to "heif",
    )

    /** Every extension recognised on the way in, to the MIME type it implies. */
    private val FROM_EXTENSION = mapOf(
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "jpe" to "image/jpeg",
        "png" to "image/png",
        "webp" to "image/webp",
        "heic" to "image/heic",
        "heif" to "image/heif",
    )

    /** The MIME types offered to the system file picker and declared in the share filters. */
    val MIME_TYPES: List<String> = EXTENSION.keys.toList()

    /** Lower-cases and strips parameters, so "Image/JPEG; q=1" becomes "image/jpeg". */
    fun normalise(mime: String?): String? {
        val m = mime?.substringBefore(';')?.trim()?.lowercase()
        if (m.isNullOrEmpty()) return null
        // Some galleries still send the never-registered image/jpg.
        return if (m == "image/jpg" || m == "image/pjpeg") "image/jpeg" else m
    }

    fun isSupported(mime: String?): Boolean = normalise(mime) in EXTENSION

    /** The extension for a supported MIME type, or null. */
    fun extensionFor(mime: String?): String? = EXTENSION[normalise(mime)]

    /** The MIME type a file name's extension implies, or null if it is not a supported picture. */
    fun mimeForName(name: String?): String? {
        val ext = name?.substringAfterLast('.', "")?.lowercase().orEmpty()
        return FROM_EXTENSION[ext]
    }

    /**
     * The type to treat an incoming file as. The provider's MIME type wins when it is one of
     * ours; otherwise the name decides, because some file managers report every file as
     * application/octet-stream. Returns null when neither says it is a supported picture.
     */
    fun resolveIncoming(reportedMime: String?, name: String?): String? {
        val m = normalise(reportedMime)
        if (m != null && m in EXTENSION) return m
        return mimeForName(name)
    }

    /** True when [ext] (without the dot) is a recognised extension for [mime]. */
    fun extensionMatches(ext: String, mime: String): Boolean = FROM_EXTENSION[ext.lowercase()] == normalise(mime) ||
        // HEIC and HEIF are the same container; a .heic name for image/heif is fine.
        (normalise(mime) in setOf("image/heic", "image/heif") && ext.lowercase() in setOf("heic", "heif"))
}
