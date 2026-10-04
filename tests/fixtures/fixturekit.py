#!/usr/bin/env python3
"""fixturekit.py: byte-level helpers for make-fixtures.sh.

Python standard library only. Each subcommand builds or rewrites one kind of
container structure (JPEG segments, PNG chunks, RIFF chunks, ISO BMFF boxes,
TIFF directories, JUMBF boxes) and never decodes or re-encodes pixels.

Usage: python3 fixturekit.py <subcommand> [arguments]
Run with no arguments for the list of subcommands.

Everything here is deterministic: no clocks, no unseeded randomness, so the
fixture corpus is byte-identical from run to run on the same tool versions.
"""
import binascii
import hashlib
import json
import os
import random
import struct
import subprocess
import sys
import zlib


def read(path):
    with open(path, 'rb') as f:
        return f.read()


def write(path, data):
    with open(path, 'wb') as f:
        f.write(data)


def die(msg):
    sys.stderr.write('fixturekit: ' + msg + '\n')
    sys.exit(1)


# JPEG segments

def jpeg_header_segments(data):
    """Return [(offset, marker, total_length)] from SOI up to and including the first SOS."""
    if data[:2] != b'\xff\xd8':
        die('not a JPEG (no SOI)')
    out = [(0, 0xD8, 2)]
    pos = 2
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            die('expected a marker at offset %d' % pos)
        marker = data[pos + 1]
        if marker == 0xFF:
            pos += 1
            continue
        length = struct.unpack('>H', data[pos + 2:pos + 4])[0]
        out.append((pos, marker, length + 2))
        if marker == 0xDA:
            return out
        pos += 2 + length
    die('no SOS segment found')


def segment(marker, payload):
    if len(payload) + 2 > 0xFFFF:
        die('segment payload too large for one JPEG segment: %d bytes' % len(payload))
    return bytes([0xFF, marker]) + struct.pack('>H', len(payload) + 2) + payload


def jpeg_position(data, where):
    """'after-soi', 'after:e2' (after the last such segment) or 'before:c0' (before the first)."""
    if where == 'after-soi':
        return 2
    kind, hexm = where.split(':')
    marker = int(hexm, 16)
    hits = [s for s in jpeg_header_segments(data) if s[1] == marker]
    if not hits:
        die('marker %s not found' % hexm)
    if kind == 'after':
        off, _, length = hits[-1]
        return off + length
    if kind == 'before':
        return hits[0][0]
    die('unknown position ' + where)


def cmd_jpeg_insert(args):
    """jpeg-insert IN OUT WHERE MARKERHEX:PAYLOADFILE [...]: insert raw segments at one position."""
    src, dst, where = args[0], args[1], args[2]
    data = read(src)
    pos = jpeg_position(data, where)
    blob = b''
    for spec in args[3:]:
        hexm, path = spec.split(':', 1)
        blob += segment(int(hexm, 16), read(path))
    write(dst, data[:pos] + blob + data[pos:])


def cmd_jpeg_exif(args):
    """jpeg-exif IN OUT [INDEX]: copy the TIFF payload of the INDEXth EXIF APP1 (no 'Exif' header)."""
    data = read(args[0])
    want = int(args[2]) if len(args) > 2 else 0
    found = 0
    for off, marker, length in jpeg_header_segments(data):
        payload = data[off + 4:off + length]
        if marker == 0xE1 and payload.startswith(b'Exif\0\0'):
            if found == want:
                write(args[1], payload[6:])
                return
            found += 1
    die('no EXIF APP1 number %d in %s' % (want, args[0]))


def cmd_jpeg_segment(args):
    """jpeg-segment IN OUT MARKERHEX PREFIX: copy the payload of the first segment whose payload starts with PREFIX."""
    data = read(args[0])
    marker = int(args[2], 16)
    prefix = args[3].encode('latin-1')
    for off, m, length in jpeg_header_segments(data):
        payload = data[off + 4:off + length]
        if m == marker and payload.startswith(prefix):
            write(args[1], payload)
            return
    die('segment not found')


def cmd_sos_offset(args):
    """sos-offset IN: print the byte offset of the first SOS marker."""
    print(jpeg_header_segments(read(args[0]))[-1][0])


def cmd_xmp_payload(args):
    """xmp-payload IN.xml OUT: wrap an XMP document in an xpacket and the APP1 namespace header."""
    xml = read(args[0]).strip()
    packet = (b'<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
              + xml + b'\n<?xpacket end="w"?>')
    write(args[1], b'http://ns.adobe.com/xap/1.0/\0' + packet)


def cmd_xpacket(args):
    """xpacket IN.xml OUT [odd]: wrap XMP in an xpacket with no namespace header (PNG, WebP).
    With 'odd', pad with one space if needed so the length is odd (forces a RIFF pad byte)."""
    xml = read(args[0]).strip()
    packet = (b'<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
              + xml + b'\n<?xpacket end="w"?>')
    if len(args) > 2 and args[2] == 'odd' and len(packet) % 2 == 0:
        packet = packet.replace(b'<?xpacket end', b' <?xpacket end')
    write(args[1], packet)


def cmd_blob(args):
    """blob OUT SIZE SEED TEXT [PREFIX]: deterministic pseudo-random bytes with TEXT embedded in the middle."""
    out, size, seed, text = args[0], int(args[1]), int(args[2]), args[3].encode('ascii')
    prefix = args[4].encode('latin-1') if len(args) > 4 else b''
    rng = random.Random(seed)
    filler = bytes(rng.randrange(256) for _ in range(max(0, size - len(prefix) - len(text))))
    half = len(filler) // 2
    write(out, prefix + filler[:half] + text + filler[half:])


def cmd_mpf(args):
    """mpf PRIMARY GAINMAP OUT WHERE: add an MPF APP2 index to PRIMARY and append GAINMAP after its EOI.

    Offsets follow CIPA DC-007: the second image's offset is relative to the
    MP header (the byte order mark right after 'MPF\\0')."""
    primary, gain, out, where = read(args[0]), read(args[1]), args[2], args[3]
    if not primary.endswith(b'\xff\xd9') or not gain.startswith(b'\xff\xd8'):
        die('mpf: primary must end with EOI and gain map must start with SOI')

    def build(primary_len, gain_off):
        entries_off = 8 + 2 + 3 * 12 + 4
        tiff = b'MM\x00\x2a' + struct.pack('>I', 8)
        tiff += struct.pack('>H', 3)
        tiff += struct.pack('>HHI', 0xB000, 7, 4) + b'0100'            # MPFVersion
        tiff += struct.pack('>HHII', 0xB001, 4, 1, 2)                   # NumberOfImages
        tiff += struct.pack('>HHII', 0xB002, 7, 32, entries_off)        # MPEntry
        tiff += struct.pack('>I', 0)                                    # no attribute IFD
        tiff += struct.pack('>IIIHH', 0x20030000, primary_len, 0, 0, 0)  # representative, baseline primary
        tiff += struct.pack('>IIIHH', 0x00000000, len(gain), gain_off, 0, 0)
        return b'MPF\0' + tiff

    pos = jpeg_position(primary, where)
    seg_len = len(segment(0xE2, build(0, 0)))
    primary_len = len(primary) + seg_len
    mp_header = pos + 8
    seg = segment(0xE2, build(primary_len, primary_len - mp_header))
    write(out, primary[:pos] + seg + primary[pos:] + gain)


