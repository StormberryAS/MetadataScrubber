package no.stormberry.metadatascrubber

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
}
