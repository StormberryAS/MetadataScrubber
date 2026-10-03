import java.io.File
import java.io.FileInputStream
import java.nio.file.Files
import java.util.Properties
import javax.inject.Inject

plugins {
    alias(libs.plugins.android.application)
}

// Signing credentials never live in this repo. android/keystore.properties (gitignored)
// names the key file, its type and the alias, and deliberately holds NO passwords: those
// come from the RELEASE_STORE_PASSWORD and RELEASE_KEY_PASSWORD Gradle properties, which
// Gradle also reads from ORG_GRADLE_PROJECT_* env vars (CI) and which a local build passes
// as env vars read from the keyring. Missing credentials must not break assembleDebug, so
// everything below is optional.
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) FileInputStream(keystorePropertiesFile).use { load(it) }
}

fun signingValue(propKey: String, gradleKey: String): String? =
    keystoreProperties.getProperty(propKey)
        ?: providers.gradleProperty(gradleKey).orNull
        ?: providers.environmentVariable(gradleKey).orNull

val releaseStoreFile = signingValue("storeFile", "RELEASE_STORE_FILE")
val releaseStoreType = signingValue("storeType", "RELEASE_STORE_TYPE")
val releaseStorePassword = signingValue("storePassword", "RELEASE_STORE_PASSWORD")
val releaseKeyAlias = signingValue("keyAlias", "RELEASE_KEY_ALIAS")
val releaseKeyPassword = signingValue("keyPassword", "RELEASE_KEY_PASSWORD")
val canSignRelease = releaseStoreFile != null && file(releaseStoreFile).exists() &&
    releaseStorePassword != null && releaseKeyAlias != null && releaseKeyPassword != null

// The passwords are read while Gradle configures the build, and gradle.properties turns the
// configuration cache on. A cached configuration stores those values (encrypted) under
// android/.gradle/configuration-cache, which breaks the rule that the password is never
// written anywhere. So the build refuses to configure, before any cache entry exists,
// whenever a password is set and the cache is in use.
abstract class BuildFeaturesHolder @Inject constructor(val features: org.gradle.api.configuration.BuildFeatures)

val configurationCacheRequested =
    objects.newInstance<BuildFeaturesHolder>().features.configurationCache.requested.getOrElse(false)
if (configurationCacheRequested && (releaseStorePassword != null || releaseKeyPassword != null)) {
    error(
        "Release signing passwords are set, so this build must run with " +
            "--no-configuration-cache; otherwise Gradle would store them in its configuration cache.",
    )
}

// A release task that would silently produce an UNSIGNED apk is refused outright. An
// unsigned app-release-unsigned.apk next to a signed one from an earlier run is exactly the
// kind of mix-up that ends with the wrong file uploaded.
tasks.matching { it.name == "packageRelease" }.configureEach {
    val signed = canSignRelease
    doFirst {
        if (!signed) {
            error(
                "Release signing is not configured. Set RELEASE_STORE_PASSWORD and " +
                    "RELEASE_KEY_PASSWORD (see android/keystore.properties) or the CI " +
                    "ORG_GRADLE_PROJECT_RELEASE_* variables. Use assembleDebug for a test build.",
            )
        }
    }
}

