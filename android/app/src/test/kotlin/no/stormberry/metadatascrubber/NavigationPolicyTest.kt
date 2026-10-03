package no.stormberry.metadatascrubber

import no.stormberry.metadatascrubber.NavigationPolicy.Decision.BLOCK
import no.stormberry.metadatascrubber.NavigationPolicy.Decision.EXTERNAL
import no.stormberry.metadatascrubber.NavigationPolicy.Decision.EXTERNAL_APP
import no.stormberry.metadatascrubber.NavigationPolicy.Decision.IN_APP
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationPolicyTest {
    @Test fun theBundledAppLoadsInPlace() {
        assertEquals(IN_APP, NavigationPolicy.decide("https://appassets.androidplatform.net/index.html"))
        assertEquals(IN_APP, NavigationPolicy.decide("https://appassets.androidplatform.net/"))
        assertEquals(IN_APP, NavigationPolicy.decide("https://appassets.androidplatform.net/disclaimer.html#top"))
        assertEquals(IN_APP, NavigationPolicy.decide("https://APPASSETS.androidplatform.net/app.js?v=1"))
        assertEquals(IN_APP, NavigationPolicy.decide("https://appassets.androidplatform.net:443/index.html"))
    }

    @Test fun theAssetHostIsOnlyTrustedOverHttpsOnItsOwnPort() {
        assertEquals(BLOCK, NavigationPolicy.decide("http://appassets.androidplatform.net/index.html"))
        assertEquals(BLOCK, NavigationPolicy.decide("https://appassets.androidplatform.net:8443/index.html"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://appassets.androidplatform.net.evil.example/"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://evil.example/appassets.androidplatform.net/"))
    }

    @Test fun otherWebAddressesOpenInTheBrowser() {
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://stormberry.as/labs.html"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://username.stormberry.as"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://zapstore.dev/apps/x"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("http://example.com/"))
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://virksomhet.brreg.no/nb/oppslag/enheter/937751249"))
    }

    @Test fun everyOtherSchemeIsRefused() {
        listOf(
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "intent://scan/#Intent;scheme=zxing;package=com.example;end",
            "file:///data/data/no.stormberry.metadatascrubber/shared_prefs/x.xml",
            "content://no.stormberry.metadatascrubber.outgoing/outgoing/a/b.jpg",
            "data:text/html,<script>alert(1)</script>",
            "blob:https://appassets.androidplatform.net/1234",
            "about:blank",
            "ftp://example.com/",
            "market://details?id=x",
        ).forEach { assertEquals(it, BLOCK, NavigationPolicy.decide(it)) }
    }

    @Test fun mailAndNostrLinksGoToAnotherApp() {
        assertEquals(EXTERNAL_APP, NavigationPolicy.decide("mailto:info@stormberry.as"))
        assertEquals(EXTERNAL_APP, NavigationPolicy.decide("MAILTO:info@stormberry.as?subject=Hello"))
        assertEquals(
            EXTERNAL_APP,
            NavigationPolicy.decide("nostr:npub1zz9w77p2jkn95t0st9tcuea8zdn2vknf0ctrwyd4g46w3kswdccqesr0pa"),
        )
    }

    @Test fun mailAndNostrOnlyInTheirPlainForm() {
        assertEquals(BLOCK, NavigationPolicy.decide("mailto:"))
        assertEquals(BLOCK, NavigationPolicy.decide("nostr:"))
        assertEquals(BLOCK, NavigationPolicy.decide("mailto://evil.example/x"))
        assertEquals(BLOCK, NavigationPolicy.decide("nostr:/npub1x"))
        assertEquals(BLOCK, NavigationPolicy.decide("nostr:npub 1x"))
    }

    @Test fun malformedAndDeceptiveAddressesAreRefused() {
        assertEquals(BLOCK, NavigationPolicy.decide(null))
        assertEquals(BLOCK, NavigationPolicy.decide(""))
        assertEquals(BLOCK, NavigationPolicy.decide("   "))
        assertEquals(BLOCK, NavigationPolicy.decide("https://"))
        assertEquals(BLOCK, NavigationPolicy.decide("https:///index.html"))
        assertEquals(BLOCK, NavigationPolicy.decide("https://stormberry.as@evil.example/"))
        assertEquals(BLOCK, NavigationPolicy.decide("https://appassets.androidplatform.net\\@evil.example/"))
        assertEquals(BLOCK, NavigationPolicy.decide("index.html"))
    }

    @Test fun requestsOnlyReachTheAssetLoaderFromTheAssetOrigin() {
        assertTrue(NavigationPolicy.isAssetRequest("https://appassets.androidplatform.net/src/core/jpeg.js?v=1"))
        assertFalse(NavigationPolicy.isAssetRequest("https://metadata.stormberry.as/app.js"))
        assertFalse(NavigationPolicy.isAssetRequest("http://appassets.androidplatform.net/app.js"))
    }

    @Test fun messageOrigins() {
        assertTrue(NavigationPolicy.isAssetOrigin("https://appassets.androidplatform.net"))
        assertTrue(NavigationPolicy.isAssetOrigin("https://appassets.androidplatform.net/"))
        assertFalse(NavigationPolicy.isAssetOrigin("http://appassets.androidplatform.net"))
        assertFalse(NavigationPolicy.isAssetOrigin("https://metadata.stormberry.as"))
        assertFalse(NavigationPolicy.isAssetOrigin("null"))
        assertFalse(NavigationPolicy.isAssetOrigin(null))
    }
}
