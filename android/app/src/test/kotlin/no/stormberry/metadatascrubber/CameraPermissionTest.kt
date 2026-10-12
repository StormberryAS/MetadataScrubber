package no.stormberry.metadatascrubber

import no.stormberry.metadatascrubber.CameraPermission.Next
import org.junit.Assert.assertEquals
import org.junit.Test

/** The CAMERA permission: asked on a tap while it is missing, after the app's own explanation. */
class CameraPermissionTest {
    @Test fun aTapOpensTheCameraWhenAllowedAndExplainsFirstWhenNot() {
        assertEquals(Next.OPEN, CameraPermission.afterTap(granted = true))
        assertEquals(Next.RATIONALE, CameraPermission.afterTap(granted = false))
    }

    @Test fun allowedInAndroidsPromptOpensTheCamera() {
        assertEquals(Next.OPEN, CameraPermission.afterRequest(granted = true, rationale = false))
        assertEquals(Next.OPEN, CameraPermission.afterRequest(granted = true, rationale = true))
    }

    @Test fun aFirstRefusalClosesQuietly() {
        assertEquals(Next.CLOSE, CameraPermission.afterRequest(granted = false, rationale = true))
    }

    @Test fun aRefusalForGoodPointsToTheSettings() {
        // "Don't ask again", a second refusal, or an instant refusal with no prompt shown.
        assertEquals(Next.DENIED, CameraPermission.afterRequest(granted = false, rationale = false))
    }

    @Test fun backFromTheSettings() {
        assertEquals(Next.OPEN, CameraPermission.afterSettings(granted = true))
        assertEquals(Next.DENIED, CameraPermission.afterSettings(granted = false))
    }

    @Test fun everyStateIsReachable() {
        val all = setOf(
            CameraPermission.afterTap(true), CameraPermission.afterTap(false),
            CameraPermission.afterRequest(false, true), CameraPermission.afterRequest(false, false),
        )
        assertEquals(Next.entries.toSet(), all)
    }
}