android {
    namespace = "no.stormberry.metadatascrubber"
    // compileSdk 37.1 because androidx core-ktx 1.19.0 requires compiling against API 37 or
    // later. targetSdk stays at 36; the two are deliberately independent.
    compileSdk = 37
    compileSdkMinor = 1

    defaultConfig {
        applicationId = "no.stormberry.metadatascrubber"
        minSdk = 24
        targetSdk = 36
        // 0.0.1 (code 1): the first release, published to Zapstore as an early version (Marcos, 2026-10-03).
        // 0.0.2 (code 2): details in collapsed Red, Amber and Green sections, red and amber ticked to start, the result button reads "Save <name>" (2026-10-03).
        versionCode = 2
        versionName = "0.0.2"

        // Density PNGs generated from vectors are a source of build nondeterminism, and the
        // app ships vector icons only.
        vectorDrawables.generatedDensities()
    }

    signingConfigs {
        if (canSignRelease) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                if (releaseStoreType != null) storeType = releaseStoreType
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                // Pinned explicitly so an AGP upgrade cannot change what the APK carries.
                // minSdk 24 makes v1 JAR signing dead weight; v2 covers 7.0+, v3 allows key
                // rotation later.
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = false
            }
        }
    }

    buildTypes {
        release {
            // R8 is on. The app reaches nothing by reflection itself: the page talks to
            // Kotlin through WebViewCompat.addWebMessageListener, so there is no
            // @JavascriptInterface class for R8 to strip, and androidx.webkit and
            // androidx.core ship their own consumer keep rules for the WebView boundary
            // interfaces and FileProvider. See proguard-rules.pro.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (canSignRelease) signingConfig = signingConfigs.getByName("release")
            // No META-INF/version-control-info.textproto. The gradle.properties switch alone
            // did not stop AGP writing it, and once AGP finds the repository it would carry
            // the commit hash, which differs per checkout.
            vcsInfo {
                include = false
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        buildConfig = false
        resValues = false
        shaders = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources {
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "DebugProbesKt.bin",
                "kotlin-tooling-metadata.json",
            )
        }
    }

    androidResources {
        // The fonts are already compressed (woff2) and the page reads every file through
        // the asset loader; leaving them stored keeps the copy byte-identical and cheap to open.
        noCompress += listOf("woff2", "png")
    }

    dependenciesInfo {
        // Strips the encrypted, non-reproducible dependency blob from the APK.
        includeInApk = false
        includeInBundle = false
    }

    lint {
        warningsAsErrors = true
        abortOnError = true
        disable += setOf(
            // Version bumps are a deliberate, reviewed act, not something lint should fail on.
            "GradleDependency",
            "AndroidGradlePluginVersion",
            "ObsoleteLintCustomCheck",
            "NewerVersionAvailable",
            // targetSdk 36 is intentional; compileSdk is already 37.1.
            "OldTargetApi",
        )
    }

    testOptions {
        unitTests.isReturnDefaultValues = false
    }
}