XMP_HEADER = b'http://ns.adobe.com/xap/1.0/\0'
ISO_GAIN_ID = b'urn:iso:std:iso:ts:21496:-1\0'


def xmp_segment_payload(xml):
    packet = (b'<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
              + xml + b'\n<?xpacket end="w"?>')
    return XMP_HEADER + packet


def tiff_ifd(bo, tags, off, nxt):
    """One TIFF IFD at offset OFF (from the TIFF header) with out-of-line values right after it.
    tags: [(tag, type, count, value bytes)] in order. Returns the IFD and its values as bytes."""
    head = struct.pack(bo + 'H', len(tags))
    values = b''
    at = off + 2 + 12 * len(tags) + 4
    for tag, typ, count, data in tags:
        if len(data) <= 4:
            field = data + b'\0' * (4 - len(data))
        else:
            field = struct.pack(bo + 'I', at + len(values))
            values += data + (b'\0' if len(data) % 2 else b'')
        head += struct.pack(bo + 'HHI', tag, typ, count) + field
    return head + struct.pack(bo + 'I', nxt) + values


def mpf_payload(le, entries, ids=None, b004=None, attr=None, tail=b''):
    """'MPF\0' and an MP header with an MP Index IFD (B000, B001, B002 and optionally B003 and
    B004), the MP entry table, optionally an MP Attribute IFD, then TAIL. entries are
    (attribute, size, offset, dependent 1, dependent 2)."""
    bo = '<' if le else '>'
    n = len(entries)
    table = b''.join(struct.pack(bo + 'IIIHH', *e) for e in entries)
    tags = [(0xB000, 7, 4, b'0100'), (0xB001, 4, 1, struct.pack(bo + 'I', n)), (0xB002, 7, 16 * n, table)]
    if ids is not None:
        tags.append((0xB003, 7, len(ids), ids))
    if b004 is not None:
        tags.append((0xB004, 4, 1, struct.pack(bo + 'I', b004)))
    index_len = len(tiff_ifd(bo, tags, 8, 0))
    attr_at = 8 + index_len if attr else 0
    body = tiff_ifd(bo, tags, 8, attr_at)
    if attr:
        body += tiff_ifd(bo, attr, attr_at, 0)
    head = (b'II' if le else b'MM') + struct.pack(bo + 'HI', 42, 8)
    return b'MPF\0' + head + body + tail


def iso_full_block():
    """An ISO 21496-1 gain map block: three channels, each value with its own denominator."""
    out = ISO_GAIN_ID + struct.pack('>HH', 0, 0) + bytes([0x80])
    out += struct.pack('>IIII', 0, 1, 23, 10)  # base and alternate HDR headroom
    for _ in range(3):
        out += struct.pack('>iIiIIIiIiI', 0, 1, 23, 10, 1, 1, 1, 64, 1, 64)
    return out


