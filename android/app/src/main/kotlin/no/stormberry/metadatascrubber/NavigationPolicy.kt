package no.stormberry.metadatascrubber

import java.net.URI

/**
 * Decides what happens to every navigation and request the WebView makes. Pure Kotlin on
 * java.net.URI, so it is unit tested on the JVM.
 *
 *  - The bundled app lives at https://appassets.androidplatform.net/ and loads in place.
 *  - Any other http or https address (stormberry.as, the other Labs apps) opens in the
 *    user's browser; the WebView stays where it is.
 *  - mailto: and nostr: addresses (the disclaimer's contact link, the footer's Nostr link)
 *    go to whichever app on the device handles them, as they would from the website.
 *    This is an allowlist of two schemes, not a door for every scheme.
 *  - Everything else (javascript:, intent:, file:, content:, data:, blob:, market: and
 *    any address that does not parse cleanly) is refused.
 */
object NavigationPolicy {
    const val ASSET_HOST = "appassets.androidplatform.net"
    const val ASSET_ORIGIN = "https://$ASSET_HOST"

    enum class Decision { IN_APP, EXTERNAL, EXTERNAL_APP, BLOCK }

    /** Schemes handed to another app on the device, with no browser involved. */
    val APP_SCHEMES = setOf("mailto", "nostr")

    fun decide(url: String?): Decision {
        val uri = parse(url) ?: return Decision.BLOCK
        val scheme = uri.scheme?.lowercase() ?: return Decision.BLOCK
        if (scheme in APP_SCHEMES) {
            // Only the plain form, mailto:x@y or nostr:npub1..., never mailto://... tricks.
            val rest = uri.rawSchemeSpecificPart
            return if (uri.isOpaque && !rest.isNullOrBlank() && !rest.startsWith("/")) Decision.EXTERNAL_APP else Decision.BLOCK
        }
        val host = uri.host?.lowercase()
        if (scheme != "http" && scheme != "https") return Decision.BLOCK
        if (host.isNullOrEmpty() || uri.rawUserInfo != null) return Decision.BLOCK
        if (host == ASSET_HOST) {
            return if (scheme == "https" && (uri.port == -1 || uri.port == 443)) Decision.IN_APP else Decision.BLOCK
        }
        return Decision.EXTERNAL
    }

    /** True only for requests the bundled asset loader should answer. */
    fun isAssetRequest(url: String?): Boolean = decide(url) == Decision.IN_APP

    /** True when a message claims to come from the bundled page's origin, and nothing else. */
    fun isAssetOrigin(origin: String?): Boolean {
        val o = origin?.trimEnd('/') ?: return false
        return o == ASSET_ORIGIN || o == "$ASSET_ORIGIN:443"
    }

    private fun parse(url: String?): URI? {
        if (url.isNullOrBlank()) return null
        return try {
            URI(url.trim())
        } catch (_: Exception) {
            null
        }
    }
}
