package no.stormberry.metadatascrubber

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import javax.imageio.IIOImage
import javax.imageio.ImageIO
import javax.imageio.ImageWriteParam

/** A photo taken in the app must be a JPEG of pixels only. */
class JpegCheckTest {

    // ---- Real JPEGs, made by javax.imageio, with metadata planted in them.

    private fun picture(w: Int = 64, h: Int = 48): BufferedImage {
        val img = BufferedImage(w, h, BufferedImage.TYPE_INT_RGB)
        for (y in 0 until h) for (x in 0 until w) img.setRGB(x, y, (x * 4 shl 16) or (y * 5 shl 8) or ((x xor y) and 0xFF))
        return img
    }

    private fun encode(img: BufferedImage, progressive: Boolean = false): ByteArray {
        val writer = ImageIO.getImageWritersByFormatName("jpeg").next()
        val param = writer.defaultWriteParam
        param.compressionMode = ImageWriteParam.MODE_EXPLICIT
        param.compressionQuality = 0.9f
        if (progressive) param.progressiveMode = ImageWriteParam.MODE_DEFAULT
        val out = ByteArrayOutputStream()
        ImageIO.createImageOutputStream(out).use { ios ->
            writer.output = ios
            writer.write(null, IIOImage(img, null, null), param)
        }
        writer.dispose()
        return out.toByteArray()
    }

    private fun seg(marker: Int, payload: ByteArray): ByteArray {
        val n = payload.size + 2
        return byteArrayOf(0xFF.toByte(), marker.toByte(), (n shr 8).toByte(), n.toByte()) + payload
    }

    private fun ascii(s: String) = s.toByteArray(Charsets.ISO_8859_1)

    /** Inserts [segments] right after SOI. */
    private fun plant(jpeg: ByteArray, vararg segments: ByteArray): ByteArray =
        jpeg.copyOfRange(0, 2) + segments.fold(ByteArray(0)) { a, b -> a + b } + jpeg.copyOfRange(2, jpeg.size)

    private val gpsExif = seg(0xE1, ascii("Exif\u0000\u0000MM\u0000*\u0000\u0000\u0000\u0008GPSLatitude 59.9075N GPSLongitude 10.7531E Kari Nordmann"))
    private val xmp = seg(0xE1, ascii("http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta><dc:creator>Kari Nordmann</dc:creator></x:xmpmeta>"))
    private val icc = seg(0xE2, ascii("ICC_PROFILE\u0000\u0001\u0001") + ByteArray(128) { it.toByte() })
    private val photoshop = seg(0xED, ascii("Photoshop 3.0\u00008BIM\u0004\u0004\u0000\u0000\u0000\u0000\u0000\u0010By-line Kari"))
    private val comment = seg(0xFE, ascii("Taken at Holmenkollen by Kari Nordmann"))
    private val jfxxThumb = seg(0xE0, ascii("JFXX\u0000\u0013") + ByteArray(48) { 0x7F })
    private val samsung = seg(0xE9, ascii("SEFT serial R58N12345"))
    private val adobe = seg(0xEE, ascii("Adobe") + byteArrayOf(0, 100, 0, 0, 0, 0, 1))

    private fun copy(bytes: ByteArray, max: Long = JpegCheck.MAX_BYTES): ByteArray? {
        val out = ByteArrayOutputStream()
        return if (JpegCheck.copyPixelsOnly(ByteArrayInputStream(bytes), out, max)) out.toByteArray() else null
    }

    private fun clean(bytes: ByteArray) = JpegCheck.isPixelsOnly(ByteArrayInputStream(bytes))

    /** Every marker in the file, in order, outside the entropy-coded data. */
    private fun markers(jpeg: ByteArray): List<Int> {
        val out = mutableListOf<Int>()
        var i = 2
        out += 0xD8
        while (i < jpeg.size) {
            require(jpeg[i] == 0xFF.toByte())
            val m = jpeg[i + 1].toInt() and 0xFF
            out += m
            if (m == 0xD9) break
            val len = ((jpeg[i + 2].toInt() and 0xFF) shl 8) or (jpeg[i + 3].toInt() and 0xFF)
            i += 2 + len
            if (m == 0xDA) {
                // Skip the entropy-coded data up to the next real marker.
                while (true) {
                    val next = jpeg[i + 1].toInt() and 0xFF
                    if (jpeg[i] == 0xFF.toByte() && next != 0 && next !in 0xD0..0xD7) break
                    i++
                }
            }
        }
        return out
    }