def cmd_uhdr(args):
    """uhdr PRIMARY GAINMAP OUT KIND [CANARY ...]: build an Ultra HDR style picture from two plain JPEGs.

    The photo gets an XMP packet with hdrgm:Version and a Container directory, and an MPF
    index whose second entry is the gain map, appended after its EOI. The gain map gets its
    own hdrgm description. KIND adds one thing a scrubber must find while keeping the gain
    map: hdrgm-extra, item-label, apple-owner, after-eoi, bare-after-eoi, mpf-tail,
    apple (an iPhone-style picture: no XMP in the photo, an Apple MakerNote holding the HDR
    headroom and a planted text tag, a gain map named by apdi:AuxiliaryImageType with
    HDRGainMapVersion and a planted extra apdi field), apple-wrong (the same with planted
    text in the apdi:AuxiliaryImageType value),
    inner-hdrgm, iso-tail, inner-mpf, inner-iso, version-text, mpf-extras, dir-semantic
    (a third directory entry whose role is free text), dir-mime (free text as the gain
    map entry's file type), inner-gpano (a name in a technical XMP field of the gain map)
    (no canary needed for iso-full and zero-pad) or not-gainmap (PRIMARY is then also the
    second picture, a full-size colour copy, so it is no gain map at all)."""
    primary, gain, out, kind = read(args[0]), read(args[1]), args[2], args[3]
    can = [c.encode('ascii') for c in args[4:]]
    need = {'hdrgm-extra': 2, 'mpf-extras': 2, 'apple': 2, 'iso-full': 0, 'zero-pad': 0}.get(kind, 1)
    if len(can) != need:
        die('uhdr %s takes %d planted strings' % (kind, need))
    if not primary.endswith(b'\xff\xd9') or not gain.startswith(b'\xff\xd8'):
        die('uhdr: the photo must end with EOI and the gain map must start with SOI')
    hdrgm = b'xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"'
    gm_fields = (b' hdrgm:Version="1.0" hdrgm:GainMapMin="0" hdrgm:GainMapMax="2.3" hdrgm:Gamma="1"'
                 b' hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" hdrgm:HDRCapacityMin="0"'
                 b' hdrgm:HDRCapacityMax="2.3" hdrgm:BaseRenditionIsHDR="False"')
    gm_extra, gm_toolkit, gm_body = b'', b'', b''
    if kind == 'inner-hdrgm':
        gm_extra = b' hdrgm:CameraSerialNumber="SN-' + can[0] + b'"'
    if kind == 'after-eoi':
        gm_toolkit = b' x:xmptk="Fjord XMP Core 1.0"'
    if kind == 'inner-gpano':
        gm_extra = b' xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:Note="Astrid Holmvik ' + can[0] + b'"'
    if kind == 'iso-full':
        gm_fields = gm_fields.replace(b' hdrgm:GainMapMax="2.3"', b'')
        gm_body = (b'\n   <hdrgm:GainMapMax><rdf:Seq><rdf:li>2.3</rdf:li><rdf:li>2.2</rdf:li>'
                   b'<rdf:li>2.1</rdf:li></rdf:Seq></hdrgm:GainMapMax>\n  ')
    desc_close = (b'>' + gm_body + b'</rdf:Description>') if gm_body else b'/>'
    gm_xml = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/"' + gm_toolkit + b'>\n <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
              b'  <rdf:Description rdf:about="" ' + hdrgm + gm_fields + gm_extra + desc_close + b'\n </rdf:RDF>\n</x:xmpmeta>')
    if kind.startswith('apple'):
        aux = b'urn:com:apple:photo:2020:aux:hdrgainmap'
        stored = b'1278226488'
        if kind == 'apple':
            stored = b'Astrid Holmvik ' + can[1]
        else:
            aux += b' Astrid Holmvik ' + can[0]
        gm_xml = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/">\n <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
                  b'  <rdf:Description rdf:about="" xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/"'
                  b' xmlns:apdi="http://ns.apple.com/pixeldatainfo/1.0/">\n'
                  b'   <HDRGainMap:HDRGainMapVersion>65536</HDRGainMap:HDRGainMapVersion>\n'
                  b'   <apdi:AuxiliaryImageType>' + aux + b'</apdi:AuxiliaryImageType>\n'
                  b'   <apdi:NativeFormat>1278226488</apdi:NativeFormat>\n'
                  b'   <apdi:StoredFormat>' + stored + b'</apdi:StoredFormat>\n'
                  b'  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>')
    gm_segs = segment(0xE1, xmp_segment_payload(gm_xml))
    if kind == 'iso-full':
        gm_segs += segment(0xE2, iso_full_block())
    if kind == 'inner-iso':
        gm_segs += segment(0xE2, ISO_GAIN_ID + b'\0\0\0\0' + b' Astrid Holmvik ' + can[0])
    if kind == 'inner-mpf':
        gm_segs += segment(0xE2, b'MPF\0MM\0\x2a\0\0\0\x08\0\0\0\0\0\0' + b' Astrid Holmvik ' + can[0])
    if kind == 'not-gainmap':
        gm = primary[:2] + segment(0xFE, b'Uncropped original ' + can[0]) + primary[2:]
    else:
        pos = jpeg_position(gain, 'after:e0')
        gm = gain[:pos] + gm_segs + gain[pos:]
    lead = b'\0' * 32 if kind == 'zero-pad' else b''
    after = b''
    if kind in ('after-eoi', 'bare-after-eoi'):
        after = b'Astrid Holmvik SN998877 ' + can[0]
    if kind == 'zero-pad':
        after = b'\0' * 64
    gm_len = len(gm) + len(after)

    p_attrs, p_item, g_item, p_ns, more_li = b'', b'', b'', b'', b''
    version = b'1.0'
    g_mime = b'image/jpeg'
    if kind == 'dir-semantic':
        more_li = (b'     <rdf:li rdf:parseType="Resource">\n      <Container:Item Item:Semantic="AstridHolmvik' + can[0]
                   + b'" Item:Mime="image/astrid.holmvik" Item:Length="0"/>\n     </rdf:li>\n')
    if kind == 'dir-mime':
        g_mime = b'image/' + can[0]
    if kind == 'hdrgm-extra':
        p_attrs = (b'\n    hdrgm:CameraSerialNumber="Astrid Holmvik ' + can[0] + b'"'
                   b'\n    hdrgm:GPSLatitude="59,24.5N ' + can[1] + b'"')
    if kind == 'item-label':
        g_item = b' Item:Label="Astrid Holmvik ' + can[0] + b'"'
    if kind == 'apple-owner':
        p_ns = b'\n    xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/"'
        p_attrs = b'\n    HDRGainMap:HDRGainMapVersion="65536" HDRGainMap:OwnerName="Astrid Holmvik ' + can[0] + b'"'
    if kind == 'version-text':
        version = b'1.0 ' + can[0]
    if kind == 'zero-pad':
        # Padding on both entries: exiftool 13.25 fails on a directory where only one has it.
        p_item = b' Item:Padding="32"'
        g_item = b' Item:Padding="0"'
    p_xml = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/">\n <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
             b'  <rdf:Description rdf:about=""\n    ' + hdrgm + p_ns +
             b'\n    xmlns:Container="http://ns.google.com/photos/1.0/container/"'
             b'\n    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"'
             b'\n    hdrgm:Version="' + version + b'"' + p_attrs + b'>\n'
             b'   <Container:Directory>\n    <rdf:Seq>\n'
             b'     <rdf:li rdf:parseType="Resource">\n      <Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"' + p_item + b'/>\n     </rdf:li>\n'
             b'     <rdf:li rdf:parseType="Resource">\n      <Container:Item Item:Semantic="GainMap" Item:Mime="' + g_mime + b'" Item:Length="'
             + str(gm_len).encode() + b'"' + g_item + b'/>\n     </rdf:li>\n' + more_li +
             b'    </rdf:Seq>\n   </Container:Directory>\n  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>')
    head = segment(0xE1, xmp_segment_payload(p_xml))
    if kind.startswith('apple'):
        # Apple's MakerNote: "Apple iOS", version 1, big-endian, offsets from its own start;
        # tag 33 = 1.02 and tag 48 = 0.0064 (the HDR headroom), tag 11 a text tag.
        note_text = (b'Astrid Holmvik ' + can[0] if kind == 'apple' else b'FJORD-BURST-0001') + b'\0'
        mn_tags = [(0x0001, 9, 1, struct.pack('>i', 14)), (0x000B, 2, len(note_text), note_text),
                   (0x0021, 10, 1, struct.pack('>ii', 10200, 10000)), (0x0030, 10, 1, struct.pack('>ii', 64, 10000))]
        makernote = b'Apple iOS\0\0\x01MM' + tiff_ifd('>', mn_tags, 14, 0)
        ifd0 = [(0x010F, 2, 6, b'Apple\0'), (0x0112, 3, 1, struct.pack('>H', 1)), (0x8769, 4, 1, b'')]
        ifd0_len = len(tiff_ifd('>', [(t, ty, c, d if t != 0x8769 else b'\0\0\0\0') for t, ty, c, d in ifd0], 8, 0))
        exif_at = 8 + ifd0_len
        ifd0[2] = (0x8769, 4, 1, struct.pack('>I', exif_at))
        exif_ifd = tiff_ifd('>', [(0x927C, 7, len(makernote), makernote), (0xA001, 3, 1, struct.pack('>H', 1))], exif_at, 0)
        tiff = b'MM\0\x2a' + struct.pack('>I', 8) + tiff_ifd('>', ifd0, 8, 0) + exif_ifd
        head = segment(0xE1, b'Exif\0\0' + tiff)
    if kind == 'iso-tail':
        head += segment(0xE2, ISO_GAIN_ID + b'\0\0\0\0' + b' Astrid Holmvik ' + can[0])
    if kind == 'iso-full':
        head += segment(0xE2, ISO_GAIN_ID + b'\0\0\0\0')
    le = kind == 'mpf-extras'
    extra = {}
    if kind == 'mpf-extras':
        uid = can[0].ljust(32, b'0')[:32] + b'\0'
        extra['ids'] = uid + b'0' * 32 + b'\0'
        extra['b004'] = 2
        extra['attr'] = [(0xB101, 4, 1, struct.pack('<I', 1)), (0xB2EE, 2, len(can[1]) + 1, can[1] + b'\0')]
    if kind == 'mpf-tail':
        extra['tail'] = b' Astrid Holmvik ' + can[0]
    pos = jpeg_position(primary, 'after:e0')
    gm_type = 0x00000000

    def build(primary_len, gain_off):
        entries = [(0x20030000, primary_len, 0, 0, 0), (gm_type, gm_len, gain_off, 0, 0)]
        return segment(0xE2, mpf_payload(le, entries, **extra))

    size = len(primary) + len(head) + len(build(0, 0))
    mp_header = pos + len(head) + 8
    photo = primary[:pos] + head + build(size, size + len(lead) - mp_header) + primary[pos:]
    write(out, photo + lead + gm + after)


