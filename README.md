# MetadataScrubber

Remove hidden information from photos before you share them, entirely on your device. MetadataScrubber shows what a picture carries besides the picture itself (GPS position, camera serial numbers, owner names, dates, a built-in preview image and more), lets you choose what goes, and then reads the new file back so you can see what is left.

**Live:** [metadata.stormberry.as](https://metadata.stormberry.as)

**Android:** [MetadataScrubber on Zapstore](https://zapstore.dev/apps/no.stormberry.metadatascrubber) (see [Android app](#android-app))

## What it does

- **One column, one button.** The page reads top to bottom on every screen, in the order you work: choose pictures, see your picture and crop it if you like, tick what to remove, set the size, format and name, then press **Prepare picture** (**Prepare pictures** for several). The button does not assume you want metadata removed: you can untick everything and only crop, resize or convert. If nothing would change, the page says so instead of handing you an identical copy.
- **Shows before it removes.** Every detail found in the file is listed with its value, sorted into red, amber and green. In a section that mixes kinds, each detail also names what it reveals: Where, Who, When, Device or Hidden extras; every green detail is technical, so green needs no such word. Only what the file actually contains is shown, and a detail whose value cannot be read says so.
- **Colour tiers guide the choice.** Red means remove before sharing publicly, amber means think about it, green means harmless and useful. Red and amber details are ticked by default; green is not, because it holds rotation and the colour profile, and removing those re-saves many phone photos and can shift colours. Every tier is labelled in words as well as colour. Each colour has its own section with a tick box that ticks or unticks the whole colour and an arrow that shows or hides its details, so you can choose them one by one; every section starts closed.
- **Lossless by default.** Removing metadata touches only the metadata. The picture itself is not decoded or saved again, so its pixels are identical before and after.
- **Crop, resize and convert when you need to.** Crop freely or to 1:1, 4:5, 16:9 or 1.91:1 (the LinkedIn feed image); resize by percentage, to a longest side in pixels, or to a maximum file size for services that cap uploads (1 MB is read as 1,000,000 bytes, and the result aims at 95 per cent of the limit); save as JPEG, PNG or WebP. These re-save the picture, and the page says so before you press the button. Only the EXIF details you keep are written back into the new file, and the read-back shows exactly what made it.
- **Rotation stays right.** If you remove a rotation setting that is not "normal", the picture is turned the right way up in its pixels and re-saved, and the page tells you. If the rotation is already normal, removing it keeps the file lossless.
- **Reads the result back.** After scrubbing, the new file is read again and the list shows what remains in it. Trust comes from showing, not from claiming.
- **Nothing travels along unseen.** Every part of the file is either needed to show the picture or offered in the list. Parts the engine cannot read or does not recognise (stray bytes, a damaged or cut-off end, unknown fields, leftover bytes an earlier editor left behind, comments hidden inside XMP) are listed as red details, so they go by default and the read-back would show them if they stayed.
- **Neutral file names.** Phone file names such as `PXL_20261001_101523123.jpg` carry the date, the time and the phone brand, so the original name is never reused. Saved files are named `[name].[tier].[ext]`, for example `image.minimal.jpg`, where the tier word says how much was removed: `public`, `minimal`, `clean` or `custom`.

## Supported formats

| Format | Read and remove metadata | Crop, resize, convert | Notes |
|---|---|---|---|
| JPEG | Yes | Yes | EXIF, XMP, IPTC, ICC profile, comments, Content Credentials (C2PA), data after the end of the image |
| PNG | Yes | Yes | EXIF, text chunks, ICC profile. A smaller file size can only come from fewer pixels |
| WebP | Yes | Yes | EXIF, XMP, ICC profile. Saving as WebP is offered only where the browser can encode it |
| HEIC | Yes | Only where the browser can open HEIC (Safari) | Removal works without decoding the picture. A re-saved HEIC becomes a JPEG |

## How details are tiered

The spec's rule: red is removed by default and covers location, serial numbers, owner and author names, the built-in preview and unique IDs; amber is kept and covers dates, devices, software and edit history; green is technical. Decisions taken while building it:

- **Amber is removed by default too.** The spec kept amber; ticking it to start with gives the `minimal` word without any further choice, and amber can still be unticked as a whole colour or one detail at a time. Green stays unticked, because it holds rotation and the colour profile, and removing those re-saves many phone photos and can shift colours. Amber includes an HDR gain map, which starts ticked too, although it changes how the photo looks rather than who took it. Keeping it to start with waits for an engine change, because a kept gain map today also keeps any extra fields written into its XMP description and some raw bytes that travel with it, which the page cannot show. Untick it and HDR gain map details to keep the photo's brightness on HDR screens; the file then gets the `public` word, and the result says why.
- **Copyright notices and credit lines are red.** They usually name the photographer, and the `public` word promises that names are gone. Untick them if you want them in the shared file.
- **The computer name is red; editing software stays amber.** The name of the computer that saved the file (EXIF `HostComputer`, its XMP copy, or a PNG text field such as `Host Computer`) often contains the owner's name, for example `Astrid-Laptop`, so it is its own detail in the Who group and goes by default. The editing software (EXIF `Software`, XMP `CreatorTool`) only names a program, so it stays amber.
- **Anything unrecognised is red**: unknown EXIF tags, XMP fields in namespaces the engine does not know, unidentified APP segments, chunks and boxes. A field whose name says what it is (for example a drone's `GpsLatitude` or a `CameraSerialNumber` in any namespace) is tiered by that name.
- **Content Credentials (C2PA) are amber**, as the spec says, unless the signed record itself repeats the position, a serial number, a person's name or the computer's name. Then they are red, because keeping them would undo removing those details elsewhere.
- **An HDR gain map is amber**, but the metadata inside it (the gain map is a second, hidden picture) is a separate detail with its own tier. Removing it keeps the gain map and its pixels and clears what it says about the photo. Any other extra picture stored in the file is red.

## What it cannot remove

- Anything visible in the picture: faces, street signs, number plates, reflections, screens.
- The file name you choose for the result.
- A camera's sensor fingerprint, the pattern of tiny flaws that can link photos to one camera.
- Invisible watermarks woven into the pixels.

## Privacy model

- **Local only.** Your photos are read, changed and saved by your own browser. Nothing is uploaded, and there is no server side.
- **Enforced by the browser, not just promised.** The page carries its own Content Security Policy as the first element in `<head>`:

  ```
  default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  font-src 'self'; connect-src 'none'; form-action 'none'; object-src 'none';
  base-uri 'none'; worker-src 'self'
  ```

  `connect-src 'none'` forbids every network request the page could make (fetch, XHR, WebSocket, beacons), and `form-action 'none'` forbids form submissions. The site also sends a wider policy as an HTTP header; browsers enforce both, so the stricter one wins.
- **Disconnect and try it.** Once the page has loaded it fetches nothing else. Turn off your network connection and the app keeps working, which is the simplest public test of the claim.
- **Zero dependencies.** No libraries, no packages, no content delivery network, no analytics, no cookies. Every line of code it runs is in this repository and can be audited. The only third-party item is the Inter typeface, hosted locally (see `NOTICE`).
- **Previews are drawn, not linked.** Pictures are shown on a `<canvas>` from `createImageBitmap()`, because the policy does not allow `blob:` image addresses. The new file is saved through an ordinary download link (`<a download>`), which the policy does not restrict.

## Architecture

- **Vanilla HTML, CSS and JavaScript**, ES modules, no framework and no build step.
- `src/scrub-core.js` is the engine: it detects the format, lists the metadata, removes the chosen details and rebuilds a minimal EXIF block when needed. It has no DOM dependencies, so the same module runs in the browser and under Node for the tests.
- `app.js` is the interface. `gate.js` and `gate.css` are the first-run notice, generated by the estate's shared gate generator. Do not edit them by hand.
- Stormberry dark glassmorphism design system, Inter typography.
- **Sovereign AI**, built and maintained using high-speed agentic workflows.

## Local development

```bash
git clone https://github.com/StormberryAS/MetadataScrubber.git
cd MetadataScrubber
python3 -m http.server 8000
```

Open `http://localhost:8000` in your browser. Use a local server rather than opening `index.html` from disk: browsers refuse to load ES modules from `file://` addresses.

### Running the tests

Everything uses synthetic test images only, never real photos. You need Node 24 or later, `exiftool`, ImageMagick 7 with HEIC and WebP, `python3` with Pillow, Chromium and `openssl`. Run these from the repository root, in this order; the folders under `/tmp` are examples and can be anywhere:

```bash
# 1. Engine tests: every format, with fixtures the tests build themselves (about 25 seconds)
MS_FIXTURE_DIR=/tmp/ms-core-fixtures node --test tests/

# 2. The planted-string corpus in tests/fixtures/out/, used by steps 3 to 5
bash tests/fixtures/make-fixtures.sh

# 3. Privacy audit: tries to prove that metadata survives (about 2 minutes)
MS_AUDIT_DIR=/tmp/ms-audit MS_FIXTURE_DIR=/tmp/ms-core-fixtures node tests/audit.mjs

# 4. Interface smoke test in headless Chromium
node tests/ui-smoke.mjs --out /tmp/ms-ui

# 5. End to end, as on the live site
node tests/e2e.mjs --out /tmp/ms-e2e --keep

# 6. Cache stamps are current
python3 bump_assets.py --check
```

**Engine tests.** Without `MS_FIXTURE_DIR` the fixtures go to the system temporary folder. Each format is checked the same way: the planted details are found with the right tiers, the red details are removed (checked with `exiftool` and by searching the bytes), removing everything leaves only structure, decoded pixels never change, and `exiftool -validate` reports nothing new. The hardening tests cover data hidden in unusual places with hand-built files.

**Privacy audit.** `tests/audit.mjs` is a sceptic's harness and is not run by `node --test`. For every picture in the corpus, every picture the engine tests made (step 1 must have run with the same `MS_FIXTURE_DIR`), and about 40 adversarial pictures that hide data where a scrubber may not look, it works out which detail removes each planted string, scrubs with the starting selection (red and amber ticked, whose read-back must hold only green details), with only the red details ticked (the strictest test for red, since red must go even when amber is kept) and with every detail ticked, and searches the output in plain text, UTF-16, hex, base64 and every zlib stream. On a picture with an HDR gain map it also scrubs with the gain map kept and lists every red planted string that survives as a known engine gap; gaps are reported but do not fail the run, and they are why the gain map starts ticked. It also reads the result back, lists what `exiftool` still sees, compares pixels, checks that HEIC files keep their size and box layout, rebuilds EXIF for re-saved pictures, and runs about 1,500 damaged and malicious files in a worker with a time limit. Options: `--sections=registry,core,adversarial,reencode,hostile` runs some sections, `--fuzz=N` sets the random mutations per file (default 120), and `--no-exiftool` skips the slow `exiftool` steps. It writes `report.txt`, `report.json` and every output file to `MS_AUDIT_DIR`, and exits 1 when there is a critical or high finding.

**Interface smoke test.** It starts its own local server with the production policy, drives a throwaway headless Chromium profile, downloads the new files and checks them with the engine. Use `--chromium <path>` if Chromium is elsewhere than `/usr/bin/chromium`. It also loads the page the way the APK does, with `android-bridge.js` added before the first script and a stand-in for the app's message channel, and checks that the Zapstore section at the foot of the page is hidden and that Save hands the file to the app.

**End-to-end test.** `tests/serve.py` serves the repository over HTTPS with the headers the live zone sends, and only the files GitHub Pages would publish. Chromium then opens the page as `https://metadata.stormberry.as/`, with that name pointed at the local server and every other name made unreachable, so nothing can leave the machine. Each flow starts as a first-time visitor, presses the buttons a person would press, downloads the new file and checks it with the engine, `exiftool`, the planted strings and a pixel comparison. It records every request, console message, exception and policy violation, and saves screenshots at 1280 × 900 and 390 × 844. `--out <folder>` chooses where the report and screenshots go, `--only <flow,flow>` runs some flows, and `--keep` keeps the downloaded files. It exits 0 when everything passes, 1 when the page or the harness fails a check, and 2 when the only failures are in the engine. The `android-app` flow adds the bridge line on the way in, as the APK build does, and checks that the Zapstore section stays hidden while the page works as usual.

To look at the site the same way by hand, run `python3 tests/serve.py` (add `--tls` for HTTPS) and open the address it prints.

### Before committing

Local CSS and JavaScript URLs carry a content hash so that browsers and the Cloudflare cache pick up changes. The engine is loaded as ES modules, so the script also stamps every `import ... from './x.js'` in `app.js` and `src/`, bottom up: a change deep in the engine gives every module that imports it, and the page, a new stamp. Re-stamp after editing any JavaScript or CSS file:

```bash
python3 bump_assets.py          # stamp pages and module imports
python3 bump_assets.py --check  # exits 1 if any page or module is stale
```

## Android app

The Android app (package `no.stormberry.metadatascrubber`) runs **the same files as the website**. There is no second engine: at build time Gradle copies the files GitHub Pages publishes from this repository root into the APK, and the app shows them in a WebView, offline. Each `android-v*` tag runs the release workflow, which publishes `MetadataScrubber-v<version>.apk` on GitHub Releases with a `.sha256` file and a build provenance attestation; the release is then listed on Zapstore with `zsp publish zapstore.yaml`.

### The engine is the website's, byte for byte

- `:app:prepareWebAssets` copies the web files (everything Pages serves, minus `android/`, `fastlane/`, `tests/`, `.github/`, `zapstore.yaml`, `CNAME`, `README.md` and the other entries in `_config.yml`) into generated assets. It fails the build if any file that `index.html`, `disclaimer.html`, the stylesheets or the ES modules refer to is missing from the copy, or if the web root holds a file type the app does not serve.
- `:app:verifyWebAssets` runs before every build and in `check`. It fails unless every bundled file is byte-identical to its source. The one permitted difference is a single line in `index.html`, `<script src="android-bridge.js"></script>`, placed before `gate.js` and the app module. Its report is `android/app/build/reports/webAssets/verify.txt`.
- `:app:checkWebSourcesTracked` runs before every build and fails if a file that would be bundled is not tracked by git or comes in through a symbolic link. The repository sits in a synced notes folder, so a pasted screenshot, a note or a sync-conflict copy next to the web files stops the build instead of shipping.
- `:app:verifyWebAssetsCommitted` runs before every release build and fails unless every bundled file equals its copy in the commit `HEAD` points at (for `index.html`, once the injected line is taken out). An uncommitted edit to the page or the engine is fine for a debug build but stops a release, so a signed APK carries only what Pages serves from that commit.
- `android/web-overlay/android-bridge.js` exists only in the APK. It never fetches anything, so the page's own policy (`connect-src 'none'`) stays intact. It also hides every element of the page marked `data-web-only`, such as the "Get the Android app on Zapstore" section at the foot of the website, so the app does not advertise itself.

### Zero permissions

The APK declares no permissions at all, not even internet access, so the WebView cannot reach the network whatever the page did. Check any APK yourself:

```bash
aapt dump permissions MetadataScrubber-v0.0.2.apk   # the only line is the package name
```

Pictures come in through the system file picker (Storage Access Framework) or a share from another app; both hand over a one-off read grant, so the original bytes, including GPS, are read without a storage permission. Backup is off (`allowBackup="false"`, and both rule files exclude everything). The WebView's metrics reporting and Safe Browsing lookups are switched off in the manifest.

### How sharing works

- **Into the app.** Share one or several JPEG, PNG, WebP or HEIC pictures from a gallery or file manager. Once the first-run notice is dismissed, the app hands them to the page in chunks, the page rebuilds them as files and puts them in its own file input, and the normal flow takes over. Only `content:` addresses are read; `file:` addresses and the app's own files are refused.
- **Out of the app.** The page's Save link is caught by the bridge, which reads the new file in the page and passes it to the app in chunks. The app then offers **Save to a folder** (the system save screen, with the page's name, for example `image.minimal.jpg`) or **Share** (the system share sheet, through a `FileProvider` limited to the app's `cache/outgoing/` folder). A file is deleted from that folder once it has been saved; copies handed to another app stay until the app next starts fresh, so the receiving app can still read them. A second tap on Save while a file is being handed over does nothing, and a short notice says the file is being prepared.
- The bridge is `WebViewCompat.addWebMessageListener`, injected only into pages from the app's own origin, `https://appassets.androidplatform.net`. Tapping a link to any other web address opens it in your browser, and `mailto:` and `nostr:` links go to a mail app or a Nostr client. A link only leaves the app when it was tapped; every other kind of address is refused.

HEIC metadata can be removed in the app, but cropping, resizing and converting a HEIC picture are not available, because Android's web engine cannot open HEIC.

### Build and verify

Requirements: JDK 21 and the Android SDK with platform 37.1. From `android/`:

```bash
./gradlew :app:testDebugUnitTest :app:assembleDebug        # unit tests and a debug APK
./gradlew :app:verifyWebAssets                              # prove the bundled web app matches
```

A signed release needs the release key, which never enters this repository. `android/keystore.properties` (gitignored) names the key file, its type and the alias, and holds no passwords; those come from the environment:

```bash
RELEASE_STORE_PASSWORD="$(secret-tool lookup service android-keystore app metadatascrubber)" \
RELEASE_KEY_PASSWORD="$RELEASE_STORE_PASSWORD" \
./gradlew --no-configuration-cache :app:lintRelease :app:assembleRelease
```

`--no-configuration-cache` keeps the password out of Gradle's configuration cache. A release task without signing credentials fails rather than producing an unsigned APK.

Verify a release APK:

```bash
apksigner verify --print-certs MetadataScrubber-v0.0.2.apk
sha256sum -c MetadataScrubber-v0.0.2.apk.sha256
gh attestation verify MetadataScrubber-v0.0.2.apk -R StormberryAS/MetadataScrubber
```

**Signing certificate SHA-256:** `30e916e7d44860a2c00c839ad2a6b5806e15d14d59b2811c962866959f3e3a98`

The release workflow (`.github/workflows/android-release.yml`, on tags `android-v*`) runs the unit tests, the asset check and lint, builds and signs the APK, and refuses to publish unless the certificate matches that fingerprint and the APK declares zero permissions.

R8 is on for the release build: the app reaches nothing by reflection, the bridge has no `@JavascriptInterface` class to strip, and androidx ships its own keep rules for what it needs. Obfuscation is off so crash reports stay readable.

Licences travel inside the APK under `assets/licences/`, outside the bundled web app: the app's MIT licence (copied from `LICENSE` at build time), the full SIL Open Font License 1.1 for Inter, the Apache License 2.0, and `THIRD-PARTY.txt`, which lists the AndroidX and Kotlin libraries the release build compiles in. The list is taken from the resolved release dependencies, and the build fails on a library whose licence is not on record.

The store icon (`fastlane/metadata/android/en-US/images/icon.png`) is rendered from `favicon.svg` by `android/tools/build-store-icon.py`, with the same composition as the launcher icon.

### Toolchain and dependencies

Every version is pinned exactly in `android/gradle/libs.versions.toml`.

| Component | Version | Released | Notes |
|---|---|---|---|
| Android Gradle Plugin | 9.3.1 | | Same as UsernameGenerator; built-in Kotlin 2.2.10 |
| Gradle wrapper | 9.5.0 | | Same as UsernameGenerator |
| JDK toolchain | 21 | | Bytecode level 17 |
| `androidx.webkit:webkit` | 1.17.0 | 12 August 2026 | Newest stable at least 14 days old on 3 October 2026 (1.17.1, 23 September 2026, was too recent) |
| `androidx.activity:activity` | 1.13.0 | 11 March 2026 | Same release UsernameGenerator ships |
| `androidx.core:core-ktx` | 1.19.0 | 3 June 2026 | Same release UsernameGenerator ships (1.19.1, 23 September 2026, was too recent) |
| `junit:junit` | 4.13.2 | | Tests only |

minSdk 24 (Android 7.0), targetSdk 36, compileSdk 37.1.

## Credits

Built by [Stormberry AS](https://stormberry.as). Proudly powered by sovereign AI agents.

## Disclaimer

Supplied free of charge, **as is**, with no warranty of any kind. Using it creates no client or advisory relationship with Stormberry AS, and nothing it produces is professional advice.

**It removes only what it recognises.** MetadataScrubber removes the metadata it recognises in JPEG, PNG, WebP and HEIC files. It cannot remove anything visible in the picture, the file name you choose, or a camera's sensor fingerprint. **Check the read-back list before you share a file.**

This is a **functioning prototype**, not a certified instrument and not a professional service. Stormberry AS reimburses no cost or loss arising from use of this application.

Full terms: [DISCLAIMER.md](DISCLAIMER.md).

## Licence

Published under the MIT licence, see `LICENSE`. Third-party notices are in `NOTICE`.
