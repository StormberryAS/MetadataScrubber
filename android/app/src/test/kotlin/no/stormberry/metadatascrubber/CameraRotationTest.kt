package no.stormberry.metadatascrubber

import android.view.Surface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A photo is upright however the phone is held. */
class CameraRotationTest {
    private fun r(deg: Int) = CameraRotation.surfaceRotationFor(deg)

    @Test fun theSurfaceConstantsAreTheOnesCameraXTakes() {
        assertEquals(listOf(0, 1, 2, 3), listOf(Surface.ROTATION_0, Surface.ROTATION_90, Surface.ROTATION_180, Surface.ROTATION_270))
    }

    @Test fun uprightIsRotation0() {
        for (d in listOf(0, 1, 30, 44, 315, 330, 359)) assertEquals("$d", Surface.ROTATION_0, r(d))
    }

    @Test fun turnedClockwiseIsRotation270() {
        for (d in listOf(45, 90, 134)) assertEquals("$d", Surface.ROTATION_270, r(d))
    }

    @Test fun upsideDownIsRotation180() {
        for (d in listOf(135, 180, 224)) assertEquals("$d", Surface.ROTATION_180, r(d))
    }

    @Test fun turnedAnticlockwiseIsRotation90() {
        for (d in listOf(225, 270, 314)) assertEquals("$d", Surface.ROTATION_90, r(d))
    }

    @Test fun eachBoundaryBelongsToTheQuarterAfterIt() {
        assertEquals(Surface.ROTATION_0, r(44))
        assertEquals(Surface.ROTATION_270, r(45))
        assertEquals(Surface.ROTATION_270, r(134))
        assertEquals(Surface.ROTATION_180, r(135))
        assertEquals(Surface.ROTATION_180, r(224))
        assertEquals(Surface.ROTATION_90, r(225))
        assertEquals(Surface.ROTATION_90, r(314))
        assertEquals(Surface.ROTATION_0, r(315))
    }

    @Test fun aNewCaptureStartsFromTheWayThePhoneWasLastHeld() {
        // Auto-rotate off, phone resting in landscape: the screen still says upright, but the
        // listener saw the phone turned, and a rebind (opening, switching camera) keeps that.
        assertEquals(Surface.ROTATION_270, CameraRotation.captureRotation(Surface.ROTATION_270, Surface.ROTATION_0))
        assertEquals(Surface.ROTATION_0, CameraRotation.captureRotation(Surface.ROTATION_0, Surface.ROTATION_90))
        // No reading yet, or a phone that cannot tell how it is held: the screen's rotation.
        for (d in listOf(Surface.ROTATION_0, Surface.ROTATION_90, Surface.ROTATION_180, Surface.ROTATION_270)) {
            assertEquals("$d", d, CameraRotation.captureRotation(null, d))
        }
    }

    @Test fun anUnknownAngleKeepsTheLastRotation() {
        // OrientationEventListener.ORIENTATION_UNKNOWN, when the phone lies flat.
        assertNull(r(-1))
        assertNull(r(360))
        assertNull(r(-90))
        assertNull(r(Int.MAX_VALUE))
    }
}
