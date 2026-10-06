package no.stormberry.metadatascrubber

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** The copied picture's 2 minutes. */
class ClipboardFilesTest {
    @get:Rule val tmp = TemporaryFolder()

    private var now = 1_759_700_000_000L
    private val min2 = ClipboardFiles.LIFETIME_MS

    private fun clips() = ClipboardFiles(tmp.root) { now }

    /** A finished PNG in the share cache, as the transfer leaves it. */
    private fun png(): File {
        val dir = File(tmp.root, "outgoing/" + java.util.UUID.randomUUID()).apply { mkdirs() }
        return File(dir, "image.png").apply { writeBytes(byteArrayOf(-119, 80, 78, 71)) }
    }

    @Test fun theLifetimeIsTwoMinutes() {
        assertEquals(120_000L, ClipboardFiles.LIFETIME_MS)
    }

    @Test fun adoptMovesTheCopyIntoAFolderNamedForNow() {
        val src = png()
        val c = clips()
        val f = c.adopt(src)
        assertFalse(src.exists())
        assertFalse("the share-cache folder goes too", src.parentFile!!.exists())
        assertEquals("image.png", f.name)
        assertEquals(File(tmp.root, "clipboard").canonicalFile, f.parentFile!!.parentFile!!.canonicalFile)
        assertTrue(f.parentFile!!.name.startsWith("$now-"))
        assertEquals(f.canonicalFile, c.current()!!.canonicalFile)
        assertEquals(min2, c.remainingMs(f))
    }

    @Test fun pasteWorksForTwoMinutesAndNotAMomentLonger() {
        val c = clips()
        val f = c.adopt(png())
        val name = f.parentFile!!.name
        assertFalse(c.isExpired(name, now))
        assertFalse(c.isExpired(name, now + min2 - 1))
        assertTrue(c.isExpired(name, now + min2))
        assertTrue(c.isExpired(name, now + 10 * min2))
        assertEquals(1L, c.remainingMs(f, now + min2 - 1))
        assertEquals(0L, c.remainingMs(f, now + min2))
    }

    @Test fun aNewerCopyReplacesTheOlderAtOnceAndRestartsTheTwoMinutes() {
        val c = clips()
        val first = c.adopt(png())
        now += 90_000
        val second = c.adopt(png())
        assertFalse("the older copy is deleted at once", first.exists())
        assertFalse(first.parentFile!!.exists())
        assertTrue(second.isFile)
        now += 60_000 // 150 s after the first Copy, 60 s after the second
        assertNotNull(c.current())
        assertEquals(60_000L, c.remainingMs(second))
        assertEquals(1, c.root.listFiles()!!.size)
    }

    @Test fun theSweepDeletesOnlyExpiredCopies() {
        val c = clips()
        // A copy left by a killed app 5 minutes ago, and one made 30 s ago.
        val old = File(c.root, "${now - 5 * 60_000}-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0").apply { mkdirs() }
        File(old, "image.png").writeBytes(byteArrayOf(1))
        val fresh = File(c.root, "${now - 30_000}-00000000-1111-2222-3333-444444444444").apply { mkdirs() }
        File(fresh, "image.png").writeBytes(byteArrayOf(2))
        val gone = c.sweep()
        assertEquals(listOf(old.name), gone.map { it.name })
        assertFalse(old.exists())
        assertTrue(fresh.exists())
        now += 90_000 // the second one is now 2 minutes old
        assertEquals(1, c.sweep().size)
        assertNull(c.current())
        assertEquals(0, c.root.listFiles()!!.size)
    }

    @Test fun anythingUnreadableInTheFolderIsExpired() {
        val c = clips()
        for (n in listOf("", "x", "123", "abc-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", "-1-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", "${now}-not-a-uuid", "..")) {
            assertTrue("name '$n'", c.isExpired(n, now))
        }
        assertTrue(c.isExpired(null, now))
        File(c.root, "stray.png").apply { parentFile!!.mkdirs(); writeBytes(byteArrayOf(1)) }
        File(c.root, "junk").mkdirs()
        c.sweep()
        assertEquals(0, c.root.listFiles()!!.size)
    }

    @Test fun aClockSetBackCannotExtendTheCopy() {
        val c = clips()
        val f = c.adopt(png())
        val name = f.parentFile!!.name
        assertFalse("a little skew is fine", c.isExpired(name, now - ClipboardFiles.FUTURE_TOLERANCE_MS))
        assertTrue("a copy from the future is not trusted", c.isExpired(name, now - ClipboardFiles.FUTURE_TOLERANCE_MS - 1))
    }

    @Test fun theProviderRuleCoversClipboardAddressesOnly() {
        val c = clips()
        val f = c.adopt(png())
        val dir = f.parentFile!!.name
        assertFalse(c.isExpiredPath(listOf("clipboard", dir, "image.png"), now))
        assertTrue(c.isExpiredPath(listOf("clipboard", dir, "image.png"), now + min2))
        assertTrue("other names under clipboard/ are refused", c.isExpiredPath(listOf("clipboard", dir, "other.png"), now))
        assertTrue(c.isExpiredPath(listOf("clipboard", dir), now))
        assertTrue(c.isExpiredPath(listOf("clipboard", "..", "image.png"), now))
        assertTrue(c.isExpiredPath(listOf("clipboard", dir, "image.png", "x"), now))
        // Shared files keep their own lifetime: the rule does not touch outgoing/.
        assertFalse(c.isExpiredPath(listOf("outgoing", "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", "image.public.jpg"), now + 100 * min2))
        assertFalse(c.isExpiredPath(emptyList(), now))
    }

    @Test fun thePageHearsTheCopyHasEndedWhenItIsGoneOrPastItsTime() {
        val c = clips()
        assertFalse("no copy announced, nothing to say", c.hasEnded(null))
        val f = c.adopt(png())
        assertFalse(c.hasEnded(f, now + min2 - 1))
        assertTrue("2 minutes are up", c.hasEnded(f, now + min2))
        // Deleted while the app was away (the alarm, the provider): ended, whatever the time.
        c.sweep(now + min2)
        assertTrue(c.hasEnded(f, now))
        // A newer Copy deletes the older one, so the older one has ended and the newer one has not.
        val g = c.adopt(png())
        val h = c.adopt(png())
        assertTrue(c.hasEnded(g))
        assertFalse(c.hasEnded(h))
    }

    @Test fun clearRemovesEveryCopy() {
        val c = clips()
        c.adopt(png())
        c.clear()
        assertEquals(0, c.root.listFiles()!!.size)
        assertNull(c.current())
    }
}
