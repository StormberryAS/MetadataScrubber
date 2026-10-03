package no.stormberry.metadatascrubber

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IncomingPolicyTest {
    private val own = setOf("no.stormberry.metadatascrubber.outgoing")

    @Test fun contentUrisFromOtherAppsAreRead() {
        assertTrue(IncomingPolicy.accept("content", "media", own))
        assertTrue(IncomingPolicy.accept("content", "com.google.android.apps.photos.contentprovider", own))
    }

    @Test fun fileUrisAreNeverRead() {
        assertFalse(IncomingPolicy.accept("file", "", own))
        assertFalse(IncomingPolicy.accept("FILE", null, own))
    }

    @Test fun ourOwnProviderIsRefused() {
        assertFalse(IncomingPolicy.accept("content", "no.stormberry.metadatascrubber.outgoing", own))
        assertFalse(IncomingPolicy.accept("content", "NO.STORMBERRY.METADATASCRUBBER.OUTGOING", own))
    }

    @Test fun anythingElseIsRefused() {
        assertFalse(IncomingPolicy.accept("http", "example.com", own))
        assertFalse(IncomingPolicy.accept(null, null, own))
        assertFalse(IncomingPolicy.accept("content", "", own))
    }
}
