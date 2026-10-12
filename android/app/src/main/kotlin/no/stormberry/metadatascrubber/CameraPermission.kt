package no.stormberry.metadatascrubber

/**
 * What the camera screen shows next about the CAMERA permission (1.1.0). Pure Kotlin, unit
 * tested on the JVM.
 *
 * The permission is asked for only when the user taps Take a photo, and always after the
 * app's own explanation, never on its own. Nothing is stored: the explanation shows
 * whenever the permission is missing, so the decision rests on what Android says now.
 *
 *  - [afterTap]: the permission is there, so the camera opens; otherwise the explanation.
 *  - [afterRequest]: after Android's prompt. Granted, the camera opens. Refused while
 *    Android would still ask again (shouldShowRequestPermissionRationale is true, a first
 *    refusal), the screen closes quietly and the page is as it was. Refused for good (no
 *    prompt shown at all, or "don't ask again"), the screen says the access is off and
 *    offers the app's settings.
 *  - [afterSettings]: back from the settings, the camera opens if it was allowed there;
 *    otherwise that screen stays.
 */
object CameraPermission {
    enum class Next { OPEN, RATIONALE, DENIED, CLOSE }

    fun afterTap(granted: Boolean): Next = if (granted) Next.OPEN else Next.RATIONALE

    fun afterRequest(granted: Boolean, rationale: Boolean): Next = when {
        granted -> Next.OPEN
        rationale -> Next.CLOSE
        else -> Next.DENIED
    }

    fun afterSettings(granted: Boolean): Next = if (granted) Next.OPEN else Next.DENIED
}
