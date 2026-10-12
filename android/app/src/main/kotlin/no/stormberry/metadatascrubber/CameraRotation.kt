package no.stormberry.metadatascrubber

import android.view.Surface

/**
 * Which way up a photo is taken (1.1.0). Pure Kotlin, unit tested on the JVM.
 *
 * The camera screen is not locked to portrait, and auto-rotate may be off, so the screen's
 * own rotation does not say how the phone is held. An OrientationEventListener reports the
 * phone's angle in degrees (0 when held upright, growing clockwise), and this turns it into
 * the Surface rotation CameraX takes as ImageCapture.targetRotation. The camera then reports
 * how far to turn the picture, and the camera screen turns the pixels themselves, so the
 * photo is upright however the phone was held.
 */
object CameraRotation {
    /**
     * The Surface rotation for a phone held at [degrees], or null when the angle is unknown
     * (OrientationEventListener.ORIENTATION_UNKNOWN, -1, when the phone lies flat) or out
     * of range, in which case the last rotation stays. The boundaries are 45, 135, 225 and
     * 315 degrees; each boundary belongs to the quarter after it.
     */
    fun surfaceRotationFor(degrees: Int): Int? = when (degrees) {
        in 45 until 135 -> Surface.ROTATION_270
        in 135 until 225 -> Surface.ROTATION_180
        in 225 until 315 -> Surface.ROTATION_90
        in 0 until 45, in 315 until 360 -> Surface.ROTATION_0
        else -> null
    }

    /**
     * The rotation a new or rebound ImageCapture starts with: the last way the phone was
     * seen held ([sensor], from [surfaceRotationFor]), or the screen's own rotation
     * ([display]) until the phone has reported one, or on a phone that cannot report it.
     * The screen's rotation alone would be wrong for a phone resting in landscape with
     * auto-rotate off: the listener reports only changes, so a still phone may never
     * correct it before the photo.
     */
    fun captureRotation(sensor: Int?, display: Int): Int = sensor ?: display
}
