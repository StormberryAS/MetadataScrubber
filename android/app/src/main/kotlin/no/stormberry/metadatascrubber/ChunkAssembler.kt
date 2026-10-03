package no.stormberry.metadatascrubber

import java.io.OutputStream

/**
 * Reassembles a file the page sends in numbered chunks. Pure Kotlin, unit tested.
 *
 * The page announces the total size and the number of chunks first, then Kotlin pulls the
 * chunks one at a time, in order. Anything out of order, oversized, or adding up to a
 * different total is an error rather than a silently wrong file.
 */
class ChunkAssembler(
    val expectedSize: Long,
    val chunkCount: Int,
    private val sink: OutputStream,
    private val maxBytes: Long = DEFAULT_MAX_BYTES,
) {
    private var nextIndex = 0
    private var written = 0L
    private var finished = false

    init {
        require(expectedSize in 0..maxBytes) { "size $expectedSize is outside 0..$maxBytes" }
        require(chunkCount >= 0) { "negative chunk count" }
        require((expectedSize == 0L) == (chunkCount == 0)) { "size and chunk count disagree" }
        require(chunkCount.toLong() <= expectedSize.coerceAtLeast(1)) { "more chunks than bytes" }
    }

    /** The index of the chunk to ask for next, or null once all have arrived. */
    val next: Int? get() = if (nextIndex < chunkCount) nextIndex else null

    val isComplete: Boolean get() = nextIndex == chunkCount && written == expectedSize

    fun append(index: Int, bytes: ByteArray) {
        check(!finished) { "already finished" }
        require(index == nextIndex) { "chunk $index arrived, expected $nextIndex" }
        require(bytes.isNotEmpty()) { "empty chunk $index" }
        require(written + bytes.size <= expectedSize) { "chunk $index overruns the announced size" }
        sink.write(bytes)
        written += bytes.size
        nextIndex += 1
    }

    /** Flushes and checks the total. Throws if anything is missing. */
    fun finish() {
        check(!finished) { "already finished" }
        check(nextIndex == chunkCount) { "only $nextIndex of $chunkCount chunks arrived" }
        check(written == expectedSize) { "received $written bytes, announced $expectedSize" }
        sink.flush()
        finished = true
    }

    companion object {
        /** Raw bytes per chunk in both directions. Must match CHUNK in android-bridge.js. */
        const val CHUNK_BYTES = 256 * 1024

        /** Largest file accepted from the page. A 30 MB photo is far inside it. */
        const val DEFAULT_MAX_BYTES: Long = 512L * 1024 * 1024
    }
}