kotlin {
    // The JDK that compiles is pinned to 21, the one the release workflow installs, so a
    // rebuild from a tag uses the same compiler. Bytecode stays at 17.
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// =====================================================================================
// THE WEB APP, COPIED AT BUILD TIME
//
// The APK runs the same files that GitHub Pages serves at metadata.stormberry.as. They are
// never committed twice: this task copies them from the repository root into generated
// assets on every build, then a check task proves the copy is byte-identical to its source.
// The ONE permitted difference is a single line in index.html that loads
// android-bridge.js (android/web-overlay/) before gate.js and the app module.
//
// Logic lives in an `object` so the task actions capture no reference to this script,
// which keeps the configuration cache working.
// =====================================================================================

object WebAssets {
    const val INJECTED_TAG = "<script src=\"android-bridge.js\"></script>"
    const val BRIDGE_FILE = "android-bridge.js"

    // Every type the asset loader in the app knows how to serve. Anything else found in the
    // web root fails the build, so a stray file cannot slip into the APK unnoticed.
    val ALLOWED_EXTENSIONS = setOf("html", "js", "css", "svg", "png", "woff2", "md", "txt")

    // Jekyll never publishes these, whatever _config.yml says.
    val JEKYLL_DEFAULT_EXCLUDES = listOf("**/.*", "**/.*/**", "**/_*", "**/_*/**", "**/#*", "**/*~")

    // Repository files that are not part of the web app. Some are already in _config.yml's
    // exclude list; repeating them here keeps the APK correct even if that list changes.
    val APK_EXCLUDES = listOf(
        "android/**", "fastlane/**", "tests/**", ".github/**", "zapstore.yaml", "CNAME",
        "README*", "LICENSE", "NOTICE", "bump_assets.py", "node_modules/**",
        "**/__pycache__/**", "**/*.pyc", "**/*.bak*", "**/.DS_Store", "package.json",
        "package-lock.json", "Gemfile", "Gemfile.lock",
    )

    /** The `exclude:` list from Jekyll's _config.yml, as Ant patterns. */
    fun configExcludes(configFile: File): List<String> {
        if (!configFile.isFile) return emptyList()
        val out = mutableListOf<String>()
        var inList = false
        for (raw in configFile.readLines()) {
            val line = raw.substringBefore(" #").trimEnd()
            if (line.isBlank() || line.trimStart().startsWith("#")) continue
            if (!line.startsWith(" ") && !line.startsWith("-")) {
                inList = line.trim() == "exclude:"
                continue
            }
            if (!inList) continue
            val item = Regex("^\\s*-\\s*(.+)$").find(line)?.groupValues?.get(1)?.trim()?.trim('"', '\'')
                ?: continue
            if (item.endsWith("/")) out.add("${item}**") else out.addAll(listOf(item, "$item/**"))
        }
        return out
    }

    fun allExcludes(webRoot: File): List<String> =
        JEKYLL_DEFAULT_EXCLUDES + APK_EXCLUDES + configExcludes(File(webRoot, "_config.yml"))

    /** Runs git in [dir] and returns its standard output; fails with git's own message. */
    fun git(dir: File, vararg args: String): ByteArray {
        val process = try {
            ProcessBuilder(listOf("git", "-C", dir.path) + args).start()
        } catch (e: java.io.IOException) {
            error("git is needed to build the app, because the bundled web files are checked against the repository: ${e.message}")
        }
        process.outputStream.close()
        var err = ByteArray(0)
        val errReader = Thread { err = process.errorStream.readBytes() }.apply { start() }
        val out = process.inputStream.readBytes()
        val code = process.waitFor()
        errReader.join()
        if (code != 0) {
            error("git ${args.joinToString(" ")} failed (exit $code): ${String(err, Charsets.UTF_8).trim()}")
        }
        return out
    }

    /** Every path git tracks under [root], relative to it, with forward slashes. */
    fun trackedFiles(root: File): Set<String> =
        String(git(root, "ls-files", "-z", "--cached", "--", "."), Charsets.UTF_8)
            .split('\u0000').filter { it.isNotEmpty() }.toSet()

    /** The bytes of [rel] in the commit HEAD points at, or null if HEAD has no such file. */
    fun committedBytes(root: File, rel: String): ByteArray? {
        val spec = "HEAD:./$rel" // ./ makes the path relative to the web root, not the repository top
        val type = try {
            String(git(root, "cat-file", "-t", spec), Charsets.UTF_8).trim()
        } catch (_: IllegalStateException) {
            return null
        }
        if (type != "blob") return null
        return git(root, "cat-file", "blob", spec)
    }

    /** True when [rel] or any folder on the way to it under [root] is a symbolic link. */
    fun throughSymlink(root: File, rel: String): Boolean {
        var f = root
        for (part in rel.split('/')) {
            f = File(f, part)
            if (Files.isSymbolicLink(f.toPath())) return true
        }
        return false
    }

    /**
     * The copied index.html with the injected line taken out again, or a description of
     * what is wrong with the injection.
     */
    fun removeInjected(text: String): Result<String> {
        val count = Regex(Regex.escape(INJECTED_TAG)).findAll(text).count()
        if (count != 1) return Result.failure(IllegalStateException("expected the bridge tag exactly once, found $count"))
        val at = text.indexOf(INJECTED_TAG)
        val lineStart = text.lastIndexOf('\n', at) + 1
        val lineEnd = text.indexOf('\n', at)
        if (lineEnd < 0 || text.substring(lineStart, at).isNotBlank() ||
            text.substring(at + INJECTED_TAG.length, lineEnd).isNotEmpty()
        ) {
            return Result.failure(IllegalStateException("the bridge tag is not alone on its own line"))
        }
        return Result.success(text.substring(0, lineStart) + text.substring(lineEnd + 1))
    }

    /** Inserts the bridge tag on its own line directly before the first script tag. */
    fun inject(source: String): String {
        val first = source.indexOf("<script")
        require(first >= 0) { "index.html has no <script> tag to inject the Android bridge before" }
        require(!source.contains(BRIDGE_FILE)) { "index.html already mentions $BRIDGE_FILE" }
        val lineStart = source.lastIndexOf('\n', first) + 1
        val indent = source.substring(lineStart, first)
        require(indent.isBlank()) { "the first <script> in index.html does not start its own line" }
        return source.substring(0, lineStart) + indent + INJECTED_TAG + "\n" + source.substring(lineStart)
    }

    private val HTML_REF = Regex("""(?:src|href)\s*=\s*"([^"]*)"""")
    private val CSS_REF = Regex("""url\(\s*['"]?([^'")]+)['"]?\s*\)""")
    private val JS_FROM = Regex("""(?:^|[;\s])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]""")
    private val JS_BARE = Regex("""(?:^|[;\s])import\s*['"]([^'"]+)['"]""")
    private val JS_DYNAMIC = Regex("""import\s*\(\s*['"]([^'"]+)['"]\s*\)""")

    private val SCHEME = Regex("^[a-z][a-z0-9+.-]*:")

    /** Not a file of the site: a fragment, a protocol-relative address or any scheme
     *  (https:, mailto:, nostr:, data:, and node: built-ins the engine imports only under Node). */
    private fun isExternal(ref: String): Boolean {
        val r = ref.trim().lowercase()
        return r.isEmpty() || r.startsWith("#") || r.startsWith("//") || SCHEME.containsMatchIn(r)
    }

    /** Resolves [ref] found in [from] (path relative to the web root) to a web-root path. */
    private fun resolve(from: String, ref: String): String {
        val clean = ref.substringBefore('#').substringBefore('?')
        val base = if (clean.startsWith("/")) "" else from.substringBeforeLast('/', "")
        val parts = mutableListOf<String>()
        (if (base.isEmpty()) clean else "$base/$clean").split('/').forEach {
            when (it) {
                "", "." -> Unit
                ".." -> require(parts.isNotEmpty()) { "$from references $ref, which climbs out of the web root" }
                    .also { parts.removeAt(parts.size - 1) }
                else -> parts += it
            }
        }
        val joined = parts.joinToString("/")
        return if (joined.isEmpty() || clean.endsWith("/")) (if (joined.isEmpty()) "" else "$joined/") + "index.html" else joined
    }

    /** Every local file the copied site references, checked against what was copied. */
    fun missingReferences(webDir: File): List<String> {
        val missing = sortedSetOf<String>()
        webDir.walkTopDown().filter { it.isFile }.forEach { f ->
            val rel = f.relativeTo(webDir).invariantSeparatorsPath
            val text = when (f.extension) { "html", "css", "js" -> f.readText() else -> return@forEach }
            val refs = mutableListOf<String>()
            if (f.extension == "html" || f.extension == "js") {
                HTML_REF.findAll(text).forEach { refs += it.groupValues[1] }
            }
            if (f.extension == "html" || f.extension == "css") {
                CSS_REF.findAll(text).forEach { refs += it.groupValues[1] }
            }
            if (f.extension == "js") {
                listOf(JS_FROM, JS_BARE, JS_DYNAMIC).forEach { re -> re.findAll(text).forEach { refs += it.groupValues[1] } }
            }
            for (ref in refs) {
                if (isExternal(ref)) continue
                if (f.extension == "js" && !(ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/") ||
                        ref.endsWith(".html"))) {
                    missing += "$rel: bare module specifier '$ref' (there is no bundler)"
                    continue
                }
                val target = resolve(rel, ref)
                if (!File(webDir, target).isFile) missing += "$rel -> $ref (expected $target)"
            }
        }
        return missing.toList()
    }
}

val webRootDir: File = rootProject.projectDir.parentFile
val webOverlayDir: File = rootProject.file("web-overlay")
val webAssetsOutDir = layout.buildDirectory.dir("generated/webAssets")
val webSourceTree = fileTree(webRootDir) { exclude(WebAssets.allExcludes(webRootDir)) }

// The website is what git holds, not whatever sits in this folder. The repository lives in
// a synced notes vault, where a pasted screenshot, a note or a sync-conflict copy can appear
// next to the web files at any time; none of those may reach the APK. This check runs before
// every build: each web file must be tracked by git and must not come in through a symbolic
// link. (It has no outputs, so Gradle never skips it as up to date.)
abstract class CheckWebSourcesTracked : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:Internal
    abstract val webRoot: DirectoryProperty
}

val checkWebSourcesTracked = tasks.register<CheckWebSourcesTracked>("checkWebSourcesTracked") {
    description = "Fails unless every web file the APK would bundle is tracked by git and is not a symbolic link."
    group = "verification"
    sources.from(webSourceTree)
    webRoot.set(webRootDir)
    doLast {
        val root = webRoot.get().asFile
        val tracked = WebAssets.trackedFiles(root)
        val problems = mutableListOf<String>()
        for (f in sources.files) {
            val rel = f.relativeTo(root).invariantSeparatorsPath
            if (WebAssets.throughSymlink(root, rel)) problems += "symbolic link: $rel"
            else if (rel !in tracked) problems += "not tracked by git: $rel"
        }
        if (problems.isNotEmpty()) {
            error(
                "These files in the web root would be bundled into the APK, but they are not part " +
                    "of the website git holds. Commit them, remove them or exclude them in " +
                    "_config.yml:\n  " + problems.sorted().joinToString("\n  "),
            )
        }
    }
}

abstract class PrepareWebAssets : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val overlay: ConfigurableFileCollection

    @get:Internal
    abstract val webRoot: DirectoryProperty

    @get:Internal
    abstract val overlayRoot: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty
}

