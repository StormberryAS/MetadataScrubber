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
import java.nio.file.Files

/** Where a photo taken in the app waits for the page, and how it goes. */
class CameraFilesTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun files() = CameraFiles(tmp.root)

    /** A finished photo, as the camera screen leaves it. */
    private fun photo(c: CameraFiles, bytes: ByteArray = byteArrayOf(-1, -40, -1, -39)): String {
        val part = c.newPhoto()
        part.writeBytes(bytes)
        return c.commit(part)!!
    }

    @Test fun aPhotoLivesInItsOwnFolderUnderCacheCamera() {
        val c = files()
        val part = c.newPhoto()
        assertEquals(CameraFiles.PART_NAME, part.name)
        assertEquals(File(tmp.root, "camera").canonicalFile, part.parentFile!!.parentFile!!.canonicalFile)
        assertTrue(Regex("[0-9a-f-]{36}").matches(part.parentFile!!.name))
        assertFalse("nothing is written until the camera screen writes it", part.exists())
        part.writeBytes(byteArrayOf(1, 2, 3))
        val id = c.commit(part)!!
        assertEquals(part.parentFile!!.name, id)
        val f = c.resolve(id)!!
        assertEquals("photo.jpg", f.name)
        assertEquals(3L, f.length())
        assertFalse(part.exists())
        assertEquals(id, c.idOf(f))
    }

    @Test fun twoPhotosNeverShareAFolder() {
        val c = files()
        val a = photo(c)
        val b = photo(c)
        assertTrue(a != b)
        assertEquals(2, c.root.listFiles()!!.size)
    }

    @Test fun resolveTakesAUuidOnly() {
        val c = files()
        val id = photo(c)
        assertNotNull(c.resolve(id))
        for (bad in listOf(null, "", "..", "../camera", "$id/../$id", "$id/photo.jpg", id.uppercase(), "photo.jpg", "/etc/passwd",
            "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", " $id", "$id ", "$id\u0000")) {
            assertNull("'$bad'", c.resolve(bad))
        }
    }

    @Test fun aHalfWrittenPhotoIsNeverResolved() {
        val c = files()
        val part = c.newPhoto()
        part.writeBytes(byteArrayOf(1))
        assertNull(c.resolve(part.parentFile!!.name))
    }

    @Test fun aSymbolicLinkIsNeverFollowed() {
        val c = files()
        val secret = File(tmp.root, "files/secret.jpg").apply { parentFile!!.mkdirs(); writeBytes(byteArrayOf(7)) }
        // A photo folder that is a link to another folder.
        val linkedDir = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
        c.root.mkdirs()
        val target = File(tmp.root, "files/$linkedDir").apply { mkdirs() }
        File(target, "photo.jpg").writeBytes(byteArrayOf(8))
        Files.createSymbolicLink(File(c.root, linkedDir).toPath(), target.toPath())
        assertNull(c.resolve(linkedDir))
        assertFalse("delete refuses a linked folder", c.delete(File(File(c.root, linkedDir), "photo.jpg")))
        assertTrue(File(target, "photo.jpg").exists())
        // A photo that is a link to another file.
        val id = photo(c)
        val real = c.resolve(id)!!
        real.delete()
        Files.createSymbolicLink(real.toPath(), secret.toPath())
        assertNull(c.resolve(id))
    }

    @Test fun deleteTouchesOnlyItsOwnFolder() {
        val c = files()
        val a = photo(c)
        val b = photo(c)
        val other = File(tmp.root, "outgoing/x/image.public.jpg").apply { parentFile!!.mkdirs(); writeBytes(byteArrayOf(1)) }
        assertTrue(c.delete(c.resolve(a)!!))
        assertNull(c.resolve(a))
        assertFalse(File(c.root, a).exists())
        assertNotNull("the other photo stays", c.resolve(b))
        assertTrue(c.root.isDirectory)
        assertFalse("not one of ours", c.delete(other))
        assertTrue(other.exists())
        assertFalse("never the root itself", c.delete(File(c.root, "photo.jpg")))
        assertTrue(c.root.isDirectory)
    }

    @Test fun clearRemovesEveryFolderFinishedOrNot() {
        val c = files()
        photo(c)
        photo(c)
        c.newPhoto().writeBytes(byteArrayOf(1))
        File(c.root, "stray").writeBytes(byteArrayOf(1))
        assertEquals(4, c.clear())
        assertEquals(0, c.root.listFiles()!!.size)
        assertEquals("an empty or missing folder is fine", 0, CameraFiles(File(tmp.root, "nowhere")).clear())
    }

    @Test fun clearExceptKeepsOnlyThePhotoStillOnItsWayToThePage() {
        // The sweep when the page comes back into view (1.1.0): the photo waiting for the
        // page and one still being checked stay; a photo or half-written file a killed
        // process left behind goes.
        val c = files()
        val waiting = photo(c)
        val checking = photo(c)
        val leftOver = photo(c)
        val half = c.newPhoto().apply { writeBytes(byteArrayOf(1)) }
        assertEquals(2, c.clearExcept(setOf(waiting, checking)))
        assertNotNull(c.resolve(waiting))
        assertNotNull(c.resolve(checking))
        assertNull(c.resolve(leftOver))
        assertFalse(half.parentFile!!.exists())
        assertEquals(1, c.clearExcept(setOf(waiting)))
        assertEquals("an empty set keeps nothing", 1, c.clearExcept(emptySet()))
        assertEquals(0, c.root.listFiles()!!.size)
    }

    @Test fun commitRefusesWhatIsNotAPartFileOfOurs() {
        val c = files()
        val elsewhere = File(tmp.root, "elsewhere/${CameraFiles.PART_NAME}").apply { parentFile!!.mkdirs(); writeBytes(byteArrayOf(1)) }
        assertNull(c.commit(elsewhere))
        assertTrue("a file elsewhere is left alone", elsewhere.exists())
        val part = c.newPhoto()
        assertNull("nothing written yet", c.commit(part))
        assertFalse("its folder goes", part.parentFile!!.exists())
    }

    @Test fun theFolderIsNotOneTheFileProviderServes() {
        val paths = File("src/main/res/xml/file_paths.xml").readText()
        assertTrue(paths.contains("outgoing/") && paths.contains("clipboard/"))
        assertFalse("cache/camera/ must never be handed to another app", Regex("""path="camera""").containsMatchIn(paths))
        assertEquals("camera", CameraFiles.DIR)
    }
}
