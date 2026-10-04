# MetadataScrubber fixtures: planted strings

An adversarial corpus for testing the scrubbing engine. Every metadata location
in every fixture carries a unique planted string, so an audit can search the
bytes of a scrubbed file and say exactly what was left behind, and where it
came from.

Everything is synthetic. The pictures are drawn shapes, gradients and seeded
noise. Names (Astrid Holmvik, Jonas Brekkestad), the camera brand (Fjordcam),
software (FjordOS, Fjord Studio), serial numbers and IDs are invented. GPS
positions are public landmarks.

## Regenerate

```
tests/fixtures/make-fixtures.sh
```

Writes everything to `tests/fixtures/out/`, which is git-ignored: the binaries
are rebuilt, never committed. The run is reproducible: with the same tool
versions the output is byte-identical (compare `out/SHA256SUMS` between runs).
Built and checked on 2026-10-01 with exiftool 13.25, ImageMagick 7.1.1-43
(libheif 1.19.8), ffmpeg 7.1.5 and Python 3.13.5.

Besides the fixtures, a run writes:

| File | What it holds |
|---|---|
| `out/canaries.tsv` | The registry: every planted string with its fixture, location, group, expected tier, basis and storage form. Machine-readable; tests should load this rather than this page. |
| `out/exiftool-visibility.tsv` | For each planted string, whether `exiftool -a -u -G1 -ee` shows it. |
| `out/exiftool/<fixture>.txt` | The full `exiftool -a -u -G1 -ee` output for each fixture. |
| `out/canaries-tables.md` | The tables at the end of this page, freshly generated. |
| `out/SHA256SUMS` | Checksums of everything above. |

The script stops on any exiftool warning while writing, then checks that every
planted string is present in its fixture in the stated form, that no canary
appears in two fixtures, and that no planted string contains another (so a
grep hit is never ambiguous). It also warns if this page is missing any
planted string, which means the tables below are stale.

ffmpeg is optional. Without it (or with `FIXTURES_NO_FFMPEG=1`) the motion
photo gets a hand-built MP4 with no video track but the same planted strings
in the same boxes.

## Audit a scrubbed file

```
python3 tests/fixtures/fixturekit.py scan tests/fixtures/out/canaries.tsv scrubbed.jpg [more files]
```

Prints one line per planted string found (file, string, tier, original
location, where it was found) and exits with status 1 if anything was found.
It searches the raw bytes, every inflated zlib stream in PNG `zTXt`,
compressed `iTXt` and `iCCP` chunks, every hex-decoded PNG raw profile, and
UTF-16 text in either byte order. A plain `grep -c CANARY- file` finds only the
`raw` ones.

What the page's starting selection (since 0.0.3, every red detail ticked and
nothing else) must achieve, per fixture: no red string left; amber and green
strings still there unless the user ticked them. That gives "public" when amber
details remain. Ticking amber as well (the audit's red-and-amber selection,
which keeps an HDR gain map) must leave no red or amber string, which gives
"minimal" and leaves only green strings; "clean" leaves none.

A baseline for comparison: `exiftool -all=` on the fixtures removes every
planted string except two, the unknown PNG chunk `prVt` and the unknown WebP
chunk `PRVT`, which it keeps. A purpose-built scrubber should do at least as
well.

## Conventions

**Canaries** look like `CANARY-JPEG-EXIF-ARTIST-c2a7`: fixture, place, and the
first four hex digits of the SHA-1 of the name, so they are stable from run to
run. Most sit inside a plausible value ("Astrid Holmvik CANARY-...").

**Markers** are plausible values that are unique in the corpus, mostly dates
(`2024:06:14 09:41:27`) and coordinate strings (`48,51.5022N`). They test the
items that cannot carry a canary because the format fixes their shape.

**Group** uses the engine's group ids: `where`, `who`, `when`, `device`,
`hidden` (Hidden extras), `technical`.

**Tier** is the tier the spec expects for that item. **Basis** says how sure
that is:

- `spec`: the spec names the item, or an item of the same kind, and its tier.
  The computer name (HostComputer) is red by the owner's decision of
  2026-10-02, because it often names the owner ("Astrid-Laptop"). Free text
  and the edit history (which lists file names) are red by the owner's
  decision of 2026-10-04, because they can name people.
- `inferred`: the spec is silent. The tier follows the closest rule:
  - free text (descriptions, comments, captions, keywords, titles) is red,
    because it can name people (owner's decision, 2026-10-04; it was amber
    before 0.0.3);
  - unknown or unparsed data (MakerNote, private tags, the APP5 segment,
    unknown PNG and RIFF chunks, bytes after the end of the image, the Samsung
    trailer) is red, because the page cannot show the user what is in it and
    maker notes routinely hold serial numbers;
  - the PDF Author and Title are red, by the same rules, for phase 2.