val prepareWebAssets = tasks.register<PrepareWebAssets>("prepareWebAssets") {
    description = "Copies the web app from the repository root into generated assets and injects the Android bridge."
    group = "build"
    sources.from(webSourceTree)
    overlay.from(webOverlayDir)
    webRoot.set(webRootDir)
    overlayRoot.set(webOverlayDir)
    outputDir.set(webAssetsOutDir)
    dependsOn(checkWebSourcesTracked)
    doLast {
        val root = webRoot.get().asFile
        val out = outputDir.get().asFile.resolve("web")
        outputDir.get().asFile.deleteRecursively()
        out.mkdirs()
        val unexpected = mutableListOf<String>()
        val files = sources.files.sortedBy { it.relativeTo(root).invariantSeparatorsPath }
        for (src in files) {
            val rel = src.relativeTo(root).invariantSeparatorsPath
            if (src.extension.lowercase() !in WebAssets.ALLOWED_EXTENSIONS) {
                unexpected += rel
                continue
            }
            val dest = out.resolve(rel)
            dest.parentFile.mkdirs()
            if (rel == "index.html") {
                dest.writeText(WebAssets.inject(src.readText()))
            } else {
                src.copyTo(dest, overwrite = false)
            }
        }
        if (unexpected.isNotEmpty()) {
            error(
                "These files in the web root have a type the app does not serve, so they would " +
                    "be published by Pages but break or bloat the APK. Exclude them in " +
                    "_config.yml or remove them:\n  " + unexpected.joinToString("\n  "),
            )
        }
        val bridge = overlayRoot.get().asFile.resolve(WebAssets.BRIDGE_FILE)
        require(bridge.isFile) { "missing ${bridge.path}" }
        val bridgeDest = out.resolve(WebAssets.BRIDGE_FILE)
        require(!bridgeDest.exists()) { "${WebAssets.BRIDGE_FILE} collides with a file of the web app" }
        bridge.copyTo(bridgeDest)

        require(out.resolve("index.html").isFile) { "index.html was not copied; is the web root right? ($root)" }
        val missing = WebAssets.missingReferences(out)
        if (missing.isNotEmpty()) {
            error("The copied web app references files that were not copied:\n  " + missing.joinToString("\n  "))
        }
    }
}

