package no.stormberry.metadatascrubber

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.util.zip.CRC32
import java.util.zip.Deflater

/** The clipboard copy must be a PNG of pixels only. */
class PngCheckTest {
    private fun chunk(type: String, data: ByteArray = ByteArray(0), badCrc: Boolean = false): ByteArray {
        val out = ByteArrayOutputStream()
        val d = DataOutputStream(out)
        d.writeInt(data.size)
        val t = type.toByteArray(Charsets.US_ASCII)
        d.write(t)
        d.write(data)
        val crc = CRC32()
        crc.update(t)
        crc.update(data)
        d.writeInt((crc.value.toInt()) xor (if (badCrc) 1 else 0))
        return out.toByteArray()
    }

    private val ihdr = chunk("IHDR", byteArrayOf(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0))
    private val idat = run {
        val raw = byteArrayOf(0, 255.toByte(), 0, 0, 255.toByte())
        val def = Deflater()
        def.setInput(raw)
        def.finish()
        val buf = ByteArray(64)
        val n = def.deflate(buf)
        chunk("IDAT", buf.copyOf(n))
    }
    private val iend = chunk("IEND")
    private val sig = byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)

    private fun png(vararg parts: ByteArray) = parts.fold(sig) { a, b -> a + b }
    private fun ok(bytes: ByteArray) = PngCheck.isPixelsOnly(ByteArrayInputStream(bytes))

    @Test fun aCanvasStylePngPasses() {
        assertTrue(ok(png(ihdr, idat, iend)))
        assertTrue(ok(png(ihdr, chunk("sRGB", byteArrayOf(0)), chunk("pHYs", ByteArray(9)), idat, iend)))
    }

    @Test fun textExifTimeAndProfilesAreRefused() {
        for (t in listOf("tEXt", "zTXt", "iTXt", "eXIf", "tIME", "iCCP", "sPLT", "caBX", "prVt", "hIST")) {
            assertFalse("chunk $t", ok(png(ihdr, chunk(t, "Kari Nordmann".toByteArray()), idat, iend)))
        }
    }

    @Test fun anythingAfterIendIsRefused() {
        assertFalse(ok(png(ihdr, idat, iend) + "GPS 59.9N".toByteArray()))
        assertFalse(ok(png(ihdr, idat, iend, chunk("tEXt", "x".toByteArray()))))
    }

    @Test fun brokenFilesAreRefused() {
        assertFalse(ok(ByteArray(0)))
        assertFalse(ok("not a png at all".toByteArray()))
        assertFalse(ok(png(ihdr, idat)))
        assertFalse(ok(png(idat, ihdr, iend)))
        assertFalse(ok(png(ihdr, chunk("IDAT", ByteArray(4), badCrc = true), iend)))
        assertFalse(ok(png(ihdr, ihdr, idat, iend)))
        assertFalse(ok(png(chunk("IHDR", ByteArray(12)), idat, iend)))
        assertFalse(ok(png(ihdr, idat, chunk("IEND", ByteArray(1)))))
        // A length that runs past the end of the file.
        assertFalse(ok(png(ihdr) + byteArrayOf(0x7f, 0, 0, 0) + "IDAT".toByteArray()))
    }

    @Test fun theCopyKeepsThePixelChunksAndDropsDrawingHints() {
        val out = ByteArrayOutputStream()
        val withHints = png(ihdr, chunk("sRGB", byteArrayOf(0)), chunk("gAMA", byteArrayOf(0, 0, -79, -113)), idat, iend)
        assertTrue(PngCheck.copyPixelsOnly(ByteArrayInputStream(withHints), out))
        assertArrayEquals(png(ihdr, idat, iend), out.toByteArray())
        // The result passes the check itself and carries no hint.
        assertTrue(ok(out.toByteArray()))
    }

    @Test fun theCopyRefusesWhatTheCheckRefuses() {
        for (bad in listOf(
            png(ihdr, chunk("tEXt", "Author\u0000Kari Nordmann".toByteArray()), idat, iend),
            png(ihdr, idat, iend) + "GPS".toByteArray(),
            png(ihdr, chunk("IDAT", ByteArray(4), badCrc = true), iend),
            png(ihdr, chunk("iCCP", ByteArray(20)), idat, iend),
        )) {
            assertFalse(PngCheck.copyPixelsOnly(ByteArrayInputStream(bad), ByteArrayOutputStream()))
        }
    }

    @Test fun theSizeCeilingHolds() {
        assertFalse(PngCheck.isPixelsOnly(ByteArrayInputStream(png(ihdr, idat, iend)), maxBytes = 40))
    }
}
