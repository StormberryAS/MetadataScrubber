package no.stormberry.metadatascrubber

/**
 * Which shared URIs the app will read. Pure Kotlin, unit tested.
 *
 * Only content: URIs are read. A file: URI in a share intent is the classic way to trick an
 * app into reading its OWN private files and handing them to whoever sent the intent, so
 * it is refused outright. A content: URI from this app's own FileProvider is refused for
 * the same reason.
 */
object IncomingPolicy {
    /** The most pictures taken from one share. The page handles a batch; this is a sanity cap. */
    const val MAX_FILES = 50

    /** Largest single file read from a share, in bytes. Far above any real photo. */
    const val MAX_BYTES: Long = 512L * 1024 * 1024

    fun accept(scheme: String?, authority: String?, ownAuthorities: Set<String>): Boolean {
        if (scheme?.lowercase() != "content") return false
        val a = authority?.lowercase()
        if (a.isNullOrEmpty()) return false
        return ownAuthorities.none { it.equals(a, ignoreCase = true) }
    }
}
