package no.stormberry.metadatascrubber

import android.content.res.AssetManager
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * Serves the bundled web app from assets/web/ at https://appassets.androidplatform.net/.
 *
 * Registered at "/" rather than the usual "/assets/", because the page refers to some
 * files from the site root (the app switcher's /switcher-icons/...), exactly as it does on
 * metadata.stormberry.as. AssetPaths decides what may be served; anything else is a 404.
 */
class WebAssetHandler(private val assets: AssetManager) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse {
        val assetPath = AssetPaths.resolve(path) ?: return notFound()
        val mime = AssetPaths.mimeType(assetPath) ?: return notFound()
        return try {
            WebResourceResponse(mime, AssetPaths.encoding(assetPath), 200, "OK", HEADERS, assets.open(assetPath))
        } catch (_: IOException) {
            notFound()
        }
    }

    companion object {
        private val HEADERS = mapOf(
            "X-Content-Type-Options" to "nosniff",
            "Cache-Control" to "no-store",
        )

        fun notFound(): WebResourceResponse = empty(404, "Not Found")

        /** The answer to every request outside the app's own origin. */
        fun forbidden(): WebResourceResponse = empty(403, "Forbidden")

        private fun empty(code: Int, reason: String) =
            WebResourceResponse("text/plain", "utf-8", code, reason, HEADERS, ByteArrayInputStream(ByteArray(0)))
    }
}
