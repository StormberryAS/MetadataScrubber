package no.stormberry.metadatascrubber

import java.io.InputStream
import java.io.OutputStream

/**
 * Makes sure a photo taken in the app is a JPEG of pixels only (1.1.0). Pure Kotlin, unit
 * tested on the JVM; the twin of [PngCheck].
 *
 * The camera screen decodes the camera's JPEG to pixels and encodes them again with
 * Android's own encoder, which adds a JFIF header and may add a colour profile. Before the
 * photo is written anywhere, [copyPixelsOnly] reads every segment and writes out only what
 * draws the picture: the quantisation and Huffman tables (DQT, DHT), the restart interval
 * (DRI), the frame header of a baseline, extended or progressive JPEG (SOF0, SOF1, SOF2)
 * and each scan (SOS) with its entropy-coded data copied byte for byte, stuffed bytes and
 * restart markers included. Every application segment (APP0 to APP15: JFIF, EXIF, XMP, ICC
 * and anything else) and every comment (COM) is left out, so the file carries no metadata
 * at all, and the page's engine finds nothing to list.
 *
 * Anything else makes the copy fail rather than leak or change the picture: a marker that
 * is not one of the above (arithmetic coding, lossless or hierarchical frames, DNL, JPG
 * extensions, TEM, reserved markers), an Adobe APP14 (it says how to read the colours, so
 * leaving it out could change them), a second frame header, a scan before the frame
 * header, a segment length under 2 or past the end of the file, no EOI, any byte after EOI,
 * or more than [MAX_BYTES]. MainActivity reads the written file through [isPixelsOnly]
 * once more before it hands it to the page.
 */
object JpegCheck {
    /** Far above a 12 megapixel photo at quality 90 (about 4 MB). */
    const val MAX_BYTES: Long = 64L * 1024 * 1024

    private const val SOI = 0xD8
    private const val EOI = 0xD9
    private const val SOS = 0xDA
    private const val COM = 0xFE
    private const val APP14 = 0xEE

    /** Tables copied as they are: DQT, DHT and DRI. */
    private val TABLES = setOf(0xDB, 0xC4, 0xDD)

    /** Frame headers accepted: baseline, extended sequential and progressive, Huffman coded. */
    private val FRAMES = setOf(0xC0, 0xC1, 0xC2)

    private val ADOBE = "Adobe".toByteArray(Charsets.US_ASCII)

    /** True when [input] is one whole JPEG that carries only what draws the picture. */
    fun isPixelsOnly(input: InputStream, maxBytes: Long = MAX_BYTES): Boolean =
        try {
            walk(Reader(input, maxBytes), null, strict = true)
            true
        } catch (_: Exception) {
            false
        }

    /**
     * Checks [input] and writes it to [output] without its application segments and
     * comments. Returns false, with [output] incomplete, when the check fails anywhere.
     */
    fun copyPixelsOnly(input: InputStream, output: OutputStream, maxBytes: Long = MAX_BYTES): Boolean =
        try {
            walk(Reader(input, maxBytes), output, strict = false)
            output.flush()
            true
        } catch (_: Exception) {
            false
        }