abstract class VerifyWebAssets : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:Internal
    abstract val webRoot: DirectoryProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val bridgeSource: RegularFileProperty

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val copied: DirectoryProperty

    @get:OutputFile
    abstract val report: RegularFileProperty
}

val verifyWebAssets = tasks.register<VerifyWebAssets>("verifyWebAssets") {
    description = "Asserts every bundled web file is byte-identical to its source, except the one injected line in index.html."
    group = "verification"
    sources.from(webSourceTree)
    webRoot.set(webRootDir)
    bridgeSource.set(webOverlayDir.resolve(WebAssets.BRIDGE_FILE))
    copied.set(prepareWebAssets.flatMap { it.outputDir })
    report.set(layout.buildDirectory.file("reports/webAssets/verify.txt"))
    doLast {
        val root = webRoot.get().asFile
        val web = copied.get().asFile.resolve("web")
        val problems = mutableListOf<String>()
        val expected = sources.files.associateBy { it.relativeTo(root).invariantSeparatorsPath }
        val actual = web.walkTopDown().filter { it.isFile }.associateBy { it.relativeTo(web).invariantSeparatorsPath }

        val extra = actual.keys - expected.keys - WebAssets.BRIDGE_FILE
        val absent = expected.keys - actual.keys
        extra.sorted().forEach { problems += "in the APK copy but not in the web root: $it" }
        absent.sorted().forEach { problems += "in the web root but missing from the APK copy: $it" }

        val lines = StringBuilder()
        for ((rel, src) in expected.toSortedMap()) {
            val dst = actual[rel] ?: continue
            if (rel == "index.html") {
                val s = src.readBytes()
                val text = String(dst.readBytes(), Charsets.UTF_8)
                val restored = WebAssets.removeInjected(text).getOrElse {
                    problems += "index.html: ${it.message}"
                    continue
                }
                val at = text.indexOf(WebAssets.INJECTED_TAG)
                if (!restored.toByteArray(Charsets.UTF_8).contentEquals(s)) {
                    problems += "index.html: differs from its source by more than the injected line"
                }
                val gate = text.indexOf("src=\"gate.js")
                val module = text.indexOf("type=\"module\"")
                if (gate < 0 || module < 0 || at > gate || at > module) {
                    problems += "index.html: the bridge must load before gate.js and the app module"
                }
                lines.append("MODIFIED  ").append(rel).append(" (one injected line, otherwise identical)\n")
            } else if (!src.readBytes().contentEquals(dst.readBytes())) {
                problems += "$rel: bytes differ from the source"
            } else {
                lines.append("IDENTICAL ").append(rel).append('\n')
            }
        }
        val bridge = actual[WebAssets.BRIDGE_FILE]
        if (bridge == null || !bridge.readBytes().contentEquals(bridgeSource.get().asFile.readBytes())) {
            problems += "${WebAssets.BRIDGE_FILE}: missing from the copy or differs from android/web-overlay"
        } else {
            lines.append("ADDED     ").append(WebAssets.BRIDGE_FILE).append(" (android/web-overlay)\n")
        }
        if (problems.isNotEmpty()) {
            error("Bundled web app does not match its source:\n  " + problems.joinToString("\n  "))
        }
        val out = report.get().asFile
        out.parentFile.mkdirs()
        out.writeText(lines.toString())
        logger.lifecycle("verifyWebAssets: ${expected.size - 1} web files byte-identical to source, index.html identical apart from the one injected line, android-bridge.js added")
    }
}