    private fun pixels(jpeg: ByteArray): IntArray {
        val img = ImageIO.read(ByteArrayInputStream(jpeg))
        return img.getRGB(0, 0, img.width, img.height, null, 0, img.width)
    }

    private val allowed = setOf(0xD8, 0xDB, 0xC4, 0xDD, 0xC0, 0xC1, 0xC2, 0xDA, 0xD9)

    @Test fun aBaselineJpegLosesEveryApplicationSegmentAndComment() {
        val plain = encode(picture())
        val planted = plant(plain, gpsExif, xmp, icc, photoshop, comment, jfxxThumb, samsung)
        val out = copy(planted)!!
        assertTrue("only tables, the frame, the scans and EOI: ${markers(out)}", markers(out).all { it in allowed })
        assertFalse("the JFIF header goes too", markers(out).any { it in 0xE0..0xEF || it == 0xFE })
        for (s in listOf("Kari", "GPS", "Exif", "ICC_PROFILE", "Photoshop", "JFIF", "JFXX", "SEFT", "Holmenkollen", "xmpmeta")) {
            assertFalse("'$s' survives", String(out, Charsets.ISO_8859_1).contains(s))
        }
        // The same bytes whatever was planted: the planted parts leave no trace.
        assertArrayEquals(copy(plain), out)
        assertArrayEquals("decodes to identical pixels", pixels(plain), pixels(out))
        assertTrue(clean(out))
        assertFalse("the original carries metadata", clean(planted))
        assertFalse("even the plain encoder output has a JFIF header", clean(plain))
    }

    @Test fun aProgressiveJpegKeepsEveryScanAndTheTablesBetweenThem() {
        val plain = encode(picture(80, 60), progressive = true)
        assertTrue("the encoder made a progressive JPEG", markers(plain).contains(0xC2))
        assertTrue("with several scans", markers(plain).count { it == 0xDA } > 1)
        val out = copy(plant(plain, gpsExif, comment, icc))!!
        assertEquals(markers(plain).filter { it in allowed }, markers(out))
        assertArrayEquals(pixels(plain), pixels(out))
        assertTrue(clean(out))
    }

    @Test fun theCopyIsIdempotent() {
        val once = copy(plant(encode(picture()), gpsExif, xmp))!!
        assertArrayEquals(once, copy(once))
    }

    @Test fun stuffedBytesRestartMarkersAndFillBytesAreHandled() {
        // A hand-made scan: data with a stuffed FF00, a restart marker, then fill bytes before EOI.
        val sof = seg(0xC0, byteArrayOf(8, 0, 1, 0, 1, 1, 1, 0x11, 0))
        val dri = seg(0xDD, byteArrayOf(0, 1))
        val sos = seg(0xDA, byteArrayOf(1, 1, 0, 0, 63, 0))
        val scan = byteArrayOf(0x12, 0xFF.toByte(), 0x00, 0x34, 0xFF.toByte(), 0xD0.toByte(), 0x56)
        val soi = byteArrayOf(0xFF.toByte(), 0xD8.toByte())
        val eoi = byteArrayOf(0xFF.toByte(), 0xD9.toByte())
        val fill = byteArrayOf(0xFF.toByte(), 0xFF.toByte())
        val input = soi + seg(0xE0, ascii("JFIF\u0000")) + dri + sof + sos + scan + fill + eoi
        assertArrayEquals(soi + dri + sof + sos + scan + eoi, copy(input))
    }

    // ---- Refusals: the photo fails rather than leaks or changes.

    private val base get() = encode(picture())

    /** Replaces the first frame header's marker with [marker]. */
    private fun withFrame(marker: Int): ByteArray {
        val b = base.copyOf()
        val at = (2 until b.size - 1).first { b[it] == 0xFF.toByte() && b[it + 1] == 0xC0.toByte() }
        b[at + 1] = marker.toByte()
        return b
    }