    private fun walk(r: Reader, out: OutputStream?, strict: Boolean) {
        require(r.byte() == 0xFF && r.byte() == SOI) { "not a JPEG" }
        out?.write(0xFF)
        out?.write(SOI)
        var frame = false
        var scans = 0
        var pending = -1
        while (true) {
            val marker = if (pending >= 0) pending else nextMarker(r)
            pending = -1
            when {
                marker == EOI -> {
                    require(frame && scans > 0) { "no picture before EOI" }
                    out?.write(0xFF)
                    out?.write(EOI)
                    require(r.read() == -1) { "data after EOI" }
                    return
                }
                marker == SOS -> {
                    require(frame) { "a scan before the frame header" }
                    val payload = segment(r)
                    val components = if (payload.isNotEmpty()) payload[0].toInt() and 0xFF else 0
                    require(components in 1..4 && payload.size == 1 + 2 * components + 3) { "bad scan header" }
                    write(out, marker, payload)
                    pending = copyScan(r, out)
                    scans++
                }
                marker in FRAMES -> {
                    require(!frame) { "a second frame header" }
                    val payload = segment(r)
                    val components = if (payload.size >= 6) payload[5].toInt() and 0xFF else 0
                    require(components in 1..4 && payload.size == 6 + 3 * components) { "bad frame header" }
                    frame = true
                    write(out, marker, payload)
                }
                marker in TABLES -> {
                    val payload = segment(r)
                    require(marker != 0xDD || payload.size == 2) { "bad restart interval" }
                    write(out, marker, payload)
                }
                marker in 0xE0..0xEF -> {
                    val payload = segment(r)
                    require(!(marker == APP14 && startsWith(payload, ADOBE))) { "an Adobe colour transform" }
                    require(!strict) { "an application segment" }
                }
                marker == COM -> {
                    segment(r)
                    require(!strict) { "a comment" }
                }
                else -> throw IllegalArgumentException("marker %02X is not allowed".format(marker))
            }
        }
    }

    /** Reads the next marker between segments: 0xFF, any fill bytes, then the marker. */
    private fun nextMarker(r: Reader): Int {
        require(r.byte() == 0xFF) { "expected a marker" }
        var m = r.byte()
        while (m == 0xFF) m = r.byte()
        return m
    }

    /** A segment's payload, after its 2-byte length. */
    private fun segment(r: Reader): ByteArray {
        val length = (r.byte() shl 8) or r.byte()
        require(length >= 2) { "segment length under 2" }
        val payload = ByteArray(length - 2)
        r.readFully(payload)
        return payload
    }

    private fun write(out: OutputStream?, marker: Int, payload: ByteArray) {
        if (out == null) return
        val length = payload.size + 2
        out.write(0xFF)
        out.write(marker)
        out.write(length shr 8)
        out.write(length and 0xFF)
        out.write(payload)
    }

    /**
     * Copies a scan's entropy-coded data, stuffed bytes (FF 00) and restart markers (FF D0
     * to FF D7) included, and returns the marker that ends it. Fill bytes before that
     * marker are not copied.
     */
    private fun copyScan(r: Reader, out: OutputStream?): Int {
        while (true) {
            val b = r.byte()
            if (b != 0xFF) {
                out?.write(b)
                continue
            }
            var m = r.byte()
            while (m == 0xFF) m = r.byte()
            if (m == 0x00 || m in 0xD0..0xD7) {
                out?.write(0xFF)
                out?.write(m)
            } else {
                return m
            }
        }
    }

    private fun startsWith(data: ByteArray, prefix: ByteArray): Boolean =
        data.size >= prefix.size && prefix.indices.all { data[it] == prefix[it] }

    /** A buffered reader that counts every byte and refuses more than [max]. */
    private class Reader(private val input: InputStream, private val max: Long) {
        private val buf = ByteArray(64 * 1024)
        private var pos = 0
        private var end = 0
        private var count = 0L

        fun read(): Int {
            if (pos == end) {
                end = input.read(buf, 0, buf.size)
                pos = 0
                if (end <= 0) {
                    end = 0
                    return -1
                }
            }
            count++
            require(count <= max) { "too large" }
            return buf[pos++].toInt() and 0xFF
        }

        fun byte(): Int {
            val b = read()
            require(b >= 0) { "cut short" }
            return b
        }

        fun readFully(target: ByteArray) {
            var n = 0
            while (n < target.size) {
                if (pos == end) {
                    end = input.read(buf, 0, buf.size)
                    pos = 0
                    if (end <= 0) {
                        end = 0
                        throw IllegalArgumentException("cut short")
                    }
                }
                val take = minOf(end - pos, target.size - n)
                count += take
                require(count <= max) { "too large" }
                System.arraycopy(buf, pos, target, n, take)
                pos += take
                n += take
            }
        }
    }
}