// A RELEASE goes one step further: every bundled web file must equal the copy in the
// commit HEAD points at, so a signed APK can only carry what GitHub Pages serves from that
// commit. An uncommitted edit to app.js or src/core/*.js passes a debug build (useful while
// working on the page) but stops a release. index.html is compared after the injected line
// is taken out again; android-bridge.js is Android code and is not part of the website.
abstract class VerifyWebAssetsCommitted : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val copied: DirectoryProperty

    @get:Internal
    abstract val webRoot: DirectoryProperty
}

val verifyWebAssetsCommitted = tasks.register<VerifyWebAssetsCommitted>("verifyWebAssetsCommitted") {
    description = "Asserts every bundled web file equals the committed copy at HEAD (release builds)."
    group = "verification"
    copied.set(prepareWebAssets.flatMap { it.outputDir })
    webRoot.set(webRootDir)
    doLast {
        val root = webRoot.get().asFile
        val web = copied.get().asFile.resolve("web")
        val problems = mutableListOf<String>()
        var count = 0
        web.walkTopDown().filter { it.isFile }.sortedBy { it.path }.forEach { f ->
            val rel = f.relativeTo(web).invariantSeparatorsPath
            if (rel == WebAssets.BRIDGE_FILE) return@forEach
            val committed = WebAssets.committedBytes(root, rel)
            if (committed == null) {
                problems += "$rel: not in the commit HEAD points at"
                return@forEach
            }
            val bundled = if (rel == "index.html") {
                WebAssets.removeInjected(String(f.readBytes(), Charsets.UTF_8)).getOrElse {
                    problems += "index.html: ${it.message}"
                    return@forEach
                }.toByteArray(Charsets.UTF_8)
            } else {
                f.readBytes()
            }
            if (!bundled.contentEquals(committed)) problems += "$rel: differs from the committed copy (uncommitted change?)"
            count++
        }
        if (problems.isNotEmpty()) {
            error(
                "A release must bundle exactly the committed website. Commit or revert these " +
                    "first:\n  " + problems.joinToString("\n  "),
            )
        }
        logger.lifecycle("verifyWebAssetsCommitted: $count web files equal the committed copies at HEAD")
    }
}

// Third-party licences travel inside the APK, under assets/licences/ and outside
// assets/web/, so the byte-identity checks above are not touched. The app's own MIT licence
// is copied from the repository's LICENSE at build time; the Inter and Apache texts live in
// android/licences/. The list of bundled libraries is taken from what the release build
// actually resolves, and the build fails on a library whose licence is not accounted for.
object Licences {
    // Every one of these groups publishes its artefacts under Apache-2.0.
    val APACHE_GROUPS = listOf("androidx.", "org.jetbrains.kotlin", "org.jetbrains.kotlinx", "org.jspecify", "com.google.guava")