def cmd_samsung(args):
    """samsung OUT UTC_MS MCC REEDIT_TEXT: build a Samsung SEFH/SEFT trailer (little-endian)."""
    out, utc, mcc, reedit = args[0], args[1], args[2], args[3]
    blocks = [
        (0x0A01, b'Image_UTC_Data', utc.encode('ascii')),
        (0x0AA1, b'MCC_Data', mcc.encode('ascii')),
        (0x0BE1, b'Photo_Editor_Re_Edit_Data', reedit.encode('ascii')),
    ]
    area = b''
    placed = []
    for typ, name, payload in blocks:
        blk = struct.pack('<HHI', 0, typ, len(name)) + name + payload
        placed.append((typ, len(area), len(blk)))
        area += blk
    dir_pos = len(area)
    entries = b''.join(struct.pack('<HHII', 0, typ, dir_pos - start, size) for typ, start, size in placed)
    sefh = b'SEFH' + struct.pack('<II', 106, len(blocks)) + entries
    write(out, area + sefh + struct.pack('<I', len(sefh)) + b'SEFT')


# C2PA / JUMBF

C2PA_SUFFIX = bytes.fromhex('00110010800000AA00389B71')


def box(typ, payload):
    return struct.pack('>I', 8 + len(payload)) + typ + payload


def cbor(value):
    """Tiny CBOR encoder: dict, list, str, bytes, non-negative int, bool."""
    def head(major, n):
        if n < 24:
            return bytes([major << 5 | n])
        if n < 0x100:
            return bytes([major << 5 | 24, n])
        if n < 0x10000:
            return bytes([major << 5 | 25]) + struct.pack('>H', n)
        return bytes([major << 5 | 26]) + struct.pack('>I', n)
    if isinstance(value, bool):
        return b'\xf5' if value else b'\xf4'
    if isinstance(value, int):
        return head(0, value)
    if isinstance(value, bytes):
        return head(2, len(value)) + value
    if isinstance(value, str):
        raw = value.encode('utf-8')
        return head(3, len(raw)) + raw
    if isinstance(value, list):
        return head(4, len(value)) + b''.join(cbor(v) for v in value)
    if isinstance(value, dict):
        return head(5, len(value)) + b''.join(cbor(k) + cbor(v) for k, v in value.items())
    die('cbor: unsupported type %r' % type(value))


def jumd(type4, label):
    return box(b'jumd', type4 + C2PA_SUFFIX + b'\x03' + label.encode('utf-8') + b'\0')


def jumb(type4, label, *children):
    return box(b'jumb', jumd(type4, label) + b''.join(children))