**Stored as** is how the string sits in the file: `raw` (verbatim bytes),
`zlib` (inside a compressed PNG chunk), `hex` (inside a PNG "Raw profile type
exif" text chunk, where 72-character line breaks can split it) or `utf16`
(UTF-16 text, which is how the APP12 Ducky segment stores strings).

**exiftool sees** is the result of `exiftool -a -u -G1 -ee <fixture>`:

- `yes`: the string appears verbatim in the output;
- `reformatted`: exiftool shows the item but formats the value its own way
  (dates with colons, coordinates in degrees and minutes); the exact form it
  prints is given, matched against the right group and tag;
- `no`: exiftool does not show it with that command. See "What exiftool cannot
  see" below for the deeper route, where one exists.

## The fixtures

| Fixture | Bytes | What it tests |
|---|---|---|
| `jpeg-everything.jpg` | 124,260 | Every common JPEG metadata container at once |
| `jpeg-orientation-6.jpg` | 33,658 | Camera-style rotated photo, Orientation 6, big-endian EXIF |
| `jpeg-progressive.jpg` | 44,286 | Progressive (SOF2) encoding with EXIF, XMP and COM |
| `jpeg-ultrahdr-like.jpg` | 82,149 | MPF index pointing to a gain map JPEG after EOI |
| `jpeg-uhdr-*.jpg` (20 files) | 80,872 to 157,671 | Ultra HDR and iPhone HDR variants: one thing hidden in or around a gain map that starts unticked |
| `jpeg-motion-photo.jpg` | 117,412 | Google-style motion photo: XMP container directory plus an appended MP4 |
| `jpeg-samsung-trailer.jpg` | 50,829 | Samsung SEFH/SEFT trailer after EOI |
| `jpeg-extended-xmp.jpg` | 186,030 | XMP too large for one segment, split into Extended XMP |
| `png-everything.png` | 316,921 | Every PNG text, profile and EXIF chunk, before and after IDAT, plus bytes after IEND |
| `png-transparent.png` | 16,613 | Real transparency, for PNG to JPEG |
| `webp-everything.webp` | 25,216 | VP8X with ICCP, EXIF, XMP and an unknown chunk |
| `heic-everything.heic` | 110,292 | HEIC with EXIF (and an EXIF thumbnail) and XMP items |
| `jpeg-large.jpg` | 6,850,213 | 6000 x 4000 photo-like picture for the resize-to-1 MB test |
| `not-an-image.pdf` | 759 | Format rejection |
| `truncated.jpg` | 2,048 | First 2,048 bytes of a valid JPEG |
| `jpeg-double-exif.jpg` | 14,334 | Two EXIF APP1 segments |
| `jpeg-ifd-cycle.jpg` | 13,850 | TIFF directories that point back at each other |
| `jpeg-ifd-overflow.jpg` | 13,858 | TIFF counts and offsets far outside the segment |
| `jpeg-icc-text.jpg` | 29,507 | Names in the description, copyright and device maker of a colour profile (APP2) |
| `png-icc-text.png` | 143,593 | Names in a compressed iCCP profile and in its profile name |
| `webp-icc-text.webp` | 4,712 | Names in the copyright and device model of an ICCP profile |
| `heic-icc-text.heic` | 41,947 | Names in the description and copyright of a colr profile |
| `jpeg-green-xmp.jpg` | 14,523 | Names in technical XMP fields (`xmp:Rating`, `photoshop:ICCProfile`, `GPano:ProjectionType`) |

Byte counts are from this machine's tool versions and will differ slightly
elsewhere.

### jpeg-everything.jpg

880 x 660, cropped from a 1200 x 900 scene. The crop removed a red figure on the
right; **both embedded previews still show it**: the EXIF IFD1 thumbnail
(160 x 120) and the Photoshop thumbnail in APP13 (128 x 96). That is the
spec's reason for making the preview red. Each preview carries its own COM
canary, so a scrubber that merely unlinks IFD1 instead of dropping its bytes
is caught.

Segment order: SOI, APP0 JFIF, APP1 EXIF (little-endian), APP13 Photoshop
(IPTC and thumbnail), APP1 XMP, APP2 ICC profile (colord sRGB, version 4, with
a private `CNRY` tag added), APP11 C2PA in **two** segments (JUMBF split as
JPEG XT requires, the second repeating the superbox header), APP12 Ducky
(UTF-16 strings), COM, DQT, DQT, **APP5 after the DQT tables**, SOF0. An APP
segment after DQT is legal, decoders skip it, and a parser that stops at the
first non-APP marker misses it.

EXIF holds IFD0, the Exif IFD (exposure settings, serials, owner, unique ID,
user comment), an Interoperability IFD, the GPS IFD (Eiffel Tower), IFD1 with
the thumbnail, a binary MakerNote that exiftool cannot identify, and two
private tags (0xBEEF in IFD0, 0xBEF0 in the Exif IFD) that no standard assigns.
XMP holds the same GPS position again (`exif:GPSLatitude`), so removing EXIF GPS
alone still leaves the location. The C2PA manifest is structurally real JUMBF
(manifest store, assertions with a schema.org author in JSON and actions in
CBOR, a CBOR claim, a random-byte signature) but will not validate.

### jpeg-orientation-6.jpg

Drawn upright as 480 x 640, stored rotated as 640 x 480 with Orientation 6, as
a phone held upright stores it. Displayed correctly it shows a **red square top
left, a green square top right, a blue square at the bottom centre and a black
arrow pointing up**. Headless Chromium renders exactly that, 480 x 640. EXIF is
big-endian (MM); the IFD1 thumbnail is stored unrotated, like the main image.

### jpeg-progressive.jpg

640 x 480, progressive (SOF2) in 10 scans, with Huffman tables redefined between
scans. EXIF (with GPS, Colosseum), XMP and COM.

### jpeg-ultrahdr-like.jpg

An Ultra HDR shaped file. The primary JPEG (800 x 600) has EXIF, XMP with
`hdrgm:Version` and a `Container:Directory` naming the gain map and its length,
and an APP2 MPF index (big-endian) whose second entry points past EOI. After
EOI comes the gain map: a 200 x 150 greyscale JPEG with its own XMP (`hdrgm`
parameters plus a `dc:creator` canary).

Two traps. Removing anything from the primary changes its length, so the MPF
image size and the gain map offset must be rewritten or the gain map is lost.
And the gain map's own XMP holds an author name: either clean it or drop the
gain map (the spec does not tier the gain map itself; it is a low-resolution
copy of the picture, so after a crop it is as revealing as the preview).

### jpeg-uhdr-*.jpg: Ultra HDR variants

Twenty HDR shaped files built by `fixturekit.py uhdr` from plain JPEGs
of the same scene, so each carries only its own planted strings. The photo has
XMP with `hdrgm:Version` and a `Container:Directory` (Primary, GainMap with its
length) and a big-endian MPF index; the gain map (200 x 150, greyscale) has the
full `hdrgm` description. The page keeps an HDR gain map by default, so each
file hides one thing in or around it that must still be listed and removed
while the gain map stays and still renders:

| Fixture | What is hidden |
|---|---|
| `jpeg-uhdr-hdrgm-extra.jpg` | `hdrgm:CameraSerialNumber` and `hdrgm:GPSLatitude` in the photo XMP |
| `jpeg-uhdr-item-label.jpg` | `Item:Label` on the GainMap entry of the directory |
| `jpeg-uhdr-apple-owner.jpg` | `HDRGainMap:OwnerName` next to Apple's `HDRGainMapVersion` |
| `jpeg-uhdr-after-eoi.jpg` | Bytes after the gain map's end marker, inside its MPF size; the gain map also has an XMP toolkit name |
| `jpeg-uhdr-bare-after-eoi.jpg` | The same bytes after a gain map with no other metadata |
| `jpeg-uhdr-mpf-tail.jpg` | Bytes after the MP entry table in the MPF segment |
| `jpeg-uhdr-inner-hdrgm.jpg` | `hdrgm:CameraSerialNumber` in the gain map's own XMP |
| `jpeg-uhdr-iso-tail.jpg` | Bytes after the version field of the photo's ISO 21496-1 segment |
| `jpeg-uhdr-inner-mpf.jpg` | An MPF segment inside the gain map |
| `jpeg-uhdr-inner-iso.jpg` | Bytes after the version field of the gain map's ISO 21496-1 segment |
| `jpeg-uhdr-version-text.jpg` | Text inside the value of `hdrgm:Version` |
| `jpeg-uhdr-mpf-extras.jpg` | Little-endian MPF with `ImageUIDList` (B003), `TotalFrames` (B004) and an MP Attribute IFD holding an unknown ASCII tag |
| `jpeg-uhdr-dir-semantic.jpg` | A third directory entry whose `Item:Semantic` and `Item:Mime` are free text, standing for no part |
| `jpeg-uhdr-dir-mime.jpg` | Free text as the `Item:Mime` of the GainMap entry |
| `jpeg-uhdr-inner-gpano.jpg` | A name in `GPano:Note` (a technical namespace) in the gain map's own XMP |
| `jpeg-uhdr-iso-full.jpg` | Nothing: a full three-channel ISO 21496-1 block in the gain map and `hdrgm:GainMapMax` as an `rdf:Seq` |
| `jpeg-uhdr-zero-pad.jpg` | Nothing: 32 zero bytes before the gain map and 64 after it, with `Item:Padding` |
| `jpeg-uhdr-not-gainmap.jpg` | A full-size colour second picture listed as MPF type 0 with hdrgm in the photo XMP: not a gain map at all, with a comment inside |
| `jpeg-uhdr-apple.jpg` | iPhone shaped: no XMP in the photo, an Apple MakerNote whose text tag 0x000B holds a name next to the HDR numbers (tags 33 and 48), and text in `apdi:StoredFormat` in the gain map's XMP. The gain map, its `apdi:AuxiliaryImageType` and the two numbers must stay |
| `jpeg-uhdr-apple-wrong.jpg` | The same, with text after the fixed value of `apdi:AuxiliaryImageType` |

### jpeg-motion-photo.jpg

640 x 480 still with EXIF (GPS, Statue of Liberty) and XMP with
`GCamera:MotionPhoto=1` and a `Container:Directory` whose MotionPhoto item
length matches the appended MP4 exactly. The MP4 (1 second, 320 x 240,
15 frames, MPEG-4 Part 2 from ffmpeg's test pattern) has its movie box after
`mdat`. Its `udta` holds a QuickTime `©xyz` location, a 3GPP `loci` box with a
place name, and an `ilst` with title and comment. The video is red (inferred):
it carries the location twice and shows the moments around the shot. If the
video is removed, the XMP directory and `GCamera` tags should go with it.

### jpeg-samsung-trailer.jpg

640 x 480 JPEG (Make `samsung`, GPS Christ the Redeemer) followed by a Samsung
trailer that exiftool parses fully: data blocks `Image_UTC_Data` (a millisecond
timestamp), `MCC_Data` (724, Brazil's mobile country code) and
`Photo_Editor_Re_Edit_Data` (holding the original file path, which has the date
and time in it, and a canary), then the `SEFH` directory, its length and
`SEFT`.

### jpeg-extended-xmp.jpg

The XMP is about 168 KB: a `dc:creator` and a `photoshop:DocumentAncestors`
list of 2,500 document IDs (the classic bloat that Photoshop really produces).
exiftool split it: the standard packet keeps `dc:creator` and
`xmpNote:HasExtendedXMP` (an MD5 GUID); the ancestors went to three APP1
`http://ns.adobe.com/xmp/extension/` segments (165,354 bytes of extension). Canaries sit at item 500 and
item 1800, both in the extension. Removing the IDs means removing every
extension segment and the GUID.

### png-everything.png

480 x 360 RGB. Chunk order: IHDR, iCCP (profile name with a canary, profile
with a private tag, compressed), pHYs, eXIf (big-endian, GPS Big Ben), tEXt
Author, tEXt Creation Time, tEXt Software, iTXt `XML:com.adobe.xmp`, tEXt
"Raw profile type exif" (ImageMagick's hex format, a second, little-endian EXIF
with its own Artist and the same GPS), prVt (an unknown ancillary chunk), 19
IDAT chunks of up to 16 KB, then **after IDAT**: tEXt Comment, zTXt Description,
compressed iTXt Title in Norwegian (`nb-NO`), tIME, IEND, and 44 bytes after
IEND. exiftool warns about both the late chunks and the trailer.

### png-transparent.png

400 x 300 RGBA: fully transparent corners (alpha 0), a soft semi-transparent
ring, an opaque centre with a white disc. Two tEXt chunks. For PNG to JPEG with
the default white fill, the corners must come out white.

### webp-everything.webp

480 x 360 lossy. RIFF chunks: VP8X (flags ICC, EXIF and XMP), ICCP, `VP8 `,
EXIF (raw TIFF, little-endian, GPS Sagrada Familia), `XMP `, PRVT (unknown).
The EXIF and XMP payloads have **odd lengths on purpose**, so each needs a RIFF
pad byte: a writer that forgets padding, or a reader that ignores it, breaks
here. Removing chunks also means fixing the RIFF size and the VP8X flags.

### heic-everything.heic

640 x 480, 8-bit HEVC Main Still Picture, `ftyp` major brand `heic` (compatible
`mif1`, `heic`, `miaf`). exiftool added an EXIF item (GPS Golden Gate Bridge,
serial number, Artist, and an IFD1 JPEG thumbnail with a COM canary) and an XMP
item. ImageMagick and libheif here do not create a HEIF `thmb` thumbnail item,
so the only built-in preview is the EXIF one. Chromium cannot decode HEIC;
that is expected.

### jpeg-large.jpg

6000 x 4000, 6,850,213 bytes, gradient plus plasma plus Gaussian noise at
quality 92, so it compresses like a photograph. EXIF with GPS (Machu Picchu,
2,430 m). The resize-to-a-maximum test should land at or under 1,000,000 bytes,
about 950,000.

### not-an-image.pdf and truncated.jpg

`not-an-image.pdf` is a valid one-page PDF with an Info dictionary (Author and
Title canaries, for phase 2); `detectFormat` should return null.

`truncated.jpg` is the first 2,048 bytes of a 320 x 240 JPEG. The EXIF segment
is complete (the Artist canary is readable) and the cut falls inside the scan
data (the SOS segment starts at byte 503). Chromium draws the top rows and leaves the rest
empty. The engine should report a warning, not crash or hang.

### jpeg-double-exif.jpg

Two APP1 EXIF segments in a row. The first (little-endian) has Make and Artist;
the second (big-endian) has a different Artist and GPS (Tower Bridge). Many
readers stop at the first. exiftool reads both.

### jpeg-ifd-cycle.jpg and jpeg-ifd-overflow.jpg

Hand-built TIFF structures in an otherwise normal JPEG.

- **Cycle**: IFD0 links to IFD1, which links back to IFD0; the Exif IFD pointer
  aims at IFD0 itself; the GPS IFD's next link points at itself.
- **Overflow**: ImageDescription with count 0x7FFFFFFF at offset 0xFFFFFF00;
  Make at an offset past the end; Model with field type 99; a LONG tag whose
  byte size, 4 x 0x40000001, wraps to 4 in 32-bit arithmetic; an Exif IFD that
  claims 65,535 entries; GPS and next-IFD offsets far past the end.

Both keep one well-formed Artist tag. The engine must finish quickly, report
the Artist, add warnings, and never allocate gigabytes. exiftool reports seven
warnings on the overflow file and two loop warnings on the cycle file.

### Free text in green details: jpeg-icc-text.jpg, png-icc-text.png, webp-icc-text.webp, heic-icc-text.heic, jpeg-green-xmp.jpg

A colour profile and a technical XMP field are green and kept by default, so a
name hidden in them must be offered as a red detail of its own and go by
default, with the colour tags of the profile byte for byte the same. The
profiles are the build's ICC source with text tags replaced by
`fixturekit.py icc-text`: as `mluc` (UTF-16) in the JPEG and HEIC files, as
`desc` and `text` (Latin-1, compressed in PNG) in the PNG and WebP files. The
PNG's iCCP profile name holds a name too. `jpeg-green-xmp.jpg` has names in
`xmp:Rating`, `photoshop:ICCProfile` and `GPano:ProjectionType`, next to
`photoshop:ColorMode="3"` and `GPano:PoseHeadingDegrees="12.5"`, which stay.

## Values grep cannot find

GPS coordinates are binary rationals in EXIF, so they cannot be planted as
text. Check them with exiftool (`exiftool -a -G1 -gps:all -xmp-exif:all`) or a
read-back `inspect()`:

| Fixture | Landmark | Latitude | Longitude | Altitude | Also in |
|---|---|---|---|---|---|
| jpeg-everything.jpg | Eiffel Tower | 48.858370 N | 2.294481 E | 35 m | XMP |
| jpeg-orientation-6.jpg | Brandenburg Gate | 52.516275 N | 13.377704 E | 34 m | |
| jpeg-progressive.jpg | Colosseum | 41.890210 N | 12.492231 E | | |
| jpeg-ultrahdr-like.jpg | Sydney Opera House | 33.856784 S | 151.215297 E | | |
| jpeg-motion-photo.jpg | Statue of Liberty | 40.689247 N | 74.044502 W | 10 m in the MP4 | MP4 `loci` and `©xyz` |
| jpeg-samsung-trailer.jpg | Christ the Redeemer | 22.951916 S | 43.210487 W | | trailer MCC 724 |
| png-everything.png | Big Ben | 51.500729 N | 0.124625 W | | raw profile, XMP |
| webp-everything.webp | Sagrada Familia | 41.403629 N | 2.174356 E | | XMP |
| heic-everything.heic | Golden Gate Bridge | 37.819929 N | 122.478255 W | 67 m | |
| jpeg-large.jpg | Machu Picchu | 13.163141 S | 72.544963 W | 2,430 m | |
| jpeg-double-exif.jpg | Tower Bridge | 51.505456 N | 0.075356 W | | second EXIF only |

Other values with no text form: Orientation 6 (green) in
`jpeg-orientation-6.jpg`; the time zone offsets (`+02:00` and similar, amber,
too short to grep reliably); exposure settings (green); the PNG `tIME` chunk
(2024-07-21 13:03:09 UTC, amber); the WebP and PNG pixel density.

## What exiftool cannot see

With `exiftool -a -u -G1 -ee`, 115 of the 142 planted strings appear verbatim,
7 more appear reformatted, and 20 do not appear. The deeper route for each:

| Planted in | Reach it with |
|---|---|
| EXIF and HEIC IFD1 thumbnails (COM inside) | `exiftool -b -ThumbnailImage F \| exiftool -Comment -` |
| Photoshop thumbnail (COM inside) | `exiftool -b -PhotoshopThumbnail F \| exiftool -Comment -` |
| Motion photo MP4 (`©xyz`, `loci`, title, comment) | `exiftool -b -MotionPhotoVideo F > v.mp4`, then `exiftool v.mp4` |
| Samsung `Photo_Editor_Re_Edit_Data` | `exiftool -u -b -SamsungTrailer_0x0be1 F` |
| Extended XMP item 1800 | `exiftool -m -XMP-photoshop:DocumentAncestors F` (exiftool stops at 1,000 list items unless minor errors are ignored) |
| MakerNote, APP5, PNG prVt, bytes after IEND, WebP PRVT | grep or `fixturekit.py scan` only. exiftool flags most of them with a warning ("Unrecognized MakerNotes", "Unknown APP5 segment", "Trailer data after PNG IEND chunk") or lists the chunk as binary, so the warning itself shows the data is still there |

## Notes for the engine

- **Unlink is not removal.** IFD1 and the Photoshop thumbnail each hide a
  canary inside the preview JPEG. If the pointer goes but the bytes stay, the
  scan finds it.
- **Second copies.** Location sits in EXIF and XMP (`jpeg-everything.jpg`),
  in eXIf, a raw profile and XMP (`png-everything.png`), in a second EXIF
  segment (`jpeg-double-exif.jpg`) and in the motion photo's MP4. Author names
  sit in EXIF, XMP, IPTC, Ducky, C2PA, a gain map and PNG text.
- **Structure after removal.** MPF offsets (`jpeg-ultrahdr-like.jpg`), the
  motion photo directory, the Extended XMP GUID, the RIFF size and VP8X flags,
  the PNG CRCs and the IPTC digest in the Photoshop block all depend on what
  is removed.
- **Content Credentials.** The C2PA manifest is red and removed by default
  since the review of 4 October 2026: its signer's certificate, generator name,
  ingredient names and compressed assertions can all name a person, and it
  carries a unique ID. Keeping it (by unticking it) while removing anything else
  breaks its hash binding in a real file, so it will no longer validate.
- **Hostile input.** The cycle and overflow files must finish fast with
  warnings. `truncated.jpg` must not crash. `not-an-image.pdf` must be refused.

## Limits of this corpus

- No HEIF `thmb` item and no HEIC depth or gain map items: the local tooling
  does not make them.
- The colour profile comes from the build machine: a Display P3 profile if one
  is installed under `/usr/share/color/icc`, else colord's sRGB (used here,
  version 4.4), else Ghostscript's sRGB. Each gets a private `CNRY` tag with the
  fixture's canary, which is red since 0.0.3: text in a colour profile that is
  not a well-known profile name or vendor line is a red detail of its own.
- The C2PA manifest and the MakerNote are structurally plausible but fake; no
  validator or camera software will accept them.
- The motion photo video is MPEG-4 Part 2, not H.264 or HEVC; the scrubber
  should not care about the codec.
- Marker values that exiftool reformats depend on exiftool's output format.
  The build fails loudly if a newer exiftool writes XMP GPS differently.

## Planted strings, fixture by fixture

Generated by `make-fixtures.sh` into `out/canaries-tables.md` and copied here.

### jpeg-everything.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-JPEG-THUMB-COM-004a` | EXIF IFD1 thumbnail (uncropped original), COM inside it | hidden | red | spec | raw | no |
| `CANARY-JPEG-PSTHUMB-COM-3240` | Photoshop IRB thumbnail (uncropped original), COM inside it | hidden | red | spec | raw | no |
| `CANARY-JPEG-ICC-PRIVATE-3529` | ICC profile (APP2), private CNRY text tag | hidden | red | spec | raw | yes |
| `CANARY-JPEG-EXIF-MAKERNOTE-a118` | EXIF MakerNote (binary) | hidden | red | inferred | raw | no |
| `CANARY-JPEG-EXIF-MAKE-719d` | EXIF IFD0 Make | device | amber | spec | raw | yes |
| `CANARY-JPEG-EXIF-MODEL-e21e` | EXIF IFD0 Model | device | amber | spec | raw | yes |
| `CANARY-JPEG-EXIF-SOFTWARE-5d74` | EXIF IFD0 Software | device | amber | spec | raw | yes |
| `CANARY-JPEG-EXIF-ARTIST-c2a7` | EXIF IFD0 Artist | who | red | spec | raw | yes |
| `CANARY-JPEG-EXIF-COPYRIGHT-a053` | EXIF IFD0 Copyright | who | red | spec | raw | yes |
| `CANARY-JPEG-EXIF-DESCRIPTION-ba29` | EXIF IFD0 ImageDescription | hidden | red | inferred | raw | yes |
| `2024:06:15 18:02:11` | EXIF IFD0 DateTime (ModifyDate) | when | amber | spec | raw | yes |
| `CANARY-JPEG-EXIF-HOSTCOMPUTER-18f6` | EXIF IFD0 HostComputer | who | red | spec | raw | yes |
| `CANARY-JPEG-EXIF-PRIVATE-IFD0-d2b5` | EXIF IFD0 unknown tag 0xBEEF | hidden | red | inferred | raw | yes |
| `2024:06:14 09:41:27` | EXIF DateTimeOriginal | when | amber | spec | raw | yes |
| `2024:06:14 09:41:28` | EXIF DateTimeDigitized (CreateDate) | when | amber | spec | raw | yes |
| `CANARY-JPEG-EXIF-BODYSERIAL-fae1` | EXIF BodySerialNumber (exiftool: SerialNumber) | who | red | spec | raw | yes |
| `CANARY-JPEG-EXIF-LENSSERIAL-e71a` | EXIF LensSerialNumber | who | red | spec | raw | yes |
| `CANARY-JPEG-EXIF-LENSMODEL-16d9` | EXIF LensModel | device | amber | spec | raw | yes |
| `CANARY-JPEG-EXIF-OWNER-caa2` | EXIF CameraOwnerName (exiftool: OwnerName) | who | red | spec | raw | yes |
| `CANARY-JPEG-EXIF-UNIQUEID-3c33` | EXIF ImageUniqueID | hidden | red | spec | raw | yes |
| `CANARY-JPEG-EXIF-USERCOMMENT-26ca` | EXIF UserComment | hidden | red | inferred | raw | yes |
| `CANARY-JPEG-EXIF-PRIVATE-EXIF-1eae` | EXIF Exif IFD unknown tag 0xBEF0 | hidden | red | inferred | raw | yes |
| `CANARY-JPEG-GPS-AREA-fa0a` | EXIF GPS IFD GPSAreaInformation | where | red | spec | raw | yes |
| `CANARY-JPEG-XMP-CREATOR-6d4a` | XMP dc:creator | who | red | spec | raw | yes |
| `CANARY-JPEG-XMP-CREATORTOOL-52b8` | XMP xmp:CreatorTool | device | amber | spec | raw | yes |
| `CANARY-JPEG-XMP-CITY-861e` | XMP photoshop:City | where | red | spec | raw | yes |
| `CANARY-JPEG-XMP-DOCUMENTID-1902` | XMP xmpMM:DocumentID | hidden | red | spec | raw | yes |
| `CANARY-JPEG-XMP-INSTANCEID-b4d3` | XMP xmpMM:InstanceID | hidden | red | spec | raw | yes |
| `CANARY-JPEG-XMP-HISTORY-8d27` | XMP xmpMM:History stEvt:softwareAgent | hidden | red | spec | raw | yes |
| `CANARY-JPEG-XMP-AUXSERIAL-38ee` | XMP aux:SerialNumber | who | red | spec | raw | yes |
| `CANARY-JPEG-IPTC-BYLINE-fb3e` | IPTC By-line | who | red | spec | raw | yes |
| `CANARY-JPEG-IPTC-CITY-f70e` | IPTC City | where | red | spec | raw | yes |
| `CANARY-JPEG-IPTC-CAPTION-2171` | IPTC Caption-Abstract | hidden | red | inferred | raw | yes |
| `CANARY-JPEG-IPTC-KEYWORD-277b` | IPTC Keywords | hidden | red | inferred | raw | yes |
| `CANARY-JPEG-IPTC-COPYRIGHT-5c6e` | IPTC CopyrightNotice | who | red | spec | raw | yes |
| `CANARY-JPEG-COM-b5c4` | JPEG COM segment | hidden | red | inferred | raw | yes |
| `CANARY-JPEG-DUCKY-COMMENT-29ab` | APP12 Ducky Comment (UTF-16) | hidden | red | inferred | utf16 | yes |
| `CANARY-JPEG-DUCKY-COPYRIGHT-e8f6` | APP12 Ducky Copyright (UTF-16) | who | red | spec | utf16 | yes |
| `48,51.5022N` | XMP exif:GPSLatitude (as exiftool writes it) | where | red | spec | raw | reformatted: `48 deg 51' 30.13" N` |
| `2024-06-14T09:41:27.456+02:00` | XMP xmp:CreateDate | when | amber | spec | raw | reformatted: `2024:06:14 09:41:27.456+02:00` |
| `CANARY-JPEG-C2PA-AUTHOR-9cf5` | APP11 C2PA, CreativeWork author (JUMBF segment 1) | hidden | red | spec | raw | yes |
| `CANARY-JPEG-C2PA-GENERATOR-0c22` | APP11 C2PA, claim_generator in CBOR claim (JUMBF segment 2) | hidden | red | spec | raw | yes |
| `CANARY-JPEG-APP5-86b9` | Unidentified APP5 segment, placed after DQT | hidden | red | inferred | raw | no |

### jpeg-orientation-6.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-ORIENT-THUMB-COM-c27c` | EXIF IFD1 thumbnail, COM inside it | hidden | red | spec | raw | no |
| `CANARY-ORIENT-EXIF-MAKE-d5ea` | EXIF IFD0 Make (big-endian EXIF) | device | amber | spec | raw | yes |
| `CANARY-ORIENT-EXIF-ARTIST-7e6f` | EXIF IFD0 Artist | who | red | spec | raw | yes |
| `CANARY-ORIENT-EXIF-BODYSERIAL-44e6` | EXIF BodySerialNumber | who | red | spec | raw | yes |
| `2023:11:02 15:20:44` | EXIF DateTimeOriginal | when | amber | spec | raw | yes |

### jpeg-progressive.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-PROG-EXIF-ARTIST-bbd2` | EXIF IFD0 Artist | who | red | spec | raw | yes |
| `CANARY-PROG-EXIF-SOFTWARE-4232` | EXIF IFD0 Software | device | amber | spec | raw | yes |
| `2023:05:20 11:12:13` | EXIF DateTimeOriginal | when | amber | spec | raw | yes |
| `CANARY-PROG-GPS-AREA-cda7` | EXIF GPS IFD GPSAreaInformation | where | red | spec | raw | yes |
| `CANARY-PROG-XMP-CREATOR-be36` | XMP dc:creator | who | red | spec | raw | yes |
| `CANARY-PROG-COM-ac62` | JPEG COM segment | hidden | red | inferred | raw | yes |

### jpeg-ultrahdr-like.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDR-EXIF-MAKE-e878` | Primary image EXIF IFD0 Make | device | amber | spec | raw | yes |
| `CANARY-UHDR-EXIF-ARTIST-a93b` | Primary image EXIF IFD0 Artist | who | red | spec | raw | yes |
| `2025:01:26 20:15:30` | Primary image EXIF DateTimeOriginal | when | amber | spec | raw | yes |
| `CANARY-UHDR-GAINMAP-XMP-CREATOR-f0b1` | Gain map (second JPEG after EOI, found through MPF): its own XMP dc:creator | who | red | spec | raw | yes |
| `CANARY-UHDR-XMP-CREATORTOOL-5bf5` | Primary image XMP xmp:CreatorTool | device | amber | spec | raw | yes |

### jpeg-uhdr-hdrgm-extra.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-HDRGM-SERIAL-48a8` | Photo XMP, unknown hdrgm:CameraSerialNumber next to the gain map fields | who | red | spec | raw | yes |
| `CANARY-UHDRV-HDRGM-GPS-22b5` | Photo XMP, unknown hdrgm:GPSLatitude next to the gain map fields | where | red | spec | raw | yes |

### jpeg-uhdr-item-label.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-ITEM-LABEL-c40c` | Photo XMP, Item:Label on the GainMap entry of the Container directory | hidden | red | spec | raw | yes |

### jpeg-uhdr-apple-owner.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-APPLE-OWNER-6ae7` | Photo XMP, HDRGainMap:OwnerName next to HDRGainMap:HDRGainMapVersion | who | red | spec | raw | yes |

### jpeg-uhdr-after-eoi.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-AFTER-EOI-0c7c` | Bytes after the gain map end marker, inside its MPF size (the gain map also has an XMP toolkit name) | hidden | red | spec | raw | no |

### jpeg-uhdr-bare-after-eoi.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-BARE-AFTER-EOI-23ae` | Bytes after the end marker of a gain map with no other metadata, inside its MPF size | hidden | red | spec | raw | no |

### jpeg-uhdr-mpf-tail.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-MPF-TAIL-4939` | MPF APP2, bytes after the MP entry table that no structure uses | hidden | red | spec | raw | no |

### jpeg-uhdr-inner-hdrgm.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-INNER-HDRGM-6fde` | Gain map XMP, unknown hdrgm:CameraSerialNumber | who | red | spec | raw | yes |

### jpeg-uhdr-iso-tail.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-ISO-TAIL-403e` | Photo ISO 21496-1 APP2, bytes after its version field | hidden | red | spec | raw | yes |

### jpeg-uhdr-inner-mpf.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-INNER-MPF-b3c5` | Gain map, an MPF APP2 segment of its own with a tail | hidden | red | spec | raw | no |

### jpeg-uhdr-inner-iso.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-INNER-ISO-a6f0` | Gain map ISO 21496-1 APP2, bytes after its version field | hidden | red | spec | raw | yes |

### jpeg-uhdr-version-text.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-VERSION-TEXT-26ba` | Photo XMP, text inside the value of hdrgm:Version | hidden | red | spec | raw | yes |

### jpeg-uhdr-mpf-extras.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-MPF-UID-ef11` | MPF APP2 (little-endian), B003 ImageUIDList of the photo | hidden | red | spec | raw | no |
| `CANARY-UHDRV-MPF-ATTR-TAG-9bbe` | MPF APP2, unknown ASCII tag B2EE in the MP Attribute IFD | hidden | red | spec | raw | yes |

### jpeg-uhdr-dir-semantic.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-DIR-SEMANTIC-2cf8` | Photo XMP, Item:Semantic of a third Container directory entry that stands for no part | hidden | red | spec | raw | yes |

### jpeg-uhdr-dir-mime.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-DIR-MIME-87c8` | Photo XMP, Item:Mime of the GainMap entry of the Container directory | hidden | red | spec | raw | yes |

### jpeg-uhdr-inner-gpano.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-INNER-GPANO-e15b` | Gain map XMP, a name in GPano:Note (a technical namespace) | hidden | red | spec | raw | yes |

### jpeg-uhdr-apple.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-APPLE-MAKERNOTE-a2f7` | Photo EXIF, Apple MakerNote text tag 0x000B next to the HDR numbers (tags 33 and 48) | hidden | red | spec | raw | yes |
| `CANARY-UHDRV-APPLE-APDI-ee70` | Gain map XMP, text in apdi:StoredFormat (an apdi field a gain map does not need) | hidden | red | spec | raw | yes |

### jpeg-uhdr-apple-wrong.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-APPLE-AUXTYPE-ef76` | Gain map XMP, text after the fixed value of apdi:AuxiliaryImageType | hidden | red | spec | raw | yes |

### jpeg-uhdr-not-gainmap.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-UHDRV-NOT-GAINMAP-48a9` | COM in a full-size colour second picture listed by MPF as type 0, with hdrgm in the photo XMP | hidden | red | spec | raw | yes |

### jpeg-motion-photo.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-MOTION-EXIF-MAKE-0efa` | Still image EXIF IFD0 Make | device | amber | spec | raw | yes |
| `CANARY-MOTION-EXIF-ARTIST-8fbc` | Still image EXIF IFD0 Artist | who | red | spec | raw | yes |
| `2025:07:04 17:45:12` | Still image EXIF DateTimeOriginal | when | amber | spec | raw | yes |
| `+40.6892-074.0445+010.000/` | Appended MP4: moov/udta/©xyz (QuickTime ISO 6709 location) | where | red | spec | raw | no |
| `CANARY-MOTION-MP4-LOCI-NAME-4204` | Appended MP4: moov/udta/loci place name (3GPP location box) | where | red | spec | raw | no |
| `CANARY-MOTION-MP4-TITLE-f0c4` | Appended MP4: moov/udta/meta/ilst/©nam (title) | hidden | red | inferred | raw | no |
| `CANARY-MOTION-MP4-COMMENT-73a6` | Appended MP4: moov/udta/meta/ilst/©cmt (comment) | hidden | red | inferred | raw | no |

### jpeg-samsung-trailer.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-SEF-EXIF-MODEL-8adf` | EXIF IFD0 Model | device | amber | spec | raw | yes |
| `2025:02:11 07:30:05` | EXIF DateTimeOriginal | when | amber | spec | raw | yes |
| `1739269805123` | Samsung trailer block 0x0a01 Image_UTC_Data (ms since 1970, UTC) | when | amber | spec | raw | reformatted: `2025:02:11 10:30:05.123+00:00` |
| `CANARY-SEF-TRAILER-REEDIT-f61e` | Samsung trailer block 0x0be1 Photo_Editor_Re_Edit_Data | hidden | red | inferred | raw | no |

### jpeg-extended-xmp.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-XXMP-EXT-ANCESTOR-500-012c` | Extended XMP (APP1 xmp/extension chunks), photoshop:DocumentAncestors item 500 | hidden | red | spec | raw | yes |
| `CANARY-XXMP-EXT-ANCESTOR-1800-7f72` | Extended XMP, photoshop:DocumentAncestors item 1800 (past exiftool 1000-item limit) | hidden | red | spec | raw | no |
| `CANARY-XXMP-STD-CREATOR-37a1` | Standard XMP dc:creator | who | red | spec | raw | yes |

### png-everything.png

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-PNG-ICCP-PRIVATE-b9c6` | iCCP profile (compressed), private CNRY text tag | hidden | red | spec | zlib | yes |
| `CANARY-PNG-EXIF-ARTIST-cf6e` | eXIf chunk, IFD0 Artist | who | red | spec | raw | yes |
| `CANARY-PNG-EXIF-SOFTWARE-d0b2` | eXIf chunk, IFD0 Software | device | amber | spec | raw | yes |
| `CANARY-PNG-RAWEXIF-ARTIST-8a4d` | tEXt "Raw profile type exif" (hex), IFD0 Artist | who | red | spec | hex | yes |
| `CANARY-PNG-XMP-CREATORTOOL-a69e` | iTXt XML:com.adobe.xmp, xmp:CreatorTool | device | amber | spec | raw | yes |
| `2024-07-21T14:03:09+01:00` | iTXt XMP xmp:CreateDate | when | amber | spec | raw | reformatted: `2024:07:21 14:03:09+01:00` |
| `CANARY-PNG-XMP-DOCUMENTID-93e7` | iTXt XMP xmpMM:DocumentID | hidden | red | spec | raw | yes |
| `CANARY-PNG-XMP-CITY-d0cc` | iTXt XMP photoshop:City | where | red | spec | raw | yes |
| `51,30.04374N` | iTXt XMP exif:GPSLatitude | where | red | spec | raw | reformatted: `51 deg 30' 2.62" N` |
| `CANARY-PNG-XMP-CREATOR-dc01` | iTXt XMP dc:creator | who | red | spec | raw | yes |
| `CANARY-PNG-ICCP-NAME-ccd5` | iCCP profile name field | hidden | red | spec | raw | yes |
| `CANARY-PNG-TEXT-AUTHOR-9ac0` | tEXt Author | who | red | spec | raw | yes |
| `Sun, 21 Jul 2024 14:03:09 +0100` | tEXt Creation Time | when | amber | spec | raw | reformatted: `2024:07:21 14:03:09+01:00` |
| `CANARY-PNG-TEXT-SOFTWARE-cebf` | tEXt Software | device | amber | spec | raw | yes |
| `CANARY-PNG-PRVT-bdfb` | Unknown ancillary chunk prVt | hidden | red | inferred | raw | no |
| `CANARY-PNG-TEXT-COMMENT-5816` | tEXt Comment, after IDAT | hidden | red | inferred | raw | yes |
| `CANARY-PNG-ZTXT-DESCRIPTION-ce5b` | zTXt Description (compressed), after IDAT | hidden | red | inferred | zlib | yes |
| `CANARY-PNG-ITXT-TITLE-7516` | iTXt Title, nb-NO, compressed, after IDAT | hidden | red | inferred | zlib | yes |
| `CANARY-PNG-AFTER-IEND-d5e1` | Bytes after IEND | hidden | red | inferred | raw | no |

### png-transparent.png

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-PNGA-TEXT-AUTHOR-dd7b` | tEXt Author | who | red | spec | raw | yes |
| `CANARY-PNGA-TEXT-SOFTWARE-e3d8` | tEXt Software | device | amber | spec | raw | yes |

### webp-everything.webp

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-WEBP-ICCP-PRIVATE-bba6` | ICCP chunk, private CNRY text tag | hidden | red | spec | raw | yes |
| `CANARY-WEBP-EXIF-MAKE-7279` | EXIF chunk, IFD0 Make | device | amber | spec | raw | yes |
| `CANARY-WEBP-EXIF-ARTIST-3c29` | EXIF chunk, IFD0 Artist | who | red | spec | raw | yes |
| `2024:09:08 12:34:56` | EXIF chunk, DateTimeOriginal | when | amber | spec | raw | yes |
| `CANARY-WEBP-XMP-CREATORTOOL-9f28` | XMP chunk, xmp:CreatorTool | device | amber | spec | raw | yes |
| `CANARY-WEBP-XMP-DOCUMENTID-f1de` | XMP chunk, xmpMM:DocumentID | hidden | red | spec | raw | yes |
| `41,24.21774N` | XMP chunk, exif:GPSLatitude | where | red | spec | raw | reformatted: `41 deg 24' 13.06" N` |
| `CANARY-WEBP-XMP-CREATOR-b00c` | XMP chunk, dc:creator | who | red | spec | raw | yes |
| `CANARY-WEBP-PRVT-06fc` | Unknown RIFF chunk PRVT | hidden | red | inferred | raw | no |

### heic-everything.heic

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-HEIC-THUMB-COM-20c0` | EXIF IFD1 thumbnail, COM inside it | hidden | red | spec | raw | no |
| `CANARY-HEIC-EXIF-MAKE-a806` | EXIF item, IFD0 Make | device | amber | spec | raw | yes |
| `CANARY-HEIC-EXIF-MODEL-e9bd` | EXIF item, IFD0 Model | device | amber | spec | raw | yes |
| `CANARY-HEIC-EXIF-ARTIST-bbc1` | EXIF item, IFD0 Artist | who | red | spec | raw | yes |
| `CANARY-HEIC-EXIF-BODYSERIAL-fe03` | EXIF item, BodySerialNumber | who | red | spec | raw | yes |
| `2024:04:12 16:20:00` | EXIF item, DateTimeOriginal | when | amber | spec | raw | yes |
| `CANARY-HEIC-XMP-CREATOR-19d6` | XMP item, dc:creator | who | red | spec | raw | yes |
| `CANARY-HEIC-XMP-CREATORTOOL-5416` | XMP item, xmp:CreatorTool | device | amber | spec | raw | yes |

### jpeg-large.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-LARGE-EXIF-MAKE-c88b` | EXIF IFD0 Make | device | amber | spec | raw | yes |
| `CANARY-LARGE-EXIF-ARTIST-6bd9` | EXIF IFD0 Artist | who | red | spec | raw | yes |
| `2023:08:19 06:58:41` | EXIF DateTimeOriginal | when | amber | spec | raw | yes |
| `CANARY-LARGE-GPS-AREA-74c3` | EXIF GPS IFD GPSAreaInformation | where | red | spec | raw | yes |

### not-an-image.pdf

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-PDF-INFO-AUTHOR-ef4d` | PDF Info dictionary /Author | who | red | inferred | raw | yes |
| `CANARY-PDF-INFO-TITLE-5e7f` | PDF Info dictionary /Title | hidden | red | inferred | raw | yes |

### truncated.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-TRUNC-EXIF-ARTIST-8d39` | EXIF IFD0 Artist (file cut off at 2,048 bytes, inside the scan data) | who | red | spec | raw | yes |

### jpeg-double-exif.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-DBLEXIF-FIRST-MAKE-a133` | First EXIF APP1, IFD0 Make | device | amber | spec | raw | yes |
| `CANARY-DBLEXIF-FIRST-ARTIST-cad8` | First EXIF APP1, IFD0 Artist | who | red | spec | raw | yes |
| `CANARY-DBLEXIF-SECOND-ARTIST-ca11` | Second EXIF APP1, IFD0 Artist | who | red | spec | raw | yes |
| `CANARY-DBLEXIF-SECOND-GPS-AREA-0202` | Second EXIF APP1, GPS GPSAreaInformation | where | red | spec | raw | yes |

### jpeg-ifd-cycle.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-CYCLE-EXIF-ARTIST-fc3d` | EXIF IFD0 Artist, the one well-formed tag in a hostile IFD (cycle) | who | red | spec | raw | yes |

### jpeg-ifd-overflow.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-OVERFLOW-EXIF-ARTIST-783a` | EXIF IFD0 Artist, the one well-formed tag in a hostile IFD (overflow) | who | red | spec | raw | yes |

### jpeg-icc-text.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-ICCTEXT-JPEG-DESC-e070` | ICC profile (APP2), mluc description | hidden | red | spec | utf16 | yes |
| `CANARY-ICCTEXT-JPEG-CPRT-ab2c` | ICC profile (APP2), mluc copyright | hidden | red | spec | utf16 | yes |
| `CANARY-ICCTEXT-JPEG-DMND-266f` | ICC profile (APP2), mluc device manufacturer description | hidden | red | spec | utf16 | yes |

### png-icc-text.png

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-ICCTEXT-PNG-DESC-1396` | iCCP profile (compressed), description | hidden | red | spec | zlib | yes |
| `CANARY-ICCTEXT-PNG-CPRT-1de7` | iCCP profile (compressed), copyright | hidden | red | spec | zlib | yes |
| `CANARY-ICCTEXT-PNG-NAME-22d5` | iCCP profile name field (a name, not a known profile name) | hidden | red | spec | raw | yes |

### webp-icc-text.webp

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-ICCTEXT-WEBP-CPRT-f47f` | ICCP chunk, copyright | hidden | red | spec | raw | yes |
| `CANARY-ICCTEXT-WEBP-DMDD-a2fc` | ICCP chunk, device model description | hidden | red | spec | raw | yes |

### heic-icc-text.heic

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-ICCTEXT-HEIC-DESC-4365` | colr property (ICC profile), mluc description | hidden | red | spec | utf16 | yes |
| `CANARY-ICCTEXT-HEIC-CPRT-3c21` | colr property (ICC profile), mluc copyright | hidden | red | spec | utf16 | yes |

### jpeg-green-xmp.jpg

| String | Location | Group | Tier | Basis | Stored as | exiftool sees |
|---|---|---|---|---|---|---|
| `CANARY-GREENXMP-RATING-a280` | XMP xmp:Rating holding text instead of a number | hidden | red | spec | raw | yes |
| `CANARY-GREENXMP-ICCPROFILE-eb0f` | XMP photoshop:ICCProfile holding a name, not a known profile name | hidden | red | spec | raw | yes |
| `CANARY-GREENXMP-GPANO-PROJECTION-e34c` | XMP GPano:ProjectionType holding text, not one of the projection names | hidden | red | spec | raw | yes |
