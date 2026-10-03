package no.stormberry.metadatascrubber

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import kotlin.io.encoding.Base64
import kotlin.random.Random

class ChunkAssemblerTest {
    private val chunk = ChunkAssembler.CHUNK_BYTES

    private fun split(bytes: ByteArray): List<ByteArray> =
        (bytes.indices step chunk).map { bytes.copyOfRange(it, minOf(it + chunk, bytes.size)) }

    @Test fun reassemblesA30MegabyteFileThroughBase64() {
        val original = Random(42).nextBytes(30 * 1024 * 1024 + 123)
        val parts = split(original)
        val sink = ByteArrayOutputStream()
        val a = ChunkAssembler(original.size.toLong(), parts.size, sink)
        // Exactly as the bridge does it: base64 text across the WebView boundary.
        parts.forEachIndexed { i, p ->
            assertEquals(i, a.next)
            a.append(i, Base64.decode(Base64.encode(p)))
        }
        assertNull(a.next)
        assertTrue(a.isComplete)
        a.finish()
        assertArrayEquals(original, sink.toByteArray())
    }

    @Test fun singleChunk() {
        val sink = ByteArrayOutputStream()
        val a = ChunkAssembler(3, 1, sink)
        a.append(0, byteArrayOf(1, 2, 3))
        a.finish()
        assertArrayEquals(byteArrayOf(1, 2, 3), sink.toByteArray())
    }

    @Test(expected = IllegalArgumentException::class)
    fun outOfOrderChunksAreRefused() {
        val a = ChunkAssembler(6, 2, ByteArrayOutputStream())
        a.append(1, byteArrayOf(1, 2, 3))
    }

    @Test(expected = IllegalArgumentException::class)
    fun repeatedChunksAreRefused() {
        val a = ChunkAssembler(6, 2, ByteArrayOutputStream())
        a.append(0, byteArrayOf(1, 2, 3))
        a.append(0, byteArrayOf(1, 2, 3))
    }

    @Test(expected = IllegalArgumentException::class)
    fun overrunningTheAnnouncedSizeIsRefused() {
        val a = ChunkAssembler(4, 2, ByteArrayOutputStream())
        a.append(0, byteArrayOf(1, 2, 3))
        a.append(1, byteArrayOf(4, 5))
    }

    @Test(expected = IllegalStateException::class)
    fun aShortFileIsNotFinished() {
        val a = ChunkAssembler(6, 2, ByteArrayOutputStream())
        a.append(0, byteArrayOf(1, 2, 3))
        assertFalse(a.isComplete)
        a.finish()
    }

    @Test(expected = IllegalStateException::class)
    fun fewerBytesThanAnnouncedIsNotFinished() {
        val a = ChunkAssembler(10, 2, ByteArrayOutputStream())
        a.append(0, byteArrayOf(1, 2, 3))
        a.append(1, byteArrayOf(4))
        a.finish()
    }

    @Test(expected = IllegalArgumentException::class)
    fun oversizedAnnouncementsAreRefused() {
        ChunkAssembler(ChunkAssembler.DEFAULT_MAX_BYTES + 1, 1, ByteArrayOutputStream())
    }

    @Test(expected = IllegalArgumentException::class)
    fun inconsistentAnnouncementsAreRefused() {
        ChunkAssembler(0, 3, ByteArrayOutputStream())
    }

    @Test(expected = IllegalArgumentException::class)
    fun emptyChunksAreRefused() {
        ChunkAssembler(3, 1, ByteArrayOutputStream()).append(0, ByteArray(0))
    }
}
