# MetadataScrubber

Remove hidden information from photos before you share them, entirely on your device. MetadataScrubber shows what a picture carries besides the picture itself (GPS position, camera serial numbers, owner names, dates, a built-in preview image and more), lets you choose what goes, and then reads the new file back so you can see what is left.

**Live:** [metadata.stormberry.as](https://metadata.stormberry.as)

**Android:** [MetadataScrubber on Zapstore](https://zapstore.dev/apps/no.stormberry.metadatascrubber) (see [Android app](#android-app))

## What it does

- **One column, one button.** The page reads top to bottom on every screen, in the order you work: choose pictures, see your picture and crop it if you like, tick what to remove, set the size, format and name, then press **Prepare picture** (**Prepare pictures** for several). The button does not assume you want metadata removed: you can untick everything and only crop, resize or convert. If nothing would change, the page says so instead of handing you an identical copy.
- **Shows before it removes.** Every detail found in the file is listed with its value, sorted into red, amber and green. In a section that mixes kinds, each detail also names what it reveals: Where, Who, When, Device or Hidden extras; every green detail is technical, so green needs no such word. Only what the file actually contains is shown, and a detail whose value cannot be read says so.
- **Colour tiers guide the choice.** Red means remove before sharing publicly, amber means think about it, green means harmless and useful. Only red details are ticked by default. Amber (dates, time zone, camera, lens, editing software and the HDR details) is kept unless you tick it, and so is green, because it holds rotation and the colour profile, and removing those re-saves many phone photos and can shift colours. Every tier is labelled in words as well as colour. Each colour has its own section with a tick box that ticks or unticks the whole colour and an arrow that shows or hides its details, so you can choose them one by one; every section starts closed.
- **Lossless by default.** Removing metadata touches only the metadata. The picture itself is not decoded or saved again, so its pixels are identical before and after.
- **Crop, resize and convert when you need to.** Crop freely or to 1:1, 4:5, 16:9 or 1.91:1 (the LinkedIn feed image); resize by percentage, to a longest side in pixels, or to a maximum file size for services that cap uploads (1 MB is read as 1,000,000 bytes, and the result aims at 95 per cent of the limit); save as JPEG, PNG or WebP. These re-save the picture, and the page says so before you press the button. Only the EXIF details you keep are written back into the new file, and the read-back shows exactly what made it.
- **Rotation stays right.** If you remove a rotation setting that is not "normal", the picture is turned the right way up in its pixels and re-saved, and the page tells you. If the rotation is already normal, removing it keeps the file lossless.
- **Reads the result back.** After scrubbing, the new file is read again and the list shows what remains in it. Trust comes from showing, not from claiming.
- **Nothing travels along unseen.** Every part of the file is either needed to show the picture or offered in the list. Parts the engine cannot read or does not recognise (stray bytes, a damaged or cut-off end, unknown fields, leftover bytes an earlier editor left behind, comments hidden inside XMP) are listed as red details, so they go by default and the read-back would show them if they stayed.
- **Share or copy the new file.** Under Save, **Copy image** puts the picture on the clipboard as a fresh PNG without its file details, and **Share the new image** hands exactly the file Save gives to your device's share sheet, where the browser can share it. A press shares straight away; a warning stays under the button whenever it is shown: once a picture is online, you cannot take it back. The page itself never sends anything. The Android app shows the same buttons and warning, and hands the file to Android's share sheet and the PNG to Android's clipboard.
- **Neutral file names.** Phone file names such as `PXL_20261001_101523123.jpg` carry the date, the time and the phone brand, so the original name is never reused. Saved files are named `[name].[tier].[ext]`, for example `image.public.jpg`, where the tier word says how much was removed: `public`, `minimal`, `clean` or `custom`.

## Supported formats

| Format | Read and remove metadata | Crop, resize, convert | Notes |
|---|---|---|---|
| JPEG | Yes | Yes | EXIF, XMP, IPTC, ICC profile, comments, Content Credentials (C2PA), data after the end of the image |
| PNG | Yes | Yes | EXIF, text chunks, ICC profile. A smaller file size can only come from fewer pixels |
| WebP | Yes | Yes | EXIF, XMP, ICC profile. Saving as WebP is offered only where the browser can encode it |
| HEIC | Yes | Only where the browser can open HEIC (Safari) | Removal works without decoding the picture. A re-saved HEIC becomes a JPEG |

## How details are tiered

The spec's rule: red is removed by default and covers location, serial numbers, owner and author names, the built-in preview and unique IDs; amber is kept and covers dates, devices, software and edit history (0.0.3 moves edit history to red, see below); green is technical. Decisions taken while building it:

- **Only red is ticked to start with (0.0.3, decided 4 October 2026).** Amber is kept unless you tick it, as the spec says, and can be ticked as a whole colour or one detail at a time; ticking it as well gives the `minimal` word. Green stays unticked, because it holds rotation and the colour profile, and removing those re-saves many phone photos and can shift colours. A photo prepared with the starting selection usually gets the `public` word, and the result says that dates and device details may remain and can be checked under Amber. Version 0.0.2 ticked amber too.
- **Free text is red, so amber holds only structured details.** Anything a person or an app writes freely can name people, so it goes by default: captions, headlines, titles, descriptions, keywords and comments; PNG text under any keyword, its disclaimer and warning; IPTC captions, keywords, special instructions and its other fields; XMP `dc:title`, `dc:description`, `dc:subject` and the other description fields; EXIF `ImageDescription`, `UserComment`, `XPTitle`, `XPComment`, `XPKeywords` and `XPSubject` (with `ImageTitle`, `DocumentName`, `PageName` and the rating, which share that detail); a JPEG comment; a HEIC text description; the edit history, whose file names can name people; other Photoshop data, which can hold a caption, a web address or layer and channel names; and Content Credentials (see below). Amber keeps dates and times, the time zone, camera make and model, lens, editing software, other camera data, Motion Photo details and the HDR details.
- **Amber holds only what its form allows (review of 4 October 2026).** Amber is kept by default, so a date or device detail stays amber only with a value of the form its specification gives, and nothing a person cannot see may travel with it. Anything else is the red detail Unexpected text in date or device details, so it goes by default.
  - *EXIF.* A date is `YYYY:MM:DD HH:MM:SS` (or blank), a time zone `+HH:MM`, fractions of a second digits, `TimeZoneOffset` one or two small numbers, `LensSpecification` four fractions, `RelatedSoundFile` an 8.3 file name; a make, model, lens or software name is one line of letters, digits, punctuation and symbols with single spaces, at most 64 characters, with no control, format or invisible characters and no e-mail or web address. Nothing but zeros may follow a text's end marker, and the unused bytes of a value stored inside its entry must be zero. `PrintIM` (a block of bytes in the printer maker's own layout), `SubIFDs` and a preview position outside the preview chain are unrecognised camera data, which is red.
  - *PNG.* A date or software text chunk (`Creation Time`, `date:create`, `date:modify`, `date:timestamp`, `Software`, `Source`) and an ImageMagick `exif:` copy of a date, device or technical field that stays is written again as a plain `tEXt` chunk under the keyword's usual spelling, so no language tag, translated keyword, compression or spelling of the keyword survives. Its value must be a date (ISO 8601, RFC 1123 or EXIF style) or a device name as above. A `tIME` chunk must be seven bytes with each field in range. Data after the end of any compressed stream makes the chunk unreadable, which is red. ImageMagick's raw profiles (EXIF, IPTC, Photoshop, colour, XMP) that stay are written again in one form, and an `eXIf` chunk loses any bytes before its TIFF header.
  - *IPTC and the Photoshop block.* A block that stays is always written again in one form, even when nothing in it is ticked: resources keep no names and no padding beyond the one zero byte, the record versions are written as version 4, the character set is kept only as the marker for UTF-8, datasets are in number order, nothing unreadable stays, and the IPTC digest is computed again from the new data. An IPTC date must be `CCYYMMDD`, a time `HHMMSS` with an optional zone, and the program's name and version short device names.
  - *XMP.* A date, camera, lens, software or Motion Photo field stays amber only as a plain value or a short list, with no attribute on it or its list items (no `xml:lang`, `rdf:datatype`, `rdf:ID` or qualifier), and a value of the field's form (an ISO 8601 date, a device name, a number). A field in a namespace the engine does not know is judged by its name only, never by a prefix it borrows, and is otherwise red. The toolkit name (`x:xmptk`) is never written.
  - *HEIC.* The parts of the file's structure that no reader needs are written in a fixed form whenever the file is written: the minor version and any unknown brand in `ftyp`, the reserved fields and handler name in `hdlr`, the flags of each item beyond "hidden", every item's name, and the bytes before the TIFF header of the EXIF item (`Exif` and two zeros). A creation or modification time must be one 64-bit number. An auxiliary image's type must be exactly a known one, followed by nothing or, for the MPEG names, by its HEVC description holding only transparency or depth information. An image that is removed is also marked hidden, so no viewer offers its blank data as a second picture.
  - *Before an EXIF block.* The bytes between a container's own header and the TIFF header are written in their one form: `Exif` and two zeros in JPEG and HEIC, nothing at all in WebP and PNG `eXIf`.
  - *What this cannot tell apart.* A short, well-formed name written into a camera, lens or software field cannot be told from a real model name. It is shown under Amber with its value, so you can see it and tick it.
- **HDR photos keep their brightness.** An HDR gain map and what it needs to be found and shown are amber, so they are kept: the gain map, its XMP description (HDR gain map details) and, on an iPhone photo, Apple HDR brightness. A gain map changes how the photo looks, not who took it. Ticking Amber as a whole ticks them too; ticking HDR gain map removes the gain map and what belongs to it, and leaves the normal picture unchanged. When amber is ticked and the gain map is not, the result gets the `public` word and says why. An iPhone HEIC keeps its gain map and its HDR brightness in the same way as an iPhone JPEG (see below).
- **XMP is always written again in a standard form (0.0.3).** Every XMP packet that stays, in the photo or in a gain map, is rewritten with no white space between its parts, no padding, a fixed order and nothing but the plain packet wrapper (none in HEIC and in a gain map, as Apple writes them), so its layout cannot carry hidden information. Line ends and line breaks inside attribute values are read as any XML reader reads them, and a carriage return in a value is written as a reference, so a kept value reads the same to other programs. Each rewrite is read back and compared with the original; a packet that cannot be rewritten safely is treated as unreadable, which is red. For the same reason a file whose XMP is not yet in that form is written again even when nothing is ticked.
- **Copyright notices and credit lines are red.** They usually name the photographer, and the `public` word promises that names are gone. Untick them if you want them in the shared file.
- **The computer name is red; editing software stays amber.** The name of the computer that saved the file (EXIF `HostComputer`, its XMP copy, or a PNG text field such as `Host Computer`) often contains the owner's name, for example `Astrid-Laptop`, so it is its own detail in the Who group and goes by default. The editing software (EXIF `Software`, XMP `CreatorTool`) only names a program, so it stays amber.
- **Anything unrecognised is red**: unknown EXIF tags, XMP fields in namespaces the engine does not know, unidentified APP segments, chunks and boxes. A field whose name says what it is (for example a drone's `GpsLatitude` or a `CameraSerialNumber` in any namespace) is tiered by that name.
- **Content Credentials (C2PA) are red** (review of 4 October 2026). Every signed record can name a person: the signer's certificate (a personal signing identity carries the person's name), the generator's name, ingredient names and titles (usually file names), custom and compressed assertions no text search can read, and a thumbnail of the parent picture, which may be the uncropped original. Every record also carries a unique ID that links the file to its original, as XMP document IDs do, which are red too. What the record is seen to repeat (the position, a serial number, names, titles) is still named in its value. The record is signed, so it is kept or removed whole, and a kept record shows as altered after any other change. Pixel phones turn Content Credentials on by default, so on their photos this is usually one more red detail.
- **An HDR gain map is amber, and a kept gain map keeps only what it needs to render.** That is what the published specifications define: Adobe's `hdrgm` gain map fields (as Ultra HDR uses them), Apple's `HDRGainMapVersion` and `HDRGainMapHeadroom`, Apple's `apdi:AuxiliaryImageType` in the gain map's own XMP with exactly the value `urn:com:apple:photo:2020:aux:hdrgainmap` (a fixed value carries no hidden information; any other `apdi` field is a red detail; that value in another form, with an attribute or under another prefix, is written again in the usual form; a second picture without it is not an Apple gain map, since no reader finds one without it), the core fields of the Container directory (`Item:Mime`, `Item:Semantic`, `Item:Length`, `Item:Padding`), the ISO 21496-1 gain map block, and the parts of the MPF index a reader needs to find the gain map. Each field is kept once, and only with a value of the form its specification gives: in the directory only the roles `Primary`, `GainMap` and `MotionPhoto` with the file type each role uses, and a number where a number belongs, with at most nine significant digits (or exactly the double a single-precision value prints as) and inside the range the field can have (a log2 boost within plus or minus 16, a gamma above 0 and up to 16, an offset within plus or minus 1, a capacity from 0 to 16, Apple's headroom from 1 to 1,000). More digits, or a number outside its range, can spell text, so the field is then a red detail. Everything else in or around the gain map is its own detail, tiered by its name where the name says what it is (an `hdrgm:GPSLatitude` is a GPS position, an `HDRGainMap:OwnerName` an owner name) and red otherwise: other fields in those namespaces, labels and free text in the directory, a directory entry that stands for no part of the file, bytes after the gain map's end marker, image IDs and unexplained data in the MPF index, and bytes an ISO 21496-1 segment does not define. The metadata inside the gain map itself (it is a second, hidden picture) is red, so it goes by default, because even a technical field there can hold free text. Removing any of these keeps the gain map. Where a reader needs the field to find the gain map, removing a malformed value writes the one value the specification allows instead (`hdrgm:Version="1.0"`, `Item:Mime="image/jpeg"`), and the photo's ISO 21496-1 segment is cut to its version rather than dropped. The engine sets the MPF sizes and offsets and the directory lengths to match the new file, checks that the photo still points to the gain map as it did, and removes the gain map with a warning if it could not be kept safely. The gain map and HDR gain map details go together: ticking either removes both, since a gain map without its description cannot be found. The gain map's own colour profile is green whenever it can be read, like the photo's own, because an ISO 21496-1 gain map may be applied in its own colour space (Chrome then uses that profile); text in it that is not a well-known profile name is red, as in the photo's own profile, and is rewritten in place. Decoder tables inside the gain map that no scan uses are red too. What can still travel with a kept gain map is its pixels, the decoder tables it uses and the allowed numbers, about 30 bits per number: enough for one coordinate-shaped value such as `59.4083` hidden in a gain map setting, and a few hundred bytes over all the numbers of both descriptions. A second picture without gain map data of its own, larger than the photo, or with two or four colour channels is not treated as a gain map: it is red, like any other extra picture stored in the file.
- **iPhone HDR JPEGs and HEICs keep their HDR.** Besides the gain map's `HDRGainMapVersion` and `apdi:AuxiliaryImageType`, an iPhone gain map needs the photo's HDR headroom, which Apple stores as two numbers (tags 33 and 48) in the EXIF MakerNote. Chrome finds an Apple gain map only when the photo's MakerNote gives that headroom, and Apple's software reads it there too. The MakerNote as a whole stays red, so those two numbers are a detail of their own, Apple HDR brightness (amber, kept with the gain map): when the rest of the MakerNote goes, the engine writes a MakerNote of its own holding only those two numbers, each checked to lie in the range a reader can use (tag 33 from 0 to 8, tag 48 from 0 to 16 and only while the headroom formula still gives more than none) and rounded to a thousandth and a ten-thousandth, in Apple's layout; the detail shows the headroom and both numbers. Without those numbers, or a headroom in the gain map's own description, no screen can show an Apple gain map in HDR, so it is then red, like any extra picture. Ticking Apple HDR brightness removes the gain map too, and the reverse. An iPhone HEIC works the same way since 0.0.3: its gain map is the auxiliary image whose type is exactly `urn:com:apple:photo:2020:aux:hdrgainmap`, kept with only the gain map fields of its own XMP, and the two numbers are written in a MakerNote of their own inside the HEIC's Exif item. An auxiliary image whose type is not exactly a known one is red and goes, and is marked hidden so no viewer shows it as a second picture.
- **Green keeps only what the specifications define.** Green details are kept by default, so they may hold only numbers, fixed words and well-known names.
  - *Colour profiles* (JPEG, PNG, WebP and HEIC). The text tags (description, copyright, device maker and model, viewing conditions and any other text) stay only when every string in them is a well-known profile name or vendor line, such as `sRGB IEC61966-2.1`, `Display P3`, `Adobe RGB (1998)` or `Copyright Apple Inc., 2017`, written exactly (trailing spaces aside; a tab or any other space character is part of the text), with English language codes only; a PNG's profile name likewise. A colour tag stays only under a signature that takes it and with a type that signature allows (a curve as `curv` or `para`, a colour as one XYZ number within plus or minus 4, a table as `mft1`, `mft2`, `mAB ` or `mBA `, and the HP sRGB profile's measurement and viewing conditions as their fixed numbers), and only the bytes its structure gives are colour: reserved bytes and anything after the structure must be zero. The free fields of the header (CMM, platform, maker, model, creator, date, flags, attributes, rendering intent, illuminant, the version's spare bytes) must be zero or a registered value. Anything else (other text, text a colour engine cannot read, a private tag, a target, a calibration date, numbers no colour engine reads, a free header field, bytes no tag uses, set reserved bytes or a profile ID that is not the profile's checksum) is the red detail Text inside the colour profile. Removing it rewrites the profile in place: text tags get a neutral value inside their own space, the other tags leave the table, free bytes and header fields are zeroed, and every byte a colour engine reads stays where it was, so the colours do not change and the profile keeps its size. JPEG profile segments are numbered again 1 to n of n. A profile that cannot be read safely (a broken header or tag table, a colour tag whose structure does not fit, a named-colour profile) is red as a whole, so it goes by default, and the result then warns that colours may look slightly different.
  - *Technical XMP fields* (for example `xmp:Rating`, `photoshop:ICCProfile`, `dc:format`, the `GPano` photo sphere fields and the EXIF fields copied into XMP) must hold what their specification gives: a number of at most twelve digits, a fraction, a Boolean, a fixed word or a known profile name, with no more values than the EXIF field has, written exactly (no white space around it, no `xml:lang`). Anything else is the red detail Unexpected text in technical details, unless its name says what it is (a date in `GPano:FirstPhotoDate` is a date, the program in `GPano:CaptureSoftware` editing software). The digests Photoshop writes (`photoshop:EmbeddedXMPDigest`, `photoshop:LegacyIPTCDigest`, `tiff:NativeDigest`, `exif:NativeDigest`) are 128 free bits each and fingerprints of the original metadata, so they are red, with the unique IDs.
  - *XMP around the fields.* Names, declarations and the packet wrapper are text the writer chooses, so a known namespace under any prefix but its usual one, a namespace declaration no name uses (other than a known one under its usual prefix), an `xpacket` wrapper other than the standard one, `xml:` and unknown `rdf:` attributes on a description, a typed node's name, a CDATA section, a numeric character reference XML does not need, and white space other than spaces, tabs and line breaks between nodes are all the red detail Hidden text inside XMP. Removing it writes the packet again with the usual prefixes and nothing else.
  - *EXIF.* A technical EXIF field must have the type and number of values Exif 3.0 and TIFF 6.0 give it (`XResolution` is one fraction, `ISOSpeedRatings` up to three integers, `SubjectArea` two to four), an enumeration a small value, and a value stored inside its entry zeros in the unused bytes; for the few text and byte fields, the one form the specification gives (`ExifVersion` as four digits, also as text ending in a NUL, `ComponentsConfiguration`, `FileSource`, `SceneType`, `CFAPattern`, `Padding` as zeros after Microsoft's six-byte header, the numbers of `CompositeImageExposureTimes`, the interoperability index `R98`, `THM` or `R03`, a clean colour profile). Anything else (text or a list in a numeric field, `TransferFunction`, `SpectralSensitivity`, `DeviceSettingDescription`, `OECF`, `RelatedImageFileFormat`, a field of a TIFF file that a photo's EXIF does not need) is the red detail Unexpected data in technical details. PNG colour and display chunks must have the size and form the PNG specification gives (`sPLT` and `pCAL` hold free-text names, so they are always red), and an ImageMagick `exif:` text copy of a technical field must read as no more numbers than the field has.
  - *JPEG decoder tables.* A quantisation or Huffman table that no scan uses (one defined under an id no scan reads before it is defined again) is the red detail Unused decoder tables, in the photo and inside a kept gain map; removing it leaves the pixels unchanged. Nikon Coolpix cameras store one such table.
  - *What green can still carry.* Kept numbers are numbers, but their low digits are free: about 8 bytes per EXIF fraction, about 2 bytes per colour number in a profile and the values of its curves and tables, the values of the decoder tables a picture uses, and a valid date in a profile header. Numbers kept for display (exposure, gain map values, the Apple HDR numbers) are checked for range but can still carry a few bits each if a program deliberately hides data in them, and so can the few choices the standard XMP form keeps (an attribute or an element, the language of a list item a person wrote) and the way a kept compressed chunk, such as a PNG colour profile, was compressed. That is enough for a short name, though not where a person would look, and it cannot be removed without changing what the numbers mean or re-encoding the picture.
- **Removing the image IDs or the layout details rebuilds the MPF index**, which also leaves out its unexplained data, so ticking either of them removes that too.

## What it cannot remove

- Anything visible in the picture: faces, street signs, number plates, reflections, screens.
- The file name you choose for the result.
- A camera's sensor fingerprint, the pattern of tiny flaws that can link photos to one camera.
- Invisible watermarks woven into the pixels.
- Data hidden in the low digits of numbers the picture needs, such as colour curves, decoder tables and exposure values (see What green can still carry above).

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
- **The privacy page.** `privacy.html` (https://metadata.stormberry.as/privacy.html) states the same in plain words for the website and the Android app, and is the privacy policy address for the Google Play listing. It has the same Content Security Policy as `index.html` and no scripts, the footers of `index.html` and `disclaimer.html` link to it, and the app bundles it like every other web file.
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

**Engine tests.** Without `MS_FIXTURE_DIR` the fixtures go to the system temporary folder. Each format is checked the same way: the planted details are found with the right tiers, the red details are removed (checked with `exiftool` and by searching the bytes), removing everything leaves only structure, decoded pixels never change, and `exiftool -validate` reports nothing new. The hardening tests cover data hidden in unusual places with hand-built files. The HDR gain map tests build Ultra HDR pictures byte by byte, each with something hidden in or around the gain map, and check that it is offered and removed while the kept gain map still renders with the same pixels and the right MPF sizes and directory lengths.

**Privacy audit.** `tests/audit.mjs` is a sceptic's harness and is not run by `node --test`. For every picture in the corpus, every picture the engine tests made (step 1 must have run with the same `MS_FIXTURE_DIR`), and about 80 adversarial pictures that hide data where a scrubber may not look (including the probes of the review of 4 October 2026 in `tests/probes.mjs`, shared with the engine tests), it works out which detail removes each planted string, scrubs with only the red details ticked (the page's starting selection since 0.0.3; the audit checks that the two agree, and red must go while amber is kept), with red and amber ticked except an amber HDR gain map and its own details (what a person gets by ticking Amber and leaving the gain map unticked; the read-back must hold only green details and those) and with every detail ticked, and searches the output in plain text, UTF-16, hex, base64 and every zlib stream. The red-and-amber selection keeps an amber HDR gain map, so every red and amber planted string in or around a gain map must go while the gain map stays; on such a picture it also checks that the kept gain map is still a whole JPEG found through the MPF index, decodes to the same pixels, has the length the Container directory gives and keeps its `hdrgm` values (on an iPhone photo, its `HDRGainMapVersion`, its `apdi:AuxiliaryImageType` and the photo's Apple HDR headroom), and it scrubs once more with the gain map ticked as well, whose read-back must hold only green details. It also reads the result back, lists what `exiftool` still sees, compares pixels, checks that HEIC files keep their box layout, that only XMP changes length and that libheif sees no more top-level pictures than before, rebuilds EXIF for re-saved pictures, and runs about 1,500 damaged and malicious files in a worker with a time limit. Options: `--sections=registry,core,adversarial,reencode,hostile` runs some sections, `--fuzz=N` sets the random mutations per file (default 120), and `--no-exiftool` skips the slow `exiftool` steps. It writes `report.txt`, `report.json` and every output file to `MS_AUDIT_DIR`, and exits 1 when there is a critical or high finding.

**Interface smoke test.** It starts its own local server with the production policy, drives a throwaway headless Chromium profile, downloads the new files and checks them with the engine. Use `--chromium <path>` if Chromium is elsewhere than `/usr/bin/chromium`. It also loads the page the way the APK does, with `android-bridge.js` added before the first script and a stand-in for the app's message channel, and checks that the Zapstore section at the foot of the page is hidden and that Save hands the file to the app as a save, and nothing else. Share and Copy are checked with stand-ins for the share sheet and the clipboard (`tests/share-stub.mjs`): when each is offered, the button's words and colour, the warning under it and the order of Save, Copy, Share and the warning, that a press shares at once and the shared bytes equal the saved file, that a closed share sheet says nothing, that the copied PNG holds no metadata, and in the app (with the stand-in channel) that Copy, Share and the warning are shown, that Share hands the app exactly the saved bytes and name, and that Copy hands it a PNG without metadata.

**End-to-end test.** `tests/serve.py` serves the repository over HTTPS with the headers the live zone sends, and only the files GitHub Pages would publish. Chromium then opens the page as `https://metadata.stormberry.as/`, with that name pointed at the local server and every other name made unreachable, so nothing can leave the machine. Each flow starts as a first-time visitor, presses the buttons a person would press, downloads the new file and checks it with the engine, `exiftool`, the planted strings and a pixel comparison. It records every request, console message, exception and policy violation, and saves screenshots at 1280 × 900 and 390 × 844. `--out <folder>` chooses where the report and screenshots go, `--only <flow,flow>` runs some flows, and `--keep` keeps the downloaded files. It exits 0 when everything passes, 1 when the page or the harness fails a check, and 2 when the only failures are in the engine. The `android-app` flow adds the bridge line on the way in, as the APK build does, and checks that the Zapstore section stays hidden while the page works as usual, and that Share, Copy and the warning stay hidden after a result when the app's message channel is missing (a WebView too old for it). The `android-app-bridge` flow adds a stand-in for that channel and taps Save, Copy and Share by finger: the buttons and the warning show, Save reaches the app as a save only, Share hands it exactly the saved bytes and name, and Copy a PNG without metadata. The `share` flow taps Share and Copy by finger with the same stand-ins as the smoke test, `share-native` checks real Chromium (Share follows `navigator.canShare`, and with clipboard permission Copy really puts a PNG without metadata on the clipboard), and `share-absent` checks a browser with neither.

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

- `:app:prepareWebAssets` copies the web files (everything Pages serves, minus `android/`, `fastlane/`, `tests/`, `.github/`, `zapstore.yaml`, `CNAME`, `README.md` and the other entries in `_config.yml`) into generated assets. It fails the build if any file that `index.html`, `disclaimer.html`, `privacy.html`, the stylesheets or the ES modules refer to is missing from the copy, or if the web root holds a file type the app does not serve.
- `:app:verifyWebAssets` runs before every build and in `check`. It fails unless every bundled file is byte-identical to its source. The one permitted difference is a single line in `index.html`, `<script src="android-bridge.js"></script>`, placed before `gate.js` and the app module. Its report is `android/app/build/reports/webAssets/verify.txt`.
- `:app:checkWebSourcesTracked` runs before every build and fails if a file that would be bundled is not tracked by git or comes in through a symbolic link. The repository sits in a synced notes folder, so a pasted screenshot, a note or a sync-conflict copy next to the web files stops the build instead of shipping.
- `:app:verifyWebAssetsCommitted` runs before every release build and fails unless every bundled file equals its copy in the commit `HEAD` points at (for `index.html`, once the injected line is taken out). An uncommitted edit to the page or the engine is fine for a debug build but stops a release, so a signed APK carries only what Pages serves from that commit.
- `android/web-overlay/android-bridge.js` exists only in the APK. It never fetches anything, so the page's own policy (`connect-src 'none'`) stays intact. It also hides every element of the page marked `data-web-only`, such as the "Get the Android app on Zapstore" section at the foot of the website, so the app does not advertise itself. Since 1.0.1 it adds `window.MSAndroid` (plain JavaScript on the origin-restricted message channel, no `addJavascriptInterface`), and the page shows its Share and Copy buttons with the warning in the app because that object exists; without it the page marks that block `data-web-only`.

### Zero permissions

The APK declares no permissions at all, not even internet access, so the WebView cannot reach the network whatever the page did. Check any APK yourself:

```bash
aapt dump permissions MetadataScrubber-v1.0.1.apk   # the only line is the package name
```

Pictures come in through the system file picker (Storage Access Framework) or a share from another app; both hand over a one-off read grant, so the original bytes, including GPS, are read without a storage permission. Backup is off (`allowBackup="false"`, and both rule files exclude everything). The WebView's metrics reporting and Safe Browsing lookups are switched off in the manifest.

### How sharing works

- **Into the app.** Share one or several JPEG, PNG, WebP or HEIC pictures from a gallery or file manager. Once the first-run notice is dismissed, the app hands them to the page in chunks, the page rebuilds them as files and puts them in its own file input, and the normal flow takes over. Only `content:` addresses are read; `file:` addresses and the app's own files are refused.
- **Out of the app.** The page's buttons work as on the website (1.0.1). The bridge reads the new file in the page and passes it to the app in chunks, with what to do with it. **Save** opens the system save screen with the page's name, for example `image.public.jpg`, and nothing else. **Share the new image** opens the system share sheet straight away, through a `FileProvider` limited to the app's `cache/outgoing/` folder; the warning stays visible under the button in the page. **Copy image** puts the fresh PNG the page draws (no file details) on Android's clipboard as a content address under the label `image`, after the app has checked every chunk and its checksum, refused anything but the chunks that draw the picture, and written it again without drawing hints such as the `sRGB` chunk Android's WebView adds (`PngCheck.kt`), so it holds no metadata at all, as on the website. In the app a copy can be pasted for 2 minutes (the page says "Copied. You can paste it for the next 2 minutes."; the website keeps its own line): it lives in `cache/clipboard/<time>-<random>/image.png`, a newer Copy deletes the older one at once and starts its own 2 minutes, and after them `OutgoingProvider` (the app's FileProvider) refuses the address, deletes the file and withdraws its read grants, whatever state the app is in, because every paste goes through it. A timer deletes it on time while the app runs (and clears the clipboard if it still holds the picture), an inexact `AlarmManager` alarm to a non-exported receiver does it when Android has frozen the app in the background, and a sweep at start, return, background and low memory catches the rest; none of them needs a permission (`ClipboardFiles.kt`, `ClipExpiry.kt`). Every request is checked before a byte is accepted (`OutgoingRequest.kt`): one of the three actions, one of the five picture types (a PNG for Copy), a size within 512 MB and the matching number of chunks, a safe name; there is no field for an address or a path. A file is deleted from that folder once it has been saved; files handed to another app stay until the app next starts fresh, so the receiving app can still read them. A second tap on Save while a file is being handed over does nothing, and a short notice says the file is being prepared.
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
apksigner verify --print-certs MetadataScrubber-v1.0.1.apk
sha256sum -c MetadataScrubber-v1.0.1.apk.sha256
gh attestation verify MetadataScrubber-v1.0.1.apk -R StormberryAS/MetadataScrubber
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
