package no.stormberry.metadatascrubber

import no.stormberry.metadatascrubber.OutgoingRequest.Action
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** The checks on what the page asks the app to do with a finished file (Save, Share, Copy). */
class OutgoingRequestTest {
    private val chunk = ChunkAssembler.CHUNK_BYTES.toLong()

    private fun parse(action: String? = "save", name: String? = "image.public.jpg", mime: String? = "image/jpeg", size: Long = 1000, chunks: Int = 1) =
        OutgoingRequest.parse(action, name, mime, size, chunks)

    @Test fun theThreeActionsPass() {
        assertEquals(Action.SAVE, parse("save")!!.action)
        assertEquals(Action.SHARE, parse("share")!!.action)
        assertEquals(Action.COPY, parse("copy", mime = "image/png")!!.action)
    }

    @Test fun anyOtherActionIsRefused() {
        for (a in listOf(null, "", "Save", "SHARE", "open", "view", "save ", "copy\u0000", "https://example.com", "file:///sdcard/x.jpg")) {
            assertNull("action '$a'", parse(a))
        }
    }

    @Test fun onlyTheFivePictureTypesPass() {
        for (m in listOf("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "Image/JPEG; q=1", "image/jpg")) {
            assertNotNull("mime $m", parse(mime = m))
        }
        for (m in listOf(null, "", "text/html", "application/octet-stream", "image/svg+xml", "image/gif", "application/vnd.android.package-archive", "text/javascript")) {
            assertNull("mime $m", parse(mime = m))
        }
    }

    @Test fun copyIsAPngOnly() {
        assertNotNull(parse("copy", mime = "image/png"))
        for (m in listOf("image/jpeg", "image/webp", "image/heic", "image/heif")) assertNull("copy $m", parse("copy", mime = m))
    }

    @Test fun copyIsAlwaysCalledImagePng() {
        assertEquals("image.png", parse("copy", name = "../../databases/x.db", mime = "image/png")!!.name)
        assertEquals("image.png", parse("copy", name = null, mime = "image/png")!!.name)
    }

    @Test fun namesAreMadeSafeAndCannotBePaths() {
        assertEquals("image.public.jpg", parse(name = "image.public.jpg")!!.name)
        assertEquals("x.db.jpg", parse(name = "../../databases/x.db")!!.name)
        assertEquals("passwd.jpg", parse(name = "/etc/passwd")!!.name)
        assertEquals("holiday.public.png", parse("share", name = "holiday.public.png", mime = "image/png")!!.name)
        assertEquals("image.jpg", parse(name = null)!!.name)
        assertNull("a very long name is refused", parse(name = "a".repeat(OutgoingRequest.MAX_NAME_INPUT + 1)))
        assertEquals(FileNames.MAX_LENGTH, parse(name = "a".repeat(OutgoingRequest.MAX_NAME_INPUT))!!.name.length)
    }

    @Test fun sizeMustBePositiveAndWithinTheCeiling() {
        assertNull(parse(size = 0, chunks = 0))
        assertNull(parse(size = -1, chunks = 1))
        val max = OutgoingRequest.MAX_BYTES
        assertNotNull(parse(size = max, chunks = ((max + chunk - 1) / chunk).toInt()))
        assertNull(parse(size = max + 1, chunks = ((max + chunk) / chunk).toInt()))
        assertNull(parse(size = Long.MAX_VALUE, chunks = Int.MAX_VALUE))
    }

    @Test fun chunkCountMustMatchTheSizeExactly() {
        assertNotNull(parse(size = chunk, chunks = 1))
        assertNotNull(parse(size = chunk + 1, chunks = 2))
        assertNull(parse(size = chunk + 1, chunks = 1))
        assertNull(parse(size = chunk + 1, chunks = 3))
        assertNull(parse(size = 10, chunks = 0))
        assertNull(parse(size = 10, chunks = -1))
        assertNull(parse(size = 30_000_000, chunks = 10))
        assertNotNull(parse(size = 30_000_000, chunks = OutgoingRequest.chunksFor(30_000_000).toInt()))
    }
}
