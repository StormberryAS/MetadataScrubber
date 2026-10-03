package no.stormberry.metadatascrubber

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AssetPathsTest {
    @Test fun plainPathsMapIntoTheWebFolder() {
        assertEquals("web/index.html", AssetPaths.resolve(""))
        assertEquals("web/index.html", AssetPaths.resolve("index.html"))
        assertEquals("web/src/core/jpeg.js", AssetPaths.resolve("src/core/jpeg.js"))
        assertEquals("web/switcher-icons/sun.svg", AssetPaths.resolve("switcher-icons/sun.svg"))
        assertEquals("web/fonts/inter/index.html", AssetPaths.resolve("fonts/inter/"))
    }

    @Test fun nothingClimbsOutOrReachesHiddenFiles() {
        assertNull(AssetPaths.resolve("../AndroidManifest.xml"))
        assertNull(AssetPaths.resolve("src/../../x.js"))
        assertNull(AssetPaths.resolve("./index.html"))
        assertNull(AssetPaths.resolve("/index.html"))
        assertNull(AssetPaths.resolve("src//core.js"))
        assertNull(AssetPaths.resolve("a\\b.js"))
        assertNull(AssetPaths.resolve(".git/config.txt"))
        assertNull(AssetPaths.resolve(null))
    }

    @Test fun onlyKnownTypesAreServed() {
        assertNull(AssetPaths.resolve("app.json"))
        assertNull(AssetPaths.resolve("dexopt/baseline.prof"))
        assertNull(AssetPaths.resolve("README"))
    }

    @Test fun contentTypes() {
        assertEquals("text/javascript", AssetPaths.mimeType("web/app.js"))
        assertEquals("text/html", AssetPaths.mimeType("web/index.html"))
        assertEquals("text/css", AssetPaths.mimeType("web/style.css"))
        assertEquals("image/svg+xml", AssetPaths.mimeType("web/favicon.svg"))
        assertEquals("font/woff2", AssetPaths.mimeType("web/fonts/inter/InterVariable.woff2"))
        assertEquals("utf-8", AssetPaths.encoding("web/app.js"))
        assertNull(AssetPaths.encoding("web/og-image.png"))
    }
}
