package no.stormberry.metadatascrubber

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/**
 * The save screen's document after a save (1.1.1, after CheckLink's SaveTargetTest): the new file
 * replaces the document whole or the save fails, a write through plain "w" that leaves an older
 * file's end behind fails and removes the mix, a file the person chose to replace is never deleted
 * unless MetadataScrubber opened it for writing, an empty one the save screen made is removed, and
 * a picture that ends before its known length fails the save.
 */
class SaveTargetTest {
    /**
     * A document in a stand-in storage app. [content] null: deleted. [truncates]: whether "wt" is
     * allowed; "w" overwrites from the start without truncating, as some storage apps do. A refused
     * "wt" throws, or with [refusesWithNull] returns no stream. [sizeFails]: size() throws once a
     * stream has been opened.
     */
    private class FakeDocument(
        var content: ByteArray?,
        val truncates: Boolean = true,
        val saysSize: Boolean = true,
        val failWrite: Boolean = false,
        val refusesWithNull: Boolean = false,
        val sizeFails: Boolean = false,
    ) : SaveTarget.Document {
        val modes = mutableListOf<String>()
        var deletes = 0

        override fun open(mode: String): OutputStream? {
            modes += mode
            if (mode == "wt" && !truncates) {
                if (refusesWithNull) return null
                throw IllegalArgumentException("wt refused")
            }
            val start = if (mode == "wt") ByteArray(0) else content ?: ByteArray(0)
            if (mode == "wt") content = ByteArray(0)
            return object : ByteArrayOutputStream() {
                override fun write(b: ByteArray, off: Int, len: Int) {
                    if (failWrite) throw IOException("disk full")
                    super.write(b, off, len)
                }

                override fun close() {
                    val written = toByteArray()
                    content = if (written.size >= start.size) written else written + start.copyOfRange(written.size, start.size)
                }
            }
        }

        override fun size(): Long? {
            if (sizeFails && modes.isNotEmpty()) throw IllegalStateException("no size")
            return if (saysSize) content?.size?.toLong() else null
        }

        override fun delete() {
            deletes++
            content = null
        }
    }

    /** A clean JPEG stand-in: start marker, some bytes, end marker. */
    private val clean = byteArrayOf(0xFF.toByte(), 0xD8.toByte()) + ByteArray(300) { (it * 7).toByte() } +
        byteArrayOf(0xFF.toByte(), 0xD9.toByte())

    /** An older, longer file: a Motion Photo whose video (with its own details) follows the picture. */
    private val motionPhoto = ByteArray(5000) { 1 } + "CANARY-video-location".toByteArray()

    private fun picture(bytes: ByteArray) = SaveTarget.Picture(bytes.size.toLong()) { ByteArrayInputStream(bytes) }

    /** A picture whose stream ends after [served] of its [bytes], as a file shortened during the copy would. */
    private fun shortened(bytes: ByteArray, served: Int) =
        SaveTarget.Picture(bytes.size.toLong()) { ByteArrayInputStream(bytes, 0, served) }

    @Test fun aNewDocumentGetsThePicture() {
        val doc = FakeDocument(ByteArray(0))
        assertTrue(SaveTarget.save(doc, picture(clean)))
        assertArrayEquals(clean, doc.content)
        assertEquals(listOf("wt"), doc.modes)
    }

    @Test fun anOlderLongerFileIsReplacedWhole() {
        // The case 1.1.1 is for, through a storage app that accepts "wt": nothing of the older file stays.
        val doc = FakeDocument(motionPhoto.copyOf())
        assertTrue(SaveTarget.save(doc, picture(clean)))
        assertArrayEquals(clean, doc.content)
        assertEquals(listOf("wt"), doc.modes)
    }

    @Test fun plainWThatLeavesAnOlderFilesEndFailsAndRemovesTheMix() {
        // "wt" refused and "w" does not truncate: the clean picture would be followed by the end of
        // the older, longer file (the Motion Photo's video and its details). That fails, and the
        // mixed file goes, so no copy of the old tail is left behind under the new name.
        val doc = FakeDocument(motionPhoto.copyOf(), truncates = false)
        assertFalse(SaveTarget.save(doc, picture(clean)))
        assertNull(doc.content)
        assertEquals(listOf("wt", "w"), doc.modes)
    }

