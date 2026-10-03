package no.stormberry.metadatascrubber

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FileNamesTest {
    @Test fun keepsThePagesOwnNames() {
        assertEquals("image.public.jpg", FileNames.sanitise("image.public.jpg", "image/jpeg"))
        assertEquals("holiday.clean.png", FileNames.sanitise("holiday.clean.png", "image/png"))
        assertEquals("x.minimal.webp", FileNames.sanitise("x.minimal.webp", "image/webp"))
        assertEquals("a.custom.heic", FileNames.sanitise("a.custom.heic", "image/heic"))
    }

    @Test fun stripsPathsSoNothingEscapesTheCacheFolder() {
        assertEquals("passwd.jpg", FileNames.sanitise("../../etc/passwd", "image/jpeg"))
        assertEquals("evil.jpg", FileNames.sanitise("..\\..\\evil.jpg", "image/jpeg"))
        assertEquals("image.jpg", FileNames.sanitise("../", "image/jpeg"))
        assertEquals("image.jpg", FileNames.sanitise("..", "image/jpeg"))
        assertEquals("image.jpg", FileNames.sanitise(".", "image/jpeg"))
    }

    @Test fun removesControlAndReservedCharacters() {
        assertEquals("a_b_c_d.jpg", FileNames.sanitise("a:b*c?d.jpg", "image/jpeg"))
        assertEquals("ab.jpg", FileNames.sanitise("a\u0000b\n.jpg", "image/jpeg"))
        // A right-to-left override could disguise the extension in a file manager.
        assertEquals("photogpj.png", FileNames.sanitise("photo" + Char(0x202E) + "gpj.png", "image/png"))
        assertEquals("a b.jpg", FileNames.sanitise("  a \t  b .jpg ", "image/jpeg"))
    }

    @Test fun hiddenAndEmptyNamesGetTheFallback() {
        assertEquals("image.jpg", FileNames.sanitise("", "image/jpeg"))
        assertEquals("image.jpg", FileNames.sanitise(null, "image/jpeg"))
        assertEquals("hidden.jpg", FileNames.sanitise(".hidden.jpg", "image/jpeg"))
        assertEquals("jpg.jpg", FileNames.sanitise(".jpg", "image/jpeg"))
        assertEquals("name.jpg", FileNames.sanitise("name...", "image/jpeg"))
    }

    @Test fun extensionAlwaysMatchesTheBytes() {
        assertEquals("image.public.jpg", FileNames.sanitise("image.public", "image/jpeg"))
        // A PNG must not leave the app named .jpg; the right extension is appended.
        assertEquals("photo.jpg.png", FileNames.sanitise("photo.jpg", "image/png"))
        assertEquals("photo.JPEG".lowercase(), FileNames.sanitise("photo.JPEG", "image/jpeg"))
        assertEquals("photo.heic", FileNames.sanitise("photo.heic", "image/heif"))
        assertEquals("photo.exe.jpg", FileNames.sanitise("photo.exe", "image/jpeg"))
    }

    @Test fun longNamesAreCutButKeepTheirExtension() {
        val out = FileNames.sanitise("a".repeat(500) + ".public.jpg", "image/jpeg")
        assertEquals(FileNames.MAX_LENGTH, out.length)
        assertTrue(out.endsWith(".jpg"))
        // Never split a surrogate pair (an emoji) in half.
        val emoji = FileNames.sanitise(String(Character.toChars(0x1F600)).repeat(100) + ".png", "image/png")
        assertTrue(emoji.length <= FileNames.MAX_LENGTH)
        assertFalse(Character.isHighSurrogate(emoji[emoji.length - 5]))
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesTypesTheAppDoesNotProduce() {
        FileNames.sanitise("a.gif", "image/gif")
    }

    @Test fun incomingNamesAreDisplayOnly() {
        assertEquals("PXL_1.jpg", FileNames.incomingDisplayName("PXL_1.jpg", "image/jpeg", 0))
        assertEquals("b.png", FileNames.incomingDisplayName("/sdcard/a/b.png", "image/png", 0))
        assertEquals("shared-3.webp", FileNames.incomingDisplayName(null, "image/webp", 2))
        assertEquals("shared-1.heic", FileNames.incomingDisplayName("  ", "image/heic", 0))
    }
}