    fun isApache(group: String): Boolean =
        APACHE_GROUPS.any { if (it.endsWith(".")) group.startsWith(it) else group == it || group.startsWith("$it.") } ||
            group == "org.jetbrains"
}

abstract class PrepareLicenceAssets : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val texts: ConfigurableFileCollection

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val appLicence: RegularFileProperty

    @get:Input
    abstract val modules: ListProperty<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty
}

val licenceAssetsOutDir = layout.buildDirectory.dir("generated/licenceAssets")

val prepareLicenceAssets = tasks.register<PrepareLicenceAssets>("prepareLicenceAssets") {
    description = "Puts the app's, Inter's and the bundled libraries' licence texts into assets/licences/."
    group = "build"
    texts.from(rootProject.fileTree("licences"))
    appLicence.set(webRootDir.resolve("LICENSE"))
    outputDir.set(licenceAssetsOutDir)
    doLast {
        val out = outputDir.get().asFile.resolve("licences")
        outputDir.get().asFile.deleteRecursively()
        out.mkdirs()
        texts.files.sortedBy { it.name }.forEach { it.copyTo(out.resolve(it.name)) }
        appLicence.get().asFile.copyTo(out.resolve("MetadataScrubber-MIT.txt"))
        val mods = modules.get()
        val unknown = mods.filter { !Licences.isApache(it.substringBefore(':')) }
        if (unknown.isNotEmpty()) {
            error(
                "These bundled libraries have no licence on record in assets/licences/. Check " +
                    "their licences and extend Licences in app/build.gradle.kts:\n  " + unknown.joinToString("\n  "),
            )
        }
        require(mods.isNotEmpty()) { "the release runtime classpath resolved to no libraries" }
        out.resolve("THIRD-PARTY.txt").writeText(
            buildString {
                append("MetadataScrubber for Android: third-party components\n\n")
                append("Inter typeface (fonts/inter/ in the bundled web app)\n")
                append("  Copyright (c) 2016 The Inter Project Authors\n")
                append("  SIL Open Font License 1.1, full text in Inter-OFL-1.1.txt\n\n")
                append("The release build depends on the libraries below, all licensed under\n")
                append("the Apache License, Version 2.0, full text in Apache-2.0.txt. R8 leaves\n")
                append("out the parts the app does not use, so some of them add no code at all.\n\n")
                mods.forEach { append("  ").append(it).append('\n') }
                append("\nThe app itself: MIT licence, in MetadataScrubber-MIT.txt.\n")
            },
        )
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(prepareWebAssets, PrepareWebAssets::outputDir)
        variant.sources.assets?.addGeneratedSourceDirectory(prepareLicenceAssets, PrepareLicenceAssets::outputDir)
        if (variant.name == "release") {
            val resolved = variant.runtimeConfiguration.incoming.resolutionResult.rootComponent.map { rootComponent ->
                val seen = sortedSetOf<String>()
                val queue = ArrayDeque(listOf(rootComponent))
                val visited = mutableSetOf<org.gradle.api.artifacts.component.ComponentIdentifier>()
                while (queue.isNotEmpty()) {
                    val c = queue.removeFirst()
                    if (!visited.add(c.id)) continue
                    (c.id as? org.gradle.api.artifacts.component.ModuleComponentIdentifier)?.let {
                        seen += "${it.group}:${it.module}:${it.version}"
                    }
                    c.dependencies.filterIsInstance<org.gradle.api.artifacts.result.ResolvedDependencyResult>()
                        .forEach { queue.addLast(it.selected) }
                }
                seen.toList()
            }
            prepareLicenceAssets.configure { modules.set(resolved) }
        }
    }
}

// Every build that produces an APK proves the copy first, and so does `check`. A release
// also proves the copy matches the committed website.
tasks.named("preBuild") { dependsOn(verifyWebAssets) }
tasks.named("check") { dependsOn(verifyWebAssets) }
tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(verifyWebAssetsCommitted) }

dependencies {
    testImplementation(libs.junit)

    implementation(libs.androidx.activity)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.webkit)
}