def cmd_c2pa(args):
    """c2pa OUT1 OUT2 AUTHOR_TEXT GENERATOR_TEXT: a fake C2PA manifest store split over two APP11 payloads.

    The structure is real JUMBF (ISO 19566-5) with C2PA box types; the
    signature is random bytes, so no validator will accept it. Segment 2
    repeats the superbox LBox and TBox, as the JPEG XT packaging requires."""
    out1, out2, author, generator = args
    rng = random.Random(2024)
    manifest = 'urn:uuid:5f2c9a1e-7b3d-4c8e-9a6f-1d2e3c4b5a69'
    assertions = jumb(
        b'c2as', 'c2pa.assertions',
        jumb(b'json', 'stds.schema-org.CreativeWork',
             box(b'json', json.dumps({
                 '@context': 'https://schema.org',
                 '@type': 'CreativeWork',
                 'author': [{'@type': 'Person', 'name': author}],
             }, separators=(',', ':')).encode('utf-8'))),
        jumb(b'cbor', 'c2pa.actions',
             box(b'cbor', cbor({'actions': [{'action': 'c2pa.created',
                                             'digitalSourceType': 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture'}]}))),
    )
    claim = jumb(
        b'c2cl', 'c2pa.claim',
        box(b'cbor', cbor({
            'claim_generator': generator,
            'dc:format': 'image/jpeg',
            'instanceID': 'xmp:iid:0b6f3a52-91c4-4d7e-8e2a-6c1f0d9b7a34',
            'signature': 'self#jumbf=c2pa.signature',
            'assertions': [{'url': 'self#jumbf=c2pa.assertions/stds.schema-org.CreativeWork'},
                           {'url': 'self#jumbf=c2pa.assertions/c2pa.actions'}],
        })))
    signature = jumb(b'c2cs', 'c2pa.signature',
                     box(b'cbor', cbor(bytes(rng.randrange(256) for _ in range(1536)))))
    store = jumb(b'c2pa', 'c2pa', jumb(b'c2ma', manifest, assertions, claim, signature))
    split = store.index(claim)
    head = b'JP' + struct.pack('>HI', 1, 1)
    write(out1, head + store[:split])
    head = b'JP' + struct.pack('>HI', 1, 2)
    write(out2, head + store[:8] + store[split:])


# ICC

def cmd_icc(args):
    """icc SRC OUT TEXT: copy an ICC profile and add a private 'CNRY' text tag holding TEXT.

    The tag table grows by one entry, every existing tag offset shifts by 12,
    the size field is updated and the v4 profile ID is cleared (all zeros
    means 'not computed', which is valid)."""
    icc, out, text = read(args[0]), args[1], args[2]
    count = struct.unpack('>I', icc[128:132])[0]
    table = [struct.unpack('>4sII', icc[132 + 12 * i:144 + 12 * i]) for i in range(count)]
    body = icc[132 + 12 * count:]
    body += b'\0' * ((-len(body)) % 4)
    new_table = [(sig, off + 12, size) for sig, off, size in table]
    tag = b'text' + b'\0' * 4 + text.encode('ascii') + b'\0'
    tag_off = 132 + 12 * (count + 1) + len(body)
    new_table.append((b'CNRY', tag_off, len(tag)))
    tail = tag + b'\0' * ((-len(tag)) % 4)
    header = bytearray(icc[:128])
    struct.pack_into('>I', header, 0, tag_off + len(tail))
    header[84:100] = b'\0' * 16
    blob = bytes(header) + struct.pack('>I', count + 1)
    blob += b''.join(struct.pack('>4sII', *t) for t in new_table) + body + tail
    write(out, blob)


def cmd_icc_text(args):
    """icc-text SRC OUT FORM SIG=TEXT ...: copy an ICC profile with text tags replaced or added.

    FORM is mluc (one en-US record, UTF-16 text, as version 4 profiles store it) or ascii
    ('desc' type for the description, 'text' for the others, as version 2 stores it). The
    profile is laid out again: every other tag keeps its bytes (shared data stays shared),
    the size field is updated and the profile ID is cleared (all zeros means 'not
    computed', which is valid)."""
    icc, out, form = read(args[0]), args[1], args[2]
    new = {}
    for a in args[3:]:
        sig, text = a.split('=', 1)
        if len(sig) != 4:
            die('icc-text: a tag signature has four characters: ' + sig)
        t = text.encode('latin-1')
        if form == 'mluc':
            u = text.encode('utf-16-be')
            new[sig.encode('latin-1')] = b'mluc\0\0\0\0' + struct.pack('>II', 1, 12) + b'enUS' + struct.pack('>II', len(u), 28) + u
        elif sig == 'desc':
            new[sig.encode('latin-1')] = (b'desc\0\0\0\0' + struct.pack('>I', len(t) + 1) + t + b'\0'
                                          + b'\0' * 8 + b'\0' * 3 + b'\0' * 67)
        else:
            new[sig.encode('latin-1')] = b'text\0\0\0\0' + t + b'\0'
    count = struct.unpack('>I', icc[128:132])[0]
    tags = []
    for i in range(count):
        sig, off, size = struct.unpack('>4sII', icc[132 + 12 * i:144 + 12 * i])
        tags.append((sig, icc[off:off + size] if sig not in new else new.pop(sig)))
    tags += sorted(new.items())
    table, body, placed = [], b'', {}
    start = 132 + 12 * len(tags)
    for sig, data in tags:
        if data not in placed:
            placed[data] = start + len(body)
            body += data + b'\0' * ((-len(data)) % 4)
        table.append(struct.pack('>4sII', sig, placed[data], len(data)))
    header = bytearray(icc[:128])
    struct.pack_into('>I', header, 0, start + len(body))
    header[84:100] = b'\0' * 16
    write(out, bytes(header) + struct.pack('>I', len(tags)) + b''.join(table) + body)


# PNG

PNG_SIG = b'\x89PNG\r\n\x1a\n'


def png_chunk(typ, payload):
    return (struct.pack('>I', len(payload)) + typ + payload
            + struct.pack('>I', zlib.crc32(typ + payload) & 0xFFFFFFFF))


def png_chunks(data):
    if data[:8] != PNG_SIG:
        die('not a PNG')
    pos, out = 8, []
    while pos + 8 <= len(data):
        n, typ = struct.unpack('>I4s', data[pos:pos + 8])
        out.append((typ, data[pos + 8:pos + 8 + n]))
        pos += 12 + n
        if typ == b'IEND':
            break
    return out, data[pos:]


def raw_profile_text(name, data):
    """ImageMagick 'Raw profile type NAME' text: name, length, then hex in 72-character lines."""
    hexs = binascii.hexlify(data).decode('ascii')
    lines = [hexs[i:i + 72] for i in range(0, len(hexs), 72)]
    return '\n%s\n%8d\n%s\n' % (name, len(data), '\n'.join(lines))


def png_build_chunk(spec, base_dir):
    kind = spec['type']
    if kind == 'tEXt':
        return png_chunk(b'tEXt', spec['keyword'].encode('latin-1') + b'\0' + spec['text'].encode('latin-1'))
    if kind == 'zTXt':
        return png_chunk(b'zTXt', spec['keyword'].encode('latin-1') + b'\0\0'
                         + zlib.compress(spec['text'].encode('latin-1'), 9))
    if kind == 'iTXt':
        text = read(os.path.join(base_dir, spec['file'])) if 'file' in spec else spec['text'].encode('utf-8')
        compressed = spec.get('compressed', False)
        if compressed:
            text = zlib.compress(text, 9)
        return png_chunk(b'iTXt', spec['keyword'].encode('latin-1') + b'\0'
                         + bytes([1 if compressed else 0, 0])
                         + spec.get('lang', '').encode('ascii') + b'\0'
                         + spec.get('translated', '').encode('utf-8') + b'\0' + text)
    if kind == 'iCCP':
        profile = read(os.path.join(base_dir, spec['file']))
        return png_chunk(b'iCCP', spec['name'].encode('latin-1') + b'\0\0' + zlib.compress(profile, 9))
    if kind == 'eXIf':
        return png_chunk(b'eXIf', read(os.path.join(base_dir, spec['file'])))
    if kind == 'rawprofile':
        data = b'Exif\0\0' + read(os.path.join(base_dir, spec['file']))
        return png_chunk(b'tEXt', ('Raw profile type ' + spec['name']).encode('latin-1') + b'\0'
                         + raw_profile_text(spec['name'], data).encode('ascii'))
    if kind == 'tIME':
        return png_chunk(b'tIME', struct.pack('>HBBBBB', *spec['value']))
    if kind == 'pHYs':
        x, y, unit = spec['value']
        return png_chunk(b'pHYs', struct.pack('>IIB', x, y, unit))
    if kind == 'raw':
        return png_chunk(spec['chunk'].encode('ascii'), spec['text'].encode('latin-1'))
    die('png: unknown chunk spec ' + kind)


def cmd_png_build(args):
    """png-build SPEC.json: rebuild a PNG from IHDR and pixel data plus the chunks the spec lists.

    Keys: base, out, before (chunks before IDAT), after (chunks after IDAT),
    idat_split (bytes per IDAT chunk), trailer (text appended after IEND)."""
    spec = json.loads(read(args[0]))
    base_dir = os.path.dirname(os.path.abspath(args[0]))
    chunks, _ = png_chunks(read(spec['base']))
    ihdr = [p for t, p in chunks if t == b'IHDR'][0]
    idat = b''.join(p for t, p in chunks if t == b'IDAT')
    out = PNG_SIG + png_chunk(b'IHDR', ihdr)
    for c in spec.get('before', []):
        out += png_build_chunk(c, base_dir)
    step = spec.get('idat_split', 1 << 30)
    for i in range(0, len(idat), step):
        out += png_chunk(b'IDAT', idat[i:i + step])
    for c in spec.get('after', []):
        out += png_build_chunk(c, base_dir)
    out += png_chunk(b'IEND', b'')
    out += spec.get('trailer', '').encode('latin-1')
    write(spec['out'], out)


# WebP

def riff_chunks(data):
    if data[:4] != b'RIFF' or data[8:12] != b'WEBP':
        die('not a WebP file')
    pos, out = 12, []
    while pos + 8 <= len(data):
        fourcc = data[pos:pos + 4]
        n = struct.unpack('<I', data[pos + 4:pos + 8])[0]
        out.append((fourcc, data[pos + 8:pos + 8 + n]))
        pos += 8 + n + (n & 1)
    return out


def riff_chunk(fourcc, payload):
    return fourcc + struct.pack('<I', len(payload)) + payload + (b'\0' if len(payload) & 1 else b'')


def cmd_webp_build(args):
    """webp-build SPEC.json: wrap a simple lossy WebP in VP8X with ICCP, EXIF, XMP and unknown chunks.

    Keys: base, out, icc, exif (raw TIFF, as the WebP spec requires), xmp,
    unknown (list of [fourcc, text])."""
    spec = json.loads(read(args[0]))
    chunks = riff_chunks(read(spec['base']))
    vp8 = [p for f, p in chunks if f == b'VP8 ']
    if not vp8:
        die('webp-build: base must be a simple lossy (VP8) WebP')
    frame = vp8[0]
    if frame[3:6] != b'\x9d\x01\x2a':
        die('webp-build: VP8 start code missing')
    width = struct.unpack('<H', frame[6:8])[0] & 0x3FFF
    height = struct.unpack('<H', frame[8:10])[0] & 0x3FFF
    flags = 0x20 | 0x08 | 0x04
    vp8x = bytes([flags, 0, 0, 0]) + struct.pack('<I', width - 1)[:3] + struct.pack('<I', height - 1)[:3]
    body = b'WEBP' + riff_chunk(b'VP8X', vp8x)
    body += riff_chunk(b'ICCP', read(spec['icc']))
    body += riff_chunk(b'VP8 ', frame)
    exif = read(spec['exif'])
    if len(exif) % 2 == 0:
        exif += b'\0'  # odd length on purpose: the chunk needs a RIFF pad byte
    body += riff_chunk(b'EXIF', exif)
    body += riff_chunk(b'XMP ', read(spec['xmp']))
    for fourcc, text in spec.get('unknown', []):
        body += riff_chunk(fourcc.encode('ascii'), text.encode('ascii'))
    write(spec['out'], b'RIFF' + struct.pack('<I', len(body)) + body)


# MP4 (ISO BMFF)

def parse_boxes(data, start=0, end=None):
    end = len(data) if end is None else end
    pos, out = start, []
    while pos + 8 <= end:
        size, typ = struct.unpack('>I4s', data[pos:pos + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack('>Q', data[pos + 8:pos + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - pos
        out.append((typ, pos, hdr, size))
        pos += size
    return out


LANG_ENG = 0x15C7


def fixed1616(v):
    return struct.pack('>i', int(round(v * 65536)))


def loci_box(name, lat, lon, alt):
    """3GPP TS 26.244 location box: name, role 0 (shooting), longitude, latitude, altitude."""
    payload = struct.pack('>IH', 0, LANG_ENG) + name.encode('utf-8') + b'\0' + b'\0'
    payload += fixed1616(lon) + fixed1616(lat) + fixed1616(alt) + b'earth\0' + b'\0'
    return box(b'loci', payload)


def xyz_box(text):
    raw = text.encode('ascii')
    return box(b'\xa9xyz', struct.pack('>HH', len(raw), LANG_ENG) + raw)


def ilst_item(tag, text):
    return box(tag, box(b'data', struct.pack('>II', 1, 0) + text.encode('utf-8')))


def cmd_mp4_udta(args):
    """mp4-udta IN OUT XYZ PLACE LAT LON ALT: replace udta/loci with a named one and add a QuickTime ©xyz.

    The movie box must come after mdat (no faststart), so growing it moves no
    sample data and every chunk offset stays valid."""
    data = read(args[0])
    out, xyz, place = args[1], args[2], args[3]
    lat, lon, alt = float(args[4]), float(args[5]), float(args[6])
    top = parse_boxes(data)
    kinds = [t for t, _, _, _ in top]
    if b'moov' not in kinds or b'mdat' not in kinds or kinds.index(b'moov') < kinds.index(b'mdat'):
        die('mp4-udta: expected mdat before moov')
    _, mpos, mhdr, msize = [b for b in top if b[0] == b'moov'][0]
    children = parse_boxes(data, mpos + mhdr, mpos + msize)
    new_moov = b''
    seen_udta = False
    for typ, pos, hdr, size in children:
        if typ != b'udta':
            new_moov += data[pos:pos + size]
            continue
        seen_udta = True
        kept = b''
        for t2, p2, h2, s2 in parse_boxes(data, pos + hdr, pos + size):
            if t2 not in (b'loci', b'\xa9xyz'):
                kept += data[p2:p2 + s2]
        new_moov += box(b'udta', kept + loci_box(place, lat, lon, alt) + xyz_box(xyz))
    if not seen_udta:
        new_moov += box(b'udta', loci_box(place, lat, lon, alt) + xyz_box(xyz))
    write(out, data[:mpos] + box(b'moov', new_moov) + data[mpos + msize:])


def cmd_mp4_minimal(args):
    """mp4-minimal OUT XYZ PLACE LAT LON ALT TITLE COMMENT: a hand-built MP4 with no tracks.

    Used only when ffmpeg is missing: ftyp, a tiny mdat, and a moov holding
    mvhd plus udta (loci, ©xyz and an iTunes-style ilst with title and comment)."""
    out, xyz, place = args[0], args[1], args[2]
    lat, lon, alt = float(args[3]), float(args[4]), float(args[5])
    title, comment = args[6], args[7]
    ftyp = box(b'ftyp', b'isom' + struct.pack('>I', 0x200) + b'isomiso2mp41')
    mdat = box(b'mdat', b'\0' * 16)
    matrix = struct.pack('>9I', 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)
    mvhd = box(b'mvhd', struct.pack('>IIIII', 0, 0, 0, 1000, 1000) + struct.pack('>IH', 0x10000, 0x100)
               + b'\0' * 10 + matrix + b'\0' * 24 + struct.pack('>I', 1))
    hdlr = box(b'hdlr', struct.pack('>II', 0, 0) + b'mdir' + b'appl' + b'\0' * 8 + b'\0')
    ilst = box(b'ilst', ilst_item(b'\xa9nam', title) + ilst_item(b'\xa9cmt', comment))
    meta = box(b'meta', struct.pack('>I', 0) + hdlr + ilst)
    udta = box(b'udta', meta + loci_box(place, lat, lon, alt) + xyz_box(xyz))
    write(out, ftyp + mdat + box(b'moov', mvhd + udta))


# Hostile TIFF structures

def tiff_entry(bo, tag, typ, count, value):
    return struct.pack(bo + 'HHI', tag, typ, count) + value


def cmd_hostile_exif(args):
    """hostile-exif KIND OUT ARTIST: an APP1 'Exif' payload built to trip naive parsers.

    cycle:    IFD0 -> IFD1 -> IFD0 through next-IFD links, the Exif IFD pointer
              aims at IFD0 itself and the GPS IFD links to itself.
    overflow: counts and offsets that point far outside the segment, an
              unknown field type, a count whose byte size wraps a 32-bit
              integer, and an Exif IFD whose entry count runs past the end.
    Both keep one well-formed Artist tag so inspect() still has something
    real to report."""
    kind, out, artist = args[0], args[1], args[2].encode('ascii') + b'\0'
    bo = '<'
    if kind == 'cycle':
        n0 = 4
        ifd0 = 8
        make = b'Fjordcam\0'
        data_off = ifd0 + 2 + n0 * 12 + 4
        make_off = data_off
        artist_off = make_off + len(make)
        gps_off = artist_off + len(artist)
        gps_off += gps_off & 1
        ifd1_off = gps_off + 2 + 1 * 12 + 4
        t = b'II\x2a\x00' + struct.pack('<I', ifd0)
        t += struct.pack('<H', n0)
        t += tiff_entry(bo, 0x010F, 2, len(make), struct.pack('<I', make_off))
        t += tiff_entry(bo, 0x013B, 2, len(artist), struct.pack('<I', artist_off))
        t += tiff_entry(bo, 0x8769, 4, 1, struct.pack('<I', ifd0))       # Exif IFD -> IFD0
        t += tiff_entry(bo, 0x8825, 4, 1, struct.pack('<I', gps_off))
        t += struct.pack('<I', ifd1_off)                                  # next -> IFD1
        t += make + artist
        t += b'\0' * (gps_off - len(t))
        t += struct.pack('<H', 1) + tiff_entry(bo, 0x0000, 1, 4, bytes([2, 3, 0, 0]))
        t += struct.pack('<I', gps_off)                                   # GPS next -> itself
        t += struct.pack('<H', 1) + tiff_entry(bo, 0x0103, 3, 1, struct.pack('<HH', 6, 0))
        t += struct.pack('<I', ifd0)                                      # IFD1 next -> IFD0
    elif kind == 'overflow':
        n0 = 7
        ifd0 = 8
        data_off = ifd0 + 2 + n0 * 12 + 4
        artist_off = data_off
        exif_off = artist_off + len(artist)
        exif_off += exif_off & 1
        t = b'II\x2a\x00' + struct.pack('<I', ifd0)
        t += struct.pack('<H', n0)
        t += tiff_entry(bo, 0x010E, 2, 0x7FFFFFFF, struct.pack('<I', 0xFFFFFF00))  # ImageDescription
        t += tiff_entry(bo, 0x010F, 2, 9, struct.pack('<I', 0x00100000))         # Make, past the end
        t += tiff_entry(bo, 0x0110, 99, 4, b'ABCD')                              # Model, type 99
        t += tiff_entry(bo, 0x0111, 4, 0x40000001, struct.pack('<I', 0))         # 4 * count wraps to 4
        t += tiff_entry(bo, 0x013B, 2, len(artist), struct.pack('<I', artist_off))
        t += tiff_entry(bo, 0x8769, 4, 1, struct.pack('<I', exif_off))
        t += tiff_entry(bo, 0x8825, 4, 1, struct.pack('<I', 0xFFFFFFF0))         # GPS IFD, past the end
        t += struct.pack('<I', 0x7FFFFFFF)                                       # next IFD, past the end
        t += artist
        t += b'\0' * (exif_off - len(t))
        t += struct.pack('<H', 0xFFFF)                                           # claims 65535 entries
        t += tiff_entry(bo, 0x9003, 2, 20, struct.pack('<I', 0))
    else:
        die('hostile-exif: kind must be cycle or overflow')
    write(out, b'Exif\0\0' + t)


# PDF

def cmd_pdf(args):
    """pdf OUT AUTHOR TITLE: a one-page PDF with an Info dictionary, for format-rejection tests."""
    out, author, title = args
    content = b'0.16 0.36 0.62 rg 72 640 451 120 re f\n0.95 0.75 0.2 rg 260 520 75 75 re f\n'
    objs = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << >> >>',
        b'<< /Length %d >>\nstream\n' % len(content) + content + b'endstream',
        ('<< /Author (%s) /Title (%s) /Creator (Fjord Writer 2.4) /Producer (Fjord PDF 1.1) '
         "/CreationDate (D:20240903101112+02'00') >>" % (author, title)).encode('latin-1'),
    ]
    pdf = b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(pdf))
        pdf += b'%d 0 obj\n' % i + body + b'\nendobj\n'
    xref = len(pdf)
    pdf += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1)
    pdf += b''.join(b'%010d 00000 n \n' % o for o in offsets)
    pdf += b'trailer\n<< /Size %d /Root 1 0 R /Info 5 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, xref)
    write(out, pdf)


# Canary registry: verification, exiftool visibility, report

def load_registry(path):
    rows = []
    with open(path, encoding='utf-8') as f:
        header = f.readline().rstrip('\n').split('\t')
        for line in f:
            if line.strip():
                rows.append(dict(zip(header, line.rstrip('\n').split('\t'))))
    return rows


def haystacks(path):
    """Return {'raw': bytes, 'zlib': bytes, 'hex': bytes}: the file itself, every zlib stream
    inside PNG text and ICC chunks inflated, and every PNG raw profile hex-decoded."""
    data = read(path)
    inflated, decoded = b'', b''
    if data.startswith(PNG_SIG):
        chunks, _ = png_chunks(data)
        for typ, payload in chunks:
            try:
                if typ in (b'zTXt', b'iCCP'):
                    nul = payload.index(b'\0')
                    inflated += zlib.decompress(payload[nul + 2:]) + b'\n'
                elif typ == b'iTXt':
                    nul = payload.index(b'\0')
                    if payload[nul + 1] == 1:
                        rest = payload[nul + 3:]
                        rest = rest[rest.index(b'\0') + 1:]
                        rest = rest[rest.index(b'\0') + 1:]
                        inflated += zlib.decompress(rest) + b'\n'
                elif typ == b'tEXt' and payload.startswith(b'Raw profile type '):
                    text = payload[payload.index(b'\0') + 1:].decode('latin-1').split('\n')
                    decoded += binascii.unhexlify(''.join(text[3:]).strip()) + b'\n'
            except (ValueError, zlib.error, binascii.Error, IndexError):
                pass
    return {'raw': data, 'zlib': inflated, 'hex': decoded}


def find_all(hay, needle):
    """Count the needle in each haystack, plus UTF-16 (either byte order) in the raw bytes."""
    hits = {}
    for kind, blob in hay.items():
        n = blob.count(needle)
        if n:
            hits[kind] = n
    text = needle.decode('latin-1')
    n = hay['raw'].count(text.encode('utf-16-be')) + hay['raw'].count(text.encode('utf-16-le'))
    if n:
        hits['utf16'] = n
    return hits


def cmd_verify(args):
    """verify REGISTRY.tsv OUTDIR: every planted string is present where the registry says,
    each canary lives in exactly one fixture, and no string contains another."""
    rows = load_registry(args[0])
    outdir = args[1]
    problems = []
    strings = [r['string'] for r in rows]
    for s in set(strings):
        if strings.count(s) > 1:
            problems.append('string registered twice: ' + s)
    for a in strings:
        for b in strings:
            if a != b and a in b:
                problems.append('"%s" is contained in "%s", so grep results would be ambiguous' % (a, b))
    files = sorted({r['file'] for r in rows})
    stacks = {f: haystacks(os.path.join(outdir, f)) for f in files}
    for r in rows:
        needle = r['string'].encode('latin-1')
        hits = find_all(stacks[r['file']], needle)
        if r['encoding'] not in hits:
            problems.append('%s: "%s" not found as %s (found: %s)' % (r['file'], r['string'], r['encoding'], hits or 'nowhere'))
        if r['kind'] == 'canary':
            for f in files:
                if f != r['file'] and find_all(stacks[f], needle):
                    problems.append('canary %s also appears in %s' % (r['string'], f))
    if problems:
        sys.stderr.write('\n'.join(problems) + '\n')
        die('%d registry problems' % len(problems))
    print('verify: %d planted strings in %d fixtures, all present, all unique' % (len(rows), len(files)))


def cmd_visibility(args):
    """visibility REGISTRY.tsv OUTDIR DUMPDIR RESULT.tsv: run exiftool -a -u -G1 -ee on each fixture
    and record which planted strings appear in its text output."""
    rows = load_registry(args[0])
    outdir, dumpdir, result = args[1], args[2], args[3]
    os.makedirs(dumpdir, exist_ok=True)
    dumps = {}
    for f in sorted({r['file'] for r in rows} | set(n for n in os.listdir(outdir) if os.path.isfile(os.path.join(outdir, n)) and not n.endswith(('.tsv', '.md', 'SUMS')) and not n.startswith('.'))):
        proc = subprocess.run(['exiftool', '-a', '-u', '-G1', '-ee', os.path.join(outdir, f)],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        text = proc.stdout.decode('utf-8', 'replace')
        text = '\n'.join(l for l in text.split('\n')
                         if not l.startswith(('[System]', '[ExifTool]      ExifTool Version')))
        write(os.path.join(dumpdir, f + '.txt'), text.encode('utf-8'))
        dumps[f] = text
    def shown_as(form, text):
        # form is 'Group|Tag Name|value': match one '[Group]  Tag Name  : value' line exactly
        group, name, value = form.split('|', 2)
        for line in text.split('\n'):
            head, sep, val = line.partition(': ')
            if sep and head.startswith('[' + group + ']') and head[len(group) + 2:].strip() == name and val == value:
                return True
        return False

    verdicts = []
    for r in rows:
        text = dumps[r['file']]
        if r['string'] in text:
            verdicts.append('yes')
        elif r.get('exiftool_form') and shown_as(r['exiftool_form'], text):
            verdicts.append('reformatted')
        else:
            verdicts.append('no')
    with open(result, 'w', encoding='utf-8') as out:
        out.write('string\tfile\texiftool_sees\n')
        for r, v in zip(rows, verdicts):
            out.write('%s\t%s\t%s\n' % (r['string'], r['file'], v))
    print('visibility: exiftool -a -u -G1 -ee shows %d of %d planted strings verbatim, %d more reformatted, %d not at all' % (
        verdicts.count('yes'), len(rows), verdicts.count('reformatted'), verdicts.count('no')))


def cmd_report(args):
    """report REGISTRY.tsv VISIBILITY.tsv OUT.md: Markdown tables, one per fixture."""
    rows = load_registry(args[0])
    vis = {(r['string'], r['file']): r['exiftool_sees'] for r in load_registry(args[1])}
    order = []
    for r in rows:
        if r['file'] not in order:
            order.append(r['file'])
    lines = []
    for f in order:
        lines.append('### %s\n' % f)
        lines.append('| String | Location | Group | Tier | Basis | Stored as | exiftool sees |')
        lines.append('|---|---|---|---|---|---|---|')
        for r in rows:
            if r['file'] == f:
                seen = vis.get((r['string'], f), '?')
                if seen == 'reformatted':
                    seen = 'reformatted: `%s`' % r['exiftool_form'].split('|', 2)[2]
                lines.append('| `%s` | %s | %s | %s | %s | %s | %s |' % (
                    r['string'], r['location'], r['group'], r['tier'], r['basis'],
                    r['encoding'], seen))
        lines.append('')
    write(args[2], ('\n'.join(lines)).encode('utf-8'))


def cmd_scan(args):
    """scan REGISTRY.tsv FILE [...]: audit helper. Print every planted string found in each FILE,
    looking in the raw bytes, inflated PNG streams and decoded raw profiles. Exit status 1 if any."""
    rows = load_registry(args[0])
    found_any = False
    for path in args[1:]:
        hay = haystacks(path)
        for r in rows:
            hits = find_all(hay, r['string'].encode('latin-1'))
            if hits:
                found_any = True
                print('%s\t%s\t%s\t%s\t%s' % (path, r['string'], r['tier'], r['location'], ','.join(sorted(hits))))
    sys.exit(1 if found_any else 0)


COMMANDS = {
    'jpeg-insert': cmd_jpeg_insert, 'jpeg-exif': cmd_jpeg_exif, 'jpeg-segment': cmd_jpeg_segment,
    'sos-offset': cmd_sos_offset, 'xmp-payload': cmd_xmp_payload, 'xpacket': cmd_xpacket,
    'blob': cmd_blob, 'mpf': cmd_mpf, 'uhdr': cmd_uhdr, 'samsung': cmd_samsung, 'c2pa': cmd_c2pa, 'icc': cmd_icc,
    'icc-text': cmd_icc_text,
    'png-build': cmd_png_build, 'webp-build': cmd_webp_build, 'mp4-udta': cmd_mp4_udta,
    'mp4-minimal': cmd_mp4_minimal, 'hostile-exif': cmd_hostile_exif, 'pdf': cmd_pdf,
    'verify': cmd_verify, 'visibility': cmd_visibility, 'report': cmd_report, 'scan': cmd_scan,
}

if __name__ == '__main__':
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        for name, fn in COMMANDS.items():
            print((fn.__doc__ or name).strip().split('\n')[0])
        sys.exit(0 if len(sys.argv) < 2 else 2)
    COMMANDS[sys.argv[1]](sys.argv[2:])