    private fun refused(why: String, bytes: ByteArray) {
        assertFalse("copy: $why", JpegCheck.copyPixelsOnly(ByteArrayInputStream(bytes), ByteArrayOutputStream()))
        assertFalse("check: $why", clean(bytes))
    }

    @Test fun brokenFilesAreRefused() {
        val b = base
        refused("empty", ByteArray(0))
        refused("not a JPEG", ascii("not a jpeg at all"))
        refused("truncated in the scan", b.copyOf(b.size / 2))
        refused("no EOI", b.copyOf(b.size - 2))
        refused("bytes after EOI", b + ascii("GPS 59.9N"))
        refused("a second image after EOI", b + b)
        refused("a segment length under 2", plant(b, byteArrayOf(0xFF.toByte(), 0xE1.toByte(), 0, 1)))
        refused("a segment length past the end", plant(b, byteArrayOf(0xFF.toByte(), 0xE1.toByte(), 0xFF.toByte(), 0xFF.toByte())))
        refused("no picture at all", byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xD9.toByte()))
    }

    @Test fun framesAndMarkersOutsideTheAllowedSetAreRefused() {
        refused("SOF3 (lossless)", withFrame(0xC3))
        refused("SOF9 (arithmetic)", withFrame(0xC9))
        refused("SOF5 (hierarchical)", withFrame(0xC5))
        refused("SOF15", withFrame(0xCF))
        val b = base
        refused("DAC", plant(b, seg(0xCC, byteArrayOf(0, 0x10))))
        refused("DHP", plant(b, seg(0xDE, byteArrayOf(8, 0, 1, 0, 1, 1, 1, 0x11, 0))))
        refused("EXP", plant(b, seg(0xDF, byteArrayOf(0x11))))
        refused("JPG0", plant(b, seg(0xF0, ascii("x"))))
        refused("JPG13", plant(b, seg(0xFD, ascii("x"))))
        refused("TEM", plant(b, byteArrayOf(0xFF.toByte(), 0x01)))
        refused("a reserved marker", plant(b, seg(0x02, ascii("x"))))
        refused("a restart marker outside a scan", plant(b, byteArrayOf(0xFF.toByte(), 0xD3.toByte())))
        refused("a second SOI", plant(b, byteArrayOf(0xFF.toByte(), 0xD8.toByte())))
        // DNL sits after the first scan.
        val eoiAt = b.size - 2
        refused("DNL", b.copyOfRange(0, eoiAt) + seg(0xDC, byteArrayOf(0, 48)) + b.copyOfRange(eoiAt, b.size))
    }

    @Test fun anAdobeColourTransformIsRefusedButOtherApp14IsDropped() {
        refused("Adobe APP14", plant(base, adobe))
        val other = plant(base, seg(0xEE, ascii("Ducky-ish private data")))
        val out = copy(other)
        assertTrue(out != null && clean(out))
    }

    @Test fun aSecondFrameOrAScanBeforeTheFrameIsRefused() {
        val b = base
        val sofAt = (2 until b.size - 1).first { b[it] == 0xFF.toByte() && b[it + 1] == 0xC0.toByte() }
        val sofLen = ((b[sofAt + 2].toInt() and 0xFF) shl 8) or (b[sofAt + 3].toInt() and 0xFF)
        val sof = b.copyOfRange(sofAt, sofAt + 2 + sofLen)
        refused("a second frame header", plant(b, sof))
        refused("a scan before the frame header", plant(b, seg(0xDA, byteArrayOf(1, 1, 0, 0, 63, 0))))
    }

    @Test fun theSizeCeilingHolds() {
        val b = base
        assertTrue(copy(b, max = b.size.toLong()) != null)
        assertTrue("one byte too many", copy(b, max = b.size.toLong() - 1) == null)
        assertFalse(JpegCheck.isPixelsOnly(ByteArrayInputStream(copy(b)!!), maxBytes = 100))
        assertEquals(64L * 1024 * 1024, JpegCheck.MAX_BYTES)
    }
}
