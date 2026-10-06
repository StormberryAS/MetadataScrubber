package no.stormberry.metadatascrubber

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.zip.CRC32

/**
 * Makes sure a PNG for the clipboard carries pixels only. Pure Kotlin, unit tested on the
 * JVM.
 *
 * The page draws the picture on a canvas and hands over the PNG the canvas makes. The app
 * does not take that on trust: before the file goes on Android's clipboard, every chunk is
 * read and its checksum checked, and only the chunks that hold or describe the pixels are
 * accepted. Text (tEXt, zTXt, iTXt), EXIF (eXIf), a time stamp (tIME), a colour profile
 * (iCCP, which can carry text), private chunks and anything after IEND make the copy fail
 * rather than leak. Android's WebView also writes an sRGB chunk, which desktop Chromium
 * does not; [copyPixelsOnly] leaves out that and the other drawing hints ([HINTS]), so the
 * clipboard gets the same as on the website: a PNG with no metadata at all.
 */
object PngCheck {
    private val SIGNATURE = byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)

    /** The chunks that hold the pixels; the only ones written out. */
    val KEEP = setOf("IHDR", "PLTE", "tRNS", "IDAT", "IEND")

    /** Drawing hints a canvas may add: accepted on the way in, never written out. */
    val HINTS = setOf("sRGB", "gAMA", "cHRM", "pHYs", "sBIT", "bKGD")

    /** True when [input] is one whole PNG of [KEEP] and [HINTS] chunks only, with good checksums. */
    fun isPixelsOnly(input: InputStream, maxBytes: Long = OutgoingRequest.MAX_BYTES): Boolean =
        try {
            walk(input, null, maxBytes)
            true
        } catch (_: Exception) {
            false
        }

    /**
     * Checks [input] as [isPixelsOnly] does and writes the [KEEP] chunks, unchanged, to
     * [output]. Returns false, with [output] incomplete, when the check fails anywhere.
     */
    fun copyPixelsOnly(input: InputStream, output: OutputStream, maxBytes: Long = OutgoingRequest.MAX_BYTES): Boolean =
        try {
            walk(input, DataOutputStream(output), maxBytes)
            output.flush()
            true
        } catch (_: Exception) {
            false
        }

    private fun walk(input: InputStream, out: DataOutputStream?, maxBytes: Long) {
        val d = DataInputStream(input)
        val sig = ByteArray(8)
        d.readFully(sig)
        require(sig.contentEquals(SIGNATURE)) { "not a PNG" }
        out?.write(SIGNATURE)
        var total = 8L
        var first = true
        val buf = ByteArray(64 * 1024)
        while (true) {
            val length = d.readInt().toLong() and 0xFFFFFFFFL
            require(length <= 0x7FFFFFFFL) { "chunk too long" }
            total += 12 + length
            require(total <= maxBytes) { "too large" }
            val typeBytes = ByteArray(4)
            d.readFully(typeBytes)
            val type = String(typeBytes, Charsets.US_ASCII)
            require(type in KEEP || type in HINTS) { "chunk $type is not allowed" }
            require(!first || type == "IHDR") { "IHDR must come first" }
            require(type != "IHDR" || (first && length == 13L)) { "bad IHDR" }
            first = false
            val keep = out != null && type in KEEP
            if (keep) {
                out!!.writeInt(length.toInt())
                out.write(typeBytes)
            }
            val crc = CRC32()
            crc.update(typeBytes)
            var left = length
            while (left > 0) {
                val n = minOf(left, buf.size.toLong()).toInt()
                d.readFully(buf, 0, n)
                crc.update(buf, 0, n)
                if (keep) out!!.write(buf, 0, n)
                left -= n
            }
            val stored = d.readInt()
            require((stored.toLong() and 0xFFFFFFFFL) == crc.value) { "bad checksum in $type" }
            if (keep) out!!.writeInt(stored)
            if (type == "IEND") {
                require(length == 0L) { "bad IEND" }
                require(d.read() == -1) { "data after IEND" }
                return
            }
        }
    }
}
