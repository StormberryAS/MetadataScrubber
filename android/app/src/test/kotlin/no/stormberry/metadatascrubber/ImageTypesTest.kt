package no.stormberry.metadatascrubber

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageTypesTest {
    @Test fun mimeToExtension() {
        assertEquals("jpg", ImageTypes.extensionFor("image/jpeg"))
        assertEquals("png", ImageTypes.extensionFor("image/png"))
        assertEquals("webp", ImageTypes.extensionFor("image/webp"))
        assertEquals("heic", ImageTypes.extensionFor("image/heic"))
        assertEquals("heif", ImageTypes.extensionFor("image/heif"))
        assertEquals("jpg", ImageTypes.extensionFor("IMAGE/JPEG; charset=binary"))
        assertEquals("jpg", ImageTypes.extensionFor("image/jpg"))
        assertNull(ImageTypes.extensionFor("image/gif"))
        assertNull(ImageTypes.extensionFor("application/octet-stream"))
        assertNull(ImageTypes.extensionFor(null))
        assertNull(ImageTypes.extensionFor(""))
    }

    @Test fun theFiveTypesMatchThePage() {
        assertEquals(listOf("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"), ImageTypes.MIME_TYPES)
    }

    @Test fun nameToMime() {
        assertEquals("image/jpeg", ImageTypes.mimeForName("a.JPG"))
        assertEquals("image/jpeg", ImageTypes.mimeForName("a.jpe"))
        assertEquals("image/heif", ImageTypes.mimeForName("a.heif"))
        assertNull(ImageTypes.mimeForName("a.gif"))
        assertNull(ImageTypes.mimeForName("jpg"))
        assertNull(ImageTypes.mimeForName(null))
    }

    @Test fun incomingTypeComesFromTheProviderThenTheName() {
        assertEquals("image/png", ImageTypes.resolveIncoming("image/png", "a.jpg"))
        assertEquals("image/jpeg", ImageTypes.resolveIncoming("application/octet-stream", "a.jpeg"))
        assertEquals("image/heic", ImageTypes.resolveIncoming(null, "IMG_1.HEIC"))
        assertNull(ImageTypes.resolveIncoming("image/gif", "a.gif"))
        assertNull(ImageTypes.resolveIncoming("video/mp4", null))
    }

    @Test fun extensionMatching() {
        assertTrue(ImageTypes.extensionMatches("jpeg", "image/jpeg"))
        assertTrue(ImageTypes.extensionMatches("HEIF", "image/heic"))
        assertFalse(ImageTypes.extensionMatches("png", "image/jpeg"))
    }
}