    @Test fun theOldOpenForWriteWouldHaveLeftTheTail() {
        // What 1.1.0's openForWrite did with the same storage app: "wt" refused, "w" written, no
        // check. The document then holds the clean picture plus the older file's end. Kept as a
        // test of the stand-in itself, so the test above proves the fix and not a lenient fake.
        val doc = FakeDocument(motionPhoto.copyOf(), truncates = false)
        val out = try {
            doc.open("wt")
        } catch (_: Exception) {
            null
        } ?: doc.open("w")!!
        out.use { it.write(clean) }
        val mixed = doc.content!!
        assertEquals(motionPhoto.size, mixed.size)
        assertArrayEquals(clean, mixed.copyOfRange(0, clean.size))
        assertTrue(String(mixed, Charsets.ISO_8859_1).contains("CANARY-video-location"))
    }

    @Test fun plainWIntoANewDocumentIsFine() {
        val doc = FakeDocument(ByteArray(0), truncates = false)
        assertTrue(SaveTarget.save(doc, picture(clean)))
        assertArrayEquals(clean, doc.content)
        assertEquals(listOf("wt", "w"), doc.modes)
    }

    @Test fun plainWOverAnEqualOrShorterFileIsFine() {
        // Same size afterwards as the picture: nothing of the older file can be left.
        val shorter = FakeDocument(ByteArray(100) { 9 }, truncates = false)
        assertTrue(SaveTarget.save(shorter, picture(clean)))
        assertArrayEquals(clean, shorter.content)
        val equal = FakeDocument(ByteArray(clean.size) { 9 }, truncates = false)
        assertTrue(SaveTarget.save(equal, picture(clean)))
        assertArrayEquals(clean, equal.content)
    }

    @Test fun plainWWithNoSizeToCheckIsTakenAsWritten() {
        // A storage app that gives no size serves a stream with no file behind it: what is written
        // is the document's whole new content.
        val doc = FakeDocument(ByteArray(0), truncates = false, saysSize = false)
        assertTrue(SaveTarget.save(doc, picture(clean)))
        assertArrayEquals(clean, doc.content)
    }

    @Test fun aLargePictureIsCopiedWhole() {
        // Pictures can be large (up to 512 MB); the copy streams, and the size check counts every byte.
        val big = ByteArray(3 * 1024 * 1024 + 17) { (it % 251).toByte() }
        val doc = FakeDocument(ByteArray(4 * 1024 * 1024) { 2 }, truncates = false)
        assertFalse(SaveTarget.save(doc, picture(big)))
        assertNull(doc.content)
        val fresh = FakeDocument(ByteArray(4 * 1024 * 1024) { 2 })
        assertTrue(SaveTarget.save(fresh, picture(big)))
        assertArrayEquals(big, fresh.content)
    }

    @Test fun aFileChosenToReplaceIsKeptWhenThePictureIsGone() {
        // The waiting file is gone (Android trimmed the cache while the app was stopped): nothing
        // is written, and the person's own file stays as it was.
        val doc = FakeDocument(motionPhoto.copyOf())
        assertFalse(SaveTarget.save(doc, null))
        assertArrayEquals(motionPhoto, doc.content)
        assertTrue(doc.modes.isEmpty())
        assertEquals(0, doc.deletes)
    }

    @Test fun aFileChosenToReplaceIsKeptWhenThePictureCannotBeRead() {
        val doc = FakeDocument(motionPhoto.copyOf())
        assertFalse(SaveTarget.save(doc, SaveTarget.Picture(clean.size.toLong()) { throw IOException("gone") }))
        assertArrayEquals(motionPhoto, doc.content)
        assertTrue(doc.modes.isEmpty())
    }

    @Test fun theEmptyDocumentTheSaveScreenMadeIsRemovedWhenThePictureIsGone() {
        val doc = FakeDocument(ByteArray(0))
        assertFalse(SaveTarget.save(doc, null))
        assertNull(doc.content)
    }

    @Test fun aDocumentOfUnknownSizeIsLeftAloneWhenThePictureIsGone() {
        val doc = FakeDocument(motionPhoto.copyOf(), saysSize = false)
        assertFalse(SaveTarget.save(doc, null))
        assertArrayEquals(motionPhoto, doc.content)
        assertEquals(0, doc.deletes)
    }

