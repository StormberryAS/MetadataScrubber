package no.stormberry.metadatascrubber

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class OutgoingFilesTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun eachFileGetsItsOwnFolderInsideTheCache() {
        val out = OutgoingFiles(tmp.root)
        val a = out.newFile("image.public.jpg")
        val b = out.newFile("image.public.jpg")
        assertEquals("image.public.jpg", a.name)
        assertNotEquals(a.parentFile, b.parentFile)
        assertEquals(File(tmp.root, "outgoing").canonicalFile, a.parentFile!!.parentFile!!.canonicalFile)
        assertTrue(out.owns(a))
        assertFalse(out.owns(File(tmp.root, "elsewhere.jpg")))
        assertFalse(out.owns(File(out.root, "../escape.jpg")))
    }

    @Test fun clearRemovesEverything() {
        val out = OutgoingFiles(tmp.root)
        out.newFile("a.jpg").writeBytes(byteArrayOf(1))
        out.newFile("b.png").writeBytes(byteArrayOf(2))
        assertEquals(2, out.clear())
        assertEquals(0, out.root.listFiles()!!.size)
        assertEquals(0, out.clear())
    }

    @Test fun deleteRemovesOnlyThatFilesFolder() {
        val out = OutgoingFiles(tmp.root)
        val saved = out.newFile("a.jpg").apply { writeBytes(byteArrayOf(1)) }
        val stillArriving = out.newFile("b.png").apply { writeBytes(byteArrayOf(2)) }
        assertTrue(out.delete(saved))
        assertFalse(saved.exists())
        assertFalse(saved.parentFile!!.exists())
        assertTrue(stillArriving.isFile)
        assertTrue(out.root.isDirectory)
        assertEquals(1, out.root.listFiles()!!.size)
    }

    @Test fun deleteLeavesFilesThatAreNotOursAlone() {
        val out = OutgoingFiles(tmp.root)
        out.newFile("a.jpg").writeBytes(byteArrayOf(1))
        val outside = File(tmp.root, "keep/me.jpg").apply { parentFile!!.mkdirs(); writeBytes(byteArrayOf(3)) }
        assertFalse(out.delete(outside))
        assertTrue(outside.isFile)
        // A file sitting directly in the root has no folder of its own; the root must stay.
        val loose = File(out.root, "loose.jpg").apply { writeBytes(byteArrayOf(4)) }
        assertFalse(out.delete(loose))
        assertTrue(out.root.isDirectory)
        assertTrue(loose.isFile)
    }

    @Test(expected = IllegalArgumentException::class)
    fun unsafeNamesAreRefused() {
        OutgoingFiles(tmp.root).newFile("../x.jpg")
    }

    // ---- a shared file's 10 minutes (1.1.0)

    private var now = 1_759_700_000_000L
    private val min10 = OutgoingFiles.SHARE_LIFETIME_MS

    private fun timed() = OutgoingFiles(tmp.root) { now }

    private fun result(out: OutgoingFiles, name: String = "image.clean.jpg") =
        out.newFile(name).apply { writeBytes(byteArrayOf(-1, -40, -1, -39)) }

    @Test fun theShareLifetimeIsTenMinutes() {
        assertEquals(600_000L, OutgoingFiles.SHARE_LIFETIME_MS)
    }

    @Test fun markSharedMovesTheFileIntoAFolderNamedForNow() {
        val out = timed()
        val f = result(out)
        val oldDir = f.parentFile!!
        val shared = out.markShared(f)
        assertEquals("image.clean.jpg", shared.name)
        assertTrue(shared.isFile)
        assertFalse(f.exists())
        assertFalse("the old folder goes with it", oldDir.exists())
        assertTrue(Regex("""$now-[0-9a-f-]{36}""").matches(shared.parentFile!!.name))
        assertEquals(out.root.canonicalFile, shared.parentFile!!.parentFile!!.canonicalFile)
        assertTrue(out.owns(shared))
    }

    @Test(expected = IllegalArgumentException::class)
    fun markSharedRefusesAFileThatIsNotOurs() {
        val outside = File(tmp.root, "keep/me.jpg").apply { parentFile!!.mkdirs(); writeBytes(byteArrayOf(3)) }
        timed().markShared(outside)
    }

    @Test fun aSharedFileCanBeReadForTenMinutesAndNotAMomentLonger() {
        val out = timed()
        val shared = out.markShared(result(out))
        val segs = listOf("outgoing", shared.parentFile!!.name, shared.name)
        assertFalse(out.isRefusedPath(segs))
        assertEquals(min10, out.nextShareEndMs())
        now += min10 - 1
        assertFalse(out.isRefusedPath(segs))
        assertEquals(1L, out.nextShareEndMs())
        assertTrue(out.sweepShared().isEmpty())
        assertTrue(shared.isFile)
        now += 1
        assertTrue(out.isRefusedPath(segs))
        assertNull("nothing live, so no timer", out.nextShareEndMs())
        assertEquals(listOf(shared.name), out.sweepShared().map { it.name })
        assertFalse(shared.exists())
        assertFalse(shared.parentFile!!.exists())
    }

    @Test fun theSweepLeavesFilesThatWereNeverSharedAlone() {
        val out = timed()
        val waitingForSave = result(out, "image.public.jpg")
        val old = out.markShared(result(out))
        now += 5 * 60_000L
        val recent = out.markShared(result(out, "image.public.png"))
        now += 6 * 60_000L
        assertEquals(listOf(old.name), out.sweepShared().map { it.name })
        assertTrue(waitingForSave.isFile)
        assertTrue(recent.isFile)
        assertEquals("the next end is the recent share's", 4 * 60_000L, out.nextShareEndMs())
    }

    @Test fun theProviderServesOnlyASharedFileWithinItsTime() {
        val out = timed()
        val waitingForSave = result(out)
        val shared = out.markShared(result(out))
        // A file waiting for its save screen, or still arriving, is never handed out.
        assertTrue(out.isRefusedPath(listOf("outgoing", waitingForSave.parentFile!!.name, waitingForSave.name)))
        assertFalse(out.isRefusedPath(listOf("outgoing", shared.parentFile!!.name, shared.name)))
        // Anything malformed under outgoing/ is refused.
        assertTrue(out.isRefusedPath(listOf("outgoing")))
        assertTrue(out.isRefusedPath(listOf("outgoing", shared.parentFile!!.name)))
        assertTrue(out.isRefusedPath(listOf("outgoing", shared.parentFile!!.name, "x", shared.name)))
        assertTrue(out.isRefusedPath(listOf("outgoing", "123-nope", shared.name)))
        // Other folders are not this rule's to judge.
        assertFalse(out.isRefusedPath(listOf("clipboard", "1759700000000-${java.util.UUID.randomUUID()}", "image.png")))
        assertFalse(out.isRefusedPath(emptyList()))
    }

    @Test fun aClockSetBackCannotExtendASharedFile() {
        val out = timed()
        val shared = out.markShared(result(out))
        val segs = listOf("outgoing", shared.parentFile!!.name, shared.name)
        now -= OutgoingFiles.FUTURE_TOLERANCE_MS
        assertFalse("within the tolerance", out.isRefusedPath(segs))
        now -= 1
        assertTrue(out.isRefusedPath(segs))
        assertEquals(1, out.sweepShared().size)
    }

    @Test fun aFreshStartKeepsOnlyTheSharedFilesStillWithinTheirTime() {
        val out = timed()
        result(out, "waiting.jpg")
        val expired = out.markShared(result(out, "expired.jpg"))
        now += min10
        val live = out.markShared(result(out, "live.jpg"))
        File(out.root, "stray").writeBytes(byteArrayOf(1))
        assertEquals(3, out.clearExceptLiveShares())
        assertTrue(live.isFile)
        assertFalse(expired.exists())
        assertEquals(listOf(live.parentFile!!.name), out.root.list()!!.toList())
        assertEquals(1, out.clear())
    }
}