    @Test fun aWriteThatFailsAfterOpeningRemovesTheBrokenFile() {
        val doc = FakeDocument(motionPhoto.copyOf(), failWrite = true)
        assertFalse(SaveTarget.save(doc, picture(clean)))
        assertNull(doc.content)
    }

    @Test fun aReadThatFailsHalfwayRemovesTheBrokenFile() {
        val doc = FakeDocument(motionPhoto.copyOf())
        val breaking = SaveTarget.Picture(clean.size.toLong()) {
            object : InputStream() {
                var n = 0
                override fun read(): Int = if (n++ < 100) 1 else throw IOException("read failed")
            }
        }
        assertFalse(SaveTarget.save(doc, breaking))
        assertNull(doc.content)
    }

    @Test fun aStorageAppThatOpensNothingLeavesAFilledFileAlone() {
        val refusing = object : SaveTarget.Document {
            var deleted = false
            override fun open(mode: String): OutputStream? = null
            override fun size(): Long? = 5000
            override fun delete() {
                deleted = true
            }
        }
        assertFalse(SaveTarget.save(refusing, picture(clean)))
        assertFalse(refusing.deleted)
    }

    @Test fun aStorageAppThatRefusesBothModesRemovesOnlyAnEmptyDocument() {
        val throwing = object : SaveTarget.Document {
            var deleted = false
            override fun open(mode: String): OutputStream? = throw SecurityException("no")
            override fun size(): Long? = 0
            override fun delete() {
                deleted = true
            }
        }
        assertFalse(SaveTarget.save(throwing, picture(clean)))
        assertTrue(throwing.deleted)
    }

    @Test fun thePictureIsClosedAfterTheSave() {
        var closed = 0
        val counting = SaveTarget.Picture(clean.size.toLong()) {
            object : ByteArrayInputStream(clean) {
                override fun close() {
                    closed++
                    super.close()
                }
            }
        }
        assertTrue(SaveTarget.save(FakeDocument(ByteArray(0)), counting))
        assertFalse(SaveTarget.save(FakeDocument(motionPhoto.copyOf(), truncates = false), counting))
        assertEquals(2, closed)
    }

    @Test fun aStorageAppThatGivesNoStreamForWtIsCheckedToo() {
        // "wt" refused by returning no stream rather than throwing, then a "w" that does not
        // truncate: the same check, the same outcome as a refusal that throws.
        val doc = FakeDocument(motionPhoto.copyOf(), truncates = false, refusesWithNull = true)
        assertFalse(SaveTarget.save(doc, picture(clean)))
        assertNull(doc.content)
        assertEquals(listOf("wt", "w"), doc.modes)
    }

    @Test fun aSizeThatCannotBeReadAfterPlainWFailsAndRemovesTheFile() {
        // Into a new document, which would otherwise pass: when the size cannot be read after a
        // plain "w", the save is not taken as written, and the file it opened goes.
        val doc = FakeDocument(ByteArray(0), truncates = false, sizeFails = true)
        assertFalse(SaveTarget.save(doc, picture(clean)))
        assertNull(doc.content)
        assertEquals(1, doc.deletes)
        assertEquals(listOf("wt", "w"), doc.modes)
    }

    @Test fun aPictureThatEndsEarlyFailsAndRemovesTheBrokenFile() {
        // The clean file was shortened during the copy: the document would hold a cut picture.
        val doc = FakeDocument(motionPhoto.copyOf())
        assertFalse(SaveTarget.save(doc, shortened(clean, 100)))
        assertNull(doc.content)
        assertEquals(listOf("wt"), doc.modes)
    }

    @Test fun aPictureThatEndsEarlyFailsAfterPlainWToo() {
        // Through plain "w" into a new document the size equals the bytes copied, so only the
        // picture's known length tells the cut picture apart.
        val doc = FakeDocument(ByteArray(0), truncates = false)
        assertFalse(SaveTarget.save(doc, shortened(clean, 100)))
        assertNull(doc.content)
        assertEquals(listOf("wt", "w"), doc.modes)
    }
}
