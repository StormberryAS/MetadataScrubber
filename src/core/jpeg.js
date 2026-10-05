// JPEG container.
//
// Walks the segments from SOI to the first SOS, then follows the entropy-coded data to its
// true end (byte stuffing, restart markers and the several scans of a progressive JPEG),
// up to EOI. Whatever follows EOI is classified: Motion Photo video, MPF images and HDR
// gain maps, Samsung trailers, or unknown data. Removal cuts exact byte ranges; EXIF is
// edited in place by the TIFF engine.
//
// Every byte is accounted for: a part is either needed to show the picture, or belongs to
// an item the user can remove. Stray bytes between parts, a part cut short at the end of
// the file, markers no decoder needs and padding inside the JFIF and Adobe headers are all
// offered as red items, so nothing travels along unseen.

import {
  Assembler, concat, encodeLatin1, encodeUtf8, formatBytes, indexOfAscii, latin1, startsWith, u16be, u16le, u32be, u32le, u64be, w16be,
} from './bytes.js?v=4d7df4d3';
import { describeC2pa } from './c2pa.js?v=fcdff418';
import { ICC_TEXT_ITEM, ICC_UNREADABLE_ITEM, cleanIcc, iccDescription, iccFreeText, inspectIcc, md5 } from './icc.js?v=15403b52';
import {
  IRB_EXIF, IRB_IPTC, IRB_IPTC_DIGEST, IRB_OTHER_NOTE, IRB_THUMBS, IRB_XMP, canonicalIrb, iptcItems, irbOtherValue, parseIptc, parseIrb,
} from './iptc.js?v=a3bcfb3f';
import { ItemSet, UNREADABLE, cappedId, strictest } from './taxonomy.js?v=93d7f069';
import { appleHdr, appleHdrAny, appleHdrValue, parseTiff, removeTiffKeys, shrinkAppleNote, tiffItems, tiffOrientation } from './tiff.js?v=1288a27c';
import { addXmpItems, appleLabelFix, canonicalXmp, directoryOf, gainAllowed, gainFields, gainFixes, keepOnlyXmp, hasGainVersion, offerDirectoryEntries, parseXmp, planXmp, versionFix } from './xmp.js?v=d8284a86';

const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_ID = 'http://ns.adobe.com/xmp/extension/\0';
const ISO_GAIN_ID = 'urn:iso:std:iso:ts:21496:-1\0';
const PS_ID = 'Photoshop 3.0\0';
const MAX_DETAILED = 4;

const isSof = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
// Marker segments a decoder needs: frame and scan headers, tables, restart interval,
// hierarchical and JPEG-LS headers. DNL is added when the frame height is zero.
const NEEDED = (m) => isSof(m) || m === 0xc4 || m === 0xcc || m === 0xdb || m === 0xdd || m === 0xde || m === 0xdf || m === 0xf7 || m === 0xf8;

// Splits a JPEG into segments. Returns { segs, eoiEnd, sof, warnings }; eoiEnd is -1 when
// the file stops before EOI. Kinds: soi, seg, sos, entropy, standalone, eoi, junk (stray
// bytes between parts) and cut (a part the file stops in the middle of).
export function walkJpeg(b, limit = b.length) {
  const segs = [];
  const warnings = [];
  if (b.length < 3 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  segs.push({ marker: 0xd8, start: 0, end: 2, kind: 'soi' });
  let p = 2;
  let eoiEnd = -1;
  let sof = null;
  while (p < limit) {
    if (b[p] !== 0xff) {
      let q = p;
      while (q + 1 < limit && !(b[q] === 0xff && b[q + 1] !== 0 && b[q + 1] !== 0xff)) q++;
      const end = q + 1 >= limit ? limit : q;
      warnings.push('The file has stray bytes between its parts.');
      segs.push({ marker: -1, start: p, end, kind: 'junk' });
      if (end >= limit) break;
      p = q;
      continue;
    }
    let q = p;
    while (q < limit && b[q] === 0xff) q++;
    if (q >= limit) { if (q > p + 1) segs.push({ marker: -1, start: p, end: limit, kind: 'cut' }); break; }
    const m = b[q];
    if (m === 0xd9) {
      segs.push({ marker: m, start: p, end: q + 1, kind: 'eoi' });
      eoiEnd = q + 1;
      break;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      segs.push({ marker: m, start: p, end: q + 1, kind: 'standalone' });
      p = q + 1;
      continue;
    }
    const len = q + 3 <= limit ? u16be(b, q + 1) : 0;
    if (q + 3 > limit || len < 2 || q + 1 + len > limit) {
      warnings.push('The file is cut short inside a segment.');
      segs.push({ marker: m, start: p, end: limit, kind: 'cut' });
      p = limit;
      break;
    }
    const seg = { marker: m, start: p, dataStart: q + 3, end: q + 1 + len, kind: 'seg' };
    segs.push(seg);
    if (isSof(m) && len >= 8) {
      const d = seg.dataStart;
      const n = b[d + 5];
      const ids = [];
      for (let i = 0; i < n && d + 6 + i * 3 < seg.end; i++) ids.push(b[d + 6 + i * 3]);
      sof = { marker: m, height: u16be(b, d + 1), width: u16be(b, d + 3), components: n, ids };
    }
    p = seg.end;
    if (m === 0xda) {
      seg.kind = 'sos';
      let r = p;
      while (r < limit) {
        if (b[r] !== 0xff) { r++; continue; }
        if (r + 1 >= limit) { r = limit; break; }
        const n = b[r + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { r += 2; continue; }
        if (n === 0xff) { r++; continue; }
        break;
      }
      segs.push({ marker: -1, start: p, end: r, kind: 'entropy' });
      p = r;
    }
  }
  if (eoiEnd < 0) warnings.push('The picture data ends without an end-of-image marker.');
  return { segs, eoiEnd, sof, warnings };
}

// Whether a decoder segment really has the shape its marker promises. Any other bytes
// behind such a marker (a damaged length, or a marker byte changed) cannot be decoded and
// may hide anything, so the segment is then offered like unknown data.
function wellFormed(b, s) {
  const m = s.marker;
  const d = s.dataStart;
  const n = s.end - d;
  if (isSof(m) || m === 0xde || m === 0xf7) return n >= 6 && n === 6 + 3 * b[d + 5];
  if (m === 0xda) return n >= 1 && n === 4 + 2 * b[d];
  if (m === 0xdd || m === 0xdc) return n === 2;
  if (m === 0xdf) return n === 1;
  if (m === 0xcc) return n % 2 === 0;
  if (m === 0xdb) {
    let p = d;
    while (p < s.end) p += 1 + (b[p] >> 4 ? 128 : 64);
    return p === s.end;
  }
  if (m === 0xc4) {
    let p = d;
    while (p + 17 <= s.end) {
      let count = 0;
      for (let i = 1; i <= 16; i++) count += b[p + i];
      p += 17 + count;
    }
    return p === s.end;
  }
  return true;
}

// Quantisation and Huffman tables the picture never uses: a table defined under an id no
// scan reads before the id is defined again or the picture ends. Its 64 or more bytes are
// free, so they may hold anything. Returns { tables, bytes, rebuild: Map of segment to its
// new payload (null when nothing is left) } or null when there is nothing to remove or the
// coding is one this check does not follow (arithmetic, lossless, hierarchical). Tables in
// use cannot be changed without re-encoding the picture.
export function unusedTables(b, w) {
  const frames = w.segs.filter((s) => s.kind === 'seg' && isSof(s.marker));
  if (frames.length !== 1 || ![0xc0, 0xc1, 0xc2].includes(frames[0].marker)) return null;
  const progressive = frames[0].marker === 0xc2;
  const f = frames[0].dataStart;
  const quantOf = new Map();
  for (let i = 0; i < b[f + 5]; i++) quantOf.set(b[f + 6 + i * 3], b[f + 8 + i * 3] & 15);
  const defs = new Map();
  const unused = [];
  const define = (key, def) => { const old = defs.get(key); if (old && !old.used) unused.push(old); defs.set(key, def); };
  const use = (key) => { const d = defs.get(key); if (d) d.used = true; };
  const latched = new Set();
  for (const s of w.segs) {
    if (s.kind !== 'seg' && s.kind !== 'sos') continue;
    if (s.kindApp !== 'structural') continue;
    if (s.marker === 0xdb) {
      for (let p = s.dataStart; p < s.end;) {
        const len = 1 + (b[p] >> 4 ? 128 : 64);
        define(`q${b[p] & 15}`, { seg: s, start: p, end: p + len, used: false });
        p += len;
      }
    } else if (s.marker === 0xc4) {
      for (let p = s.dataStart; p + 17 <= s.end;) {
        let count = 0;
        for (let i = 1; i <= 16; i++) count += b[p + i];
        define(`h${b[p] >> 4}:${b[p] & 15}`, { seg: s, start: p, end: p + 17 + count, used: false });
        p += 17 + count;
      }
    } else if (s.kind === 'sos') {
      const d = s.dataStart;
      const n = b[d];
      const ss = b[d + 1 + 2 * n];
      const ah = b[d + 3 + 2 * n] >> 4;
      for (let i = 0; i < n; i++) {
        const c = b[d + 1 + 2 * i];
        const td = b[d + 2 + 2 * i] >> 4;
        const ta = b[d + 2 + 2 * i] & 15;
        // A decoder takes a component's quantisation table at the first scan that has it.
        if (!latched.has(c) && quantOf.has(c)) { use(`q${quantOf.get(c)}`); latched.add(c); }
        if (!progressive) { use(`h0:${td}`); use(`h1:${ta}`); } else if (ss === 0) { if (ah === 0) use(`h0:${td}`); } else use(`h1:${ta}`);
      }
    }
  }
  for (const d of defs.values()) if (!d.used) unused.push(d);
  if (!unused.length) return null;
  const rebuild = new Map();
  for (const seg of new Set(unused.map((d) => d.seg))) {
    const gone = unused.filter((d) => d.seg === seg);
    const parts = [];
    let p = seg.dataStart;
    for (const d of gone.sort((x, y) => x.start - y.start)) { parts.push(b.subarray(p, d.start)); p = d.end; }
    parts.push(b.subarray(p, seg.end));
    const payload = concat(parts);
    rebuild.set(seg, payload.length ? payload : null);
  }
  return { tables: unused.length, bytes: unused.reduce((n, d) => n + d.end - d.start, 0), rebuild };
}

function appKind(b, s, sof) {
  const m = s.marker;
  const at = (str) => startsWith(b, s.dataStart, str);
  if (m === 0xe0) {
    if (at('JFIF\0')) return s.end - s.dataStart >= 14 ? 'jfif' : 'unknown';
    return at('JFXX\0') ? 'jfxx' : 'unknown';
  }
  if (m === 0xe1) {
    if (at('Exif\0')) return 'exif';
    if (at(XMP_ID)) return 'xmp';
    if (at(XMP_EXT_ID)) return 'xmpext';
    return 'unknown';
  }
  if (m === 0xe2) return at('ICC_PROFILE\0') ? 'icc' : at('MPF\0') ? 'mpf' : at(ISO_GAIN_ID) ? 'isogain' : 'unknown';
  if (m === 0xeb) {
    if (at('JP') && indexOfAscii(b, 'c2pa', s.dataStart, Math.min(s.end, s.dataStart + 128)) >= 0) return 'c2pa';
    // Continuation packets of a JUMBF box carry no label; they follow their first packet.
    if (at('JP')) return 'jumbf';
    return 'unknown';
  }
  if (m === 0xed) return at(PS_ID) ? 'irb' : 'unknown';
  if (m === 0xee) return at('Adobe') && s.end - s.dataStart >= 12 ? 'adobe' : 'unknown';
  if (m === 0xfe) return 'com';
  if (m >= 0xe0 && m <= 0xef) return 'unknown';
  if ((NEEDED(m) || (m === 0xdc && sof && sof.height === 0)) && wellFormed(b, s)) return 'structural';
  return 'marker';
}

function appIdentifier(b, s) {
  const end = Math.min(s.end, s.dataStart + 40);
  let p = s.dataStart;
  while (p < end && b[p] >= 0x20 && b[p] < 0x7f) p++;
  const id = latin1(b, s.dataStart, p).trim();
  return id.length >= 2 ? id : '';
}

function makeSegment(marker, payload) {
  if (payload.length > 65533) return null;
  const out = new Uint8Array(4 + payload.length);
  out[0] = 0xff; out[1] = marker;
  w16be(out, 2, payload.length + 2);
  out.set(payload, 4);
  return out;
}

const nonZero = (b, s, e) => { for (let i = s; i < e; i++) if (b[i]) return true; return false; };

// MPF index: entries with absolute positions in the file.
function parseMpf(b, seg) {
  const base = seg.dataStart + 4;
  const m = parseTiff(b.subarray(base, seg.end));
  if (!m || !m.ifds.ifd0) return null;
  const e = m.ifds.ifd0.entries.find((x) => x.tag === 0xb002 && x.valid);
  if (!e) return { base, entries: [] };
  const entries = [];
  for (let i = 0; i * 16 + 16 <= e.size; i++) {
    const p = e.valueOffset + i * 16;
    entries.push({
      index: i,
      attr: m.r32(p),
      size: m.r32(p + 4),
      offset: m.r32(p + 8),
      dep1: m.r16(p + 12),
      dep2: m.r16(p + 14),
      sizePos: base + p + 4,
      offsetPos: base + p + 8,
      le: m.le,
    });
  }
  return { base, entries, le: m.le };
}

// The MPF segment read strictly (CIPA DC-007), accounting for every byte: the MP header,
// the MP Index IFD with MPFVersion (B000), NumberOfImages (B001) and the MP entry table
// (B002), which are what a reader needs to find the images. Anything else is sorted into
// image IDs (B003), layout details (B004 and the MP Attribute IFD) and unexplained data:
// unknown or mistyped tags, a malformed entry, and any non-zero byte no structure uses.
// Returns { ok, le, ids, layout, extra, extraTags } (ok false when even the header and the
// entry table cannot be read).
const MPF_ATTR_TYPES = new Map([
  [0xb000, [7]], [0xb101, [4]], [0xb201, [4]], [0xb202, [5]], [0xb203, [5]], [0xb204, [4]], [0xb205, [10]], [0xb206, [5]],
  [0xb207, [10]], [0xb208, [10]], [0xb209, [10]], [0xb20a, [10]], [0xb20b, [10]], [0xb20c, [10]], [0xb20d, [10]],
]);
const TIFF_UNIT = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function parseMpfStrict(b, seg) {
  const start = seg.dataStart + 4;
  const t = b.subarray(start, seg.end);
  const n = t.length;
  const res = { ok: false, le: false, ids: null, layout: [], b004: null, extra: false, extraTags: [] };
  if (n < 8) return res;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return res;
  const r16 = le ? (p) => u16le(t, p) : (p) => u16be(t, p);
  const r32 = le ? (p) => u32le(t, p) : (p) => u32be(t, p);
  if (r16(2) !== 42) return res;
  res.le = le;
  const covered = new Uint8Array(n);
  const cover = (a, e) => { for (let i = Math.max(0, a); i < Math.min(n, e); i++) covered[i] = 1; };
  cover(0, 8);
  const flag = (tag) => { res.extra = true; if (tag !== undefined && res.extraTags.length < 4 && !res.extraTags.includes(tag)) res.extraTags.push(tag); };
  // Reads one IFD: its entries with their value bytes, or null when it does not fit.
  const readIfd = (off) => {
    if (off < 8 || off + 2 > n) return null;
    const count = r16(off);
    const end = off + 2 + count * 12 + 4;
    if (end > n) return null;
    cover(off, end);
    const entries = [];
    for (let i = 0; i < count; i++) {
      const p = off + 2 + i * 12;
      const tag = r16(p);
      const type = r16(p + 2);
      const cnt = r32(p + 4);
      const size = (TIFF_UNIT[type] || 0) * cnt;
      const inline = size <= 4;
      const at = inline ? p + 8 : r32(p + 8);
      const fits = TIFF_UNIT[type] > 0 && size < 0x7fffffff && (inline || (at >= 8 && at + size <= n));
      if (fits && !inline) cover(at, at + size);
      entries.push({ tag, type, count: cnt, size, at, fits, data: fits ? t.slice(at, at + size) : null });
    }
    return { entries, next: r32(off + 2 + count * 12) };
  };
  const index = readIfd(r32(4));
  if (!index) return res;
  let numImages = null;
  let table = null;
  const seenTags = new Set();
  for (const e of index.entries) {
    if (seenTags.has(e.tag) || !e.fits) { flag(e.tag); continue; }
    seenTags.add(e.tag);
    if (e.tag === 0xb000 && e.type === 7 && e.count === 4 && latin1(e.data) === '0100') continue;
    if (e.tag === 0xb001 && e.type === 4 && e.count === 1) { numImages = r32(e.at); continue; }
    if (e.tag === 0xb002 && e.type === 7 && e.count > 0 && e.count % 16 === 0 && e.size > 4) { table = { at: e.at, count: e.count / 16 }; continue; }
    if (e.tag === 0xb003 && e.type === 7 && e.count > 0) { res.ids = e.data; continue; }
    if (e.tag === 0xb004 && e.type === 4 && e.count === 1) { res.b004 = e; continue; }
    flag(e.tag);
  }
  if (!table) return res;
  if (numImages !== table.count) flag(0xb001);
  for (let i = 0; i < table.count; i++) {
    const p = table.at + i * 16;
    const attr = r32(p);
    const deps = [r16(p + 12), r16(p + 14)];
    if (attr & 0x18000000) flag(0xb002);
    if (deps.some((d) => d > table.count)) flag(0xb002);
  }
  if (index.next) {
    const attrIfd = readIfd(index.next);
    if (!attrIfd) flag();
    else {
      const seen = new Set();
      for (const e of attrIfd.entries) {
        const types = MPF_ATTR_TYPES.get(e.tag);
        const okCount = e.tag === 0xb000 ? e.count === 4 && e.fits && latin1(e.data) === '0100' : e.count === 1;
        if (!types || !types.includes(e.type) || !okCount || !e.fits || seen.has(e.tag)) { flag(e.tag); continue; }
        seen.add(e.tag);
        res.layout.push(e);
      }
      if (attrIfd.next) flag();
    }
  }
  if (res.b004) res.layout.unshift(res.b004);
  for (let i = 0; i < n; i++) if (!covered[i] && t[i]) { flag(); break; }
  res.ok = true;
  return res;
}

// A fresh MPF payload ('MPF\0' and the MP header onwards) in the byte order of the old one:
// the MP Index IFD with B000, B001 and B002, plus the image IDs and layout details when
// they are kept. MP entries keep their flags, format, type and dependent image numbers
// (reserved bits and impossible numbers cleared); sizes and offsets are filled in after the
// file is put together. Returns { payload, tablePos } with tablePos from the MP header.
// Only Index IFD entries of four bytes or less are inline, so B002 (16 bytes per image) is
// always the first value after the IFD.
function buildMpf(strict, entries, { ids, layout }) {
  const le = strict.le;
  const w16 = (v) => { const x = new Uint8Array(2); if (le) { x[0] = v & 255; x[1] = v >>> 8; } else { x[0] = v >>> 8; x[1] = v & 255; } return x; };
  const w32 = (v) => { const x = new Uint8Array(4); for (let i = 0; i < 4; i++) x[le ? i : 3 - i] = (v >>> (8 * i)) & 255; return x; };
  const N = entries.length;
  const table = concat(entries.map((e) => {
    const deps = [e.dep1, e.dep2].map((d) => (d <= N ? d : 0));
    return concat([w32(e.attr & ~0x18000000), w32(e.size), w32(e.offset), w16(deps[0]), w16(deps[1])]);
  }));
  const attrEntries = layout ? strict.layout.filter((e) => e.tag !== 0xb004 || e === strict.b004) : [];
  const b004 = attrEntries.find((e) => e === strict.b004);
  const attrIfdEntries = attrEntries.filter((e) => e !== strict.b004);
  const indexTags = [
    { tag: 0xb000, type: 7, count: 4, data: encodeLatin1('0100') },
    { tag: 0xb001, type: 4, count: 1, data: w32(N) },
    { tag: 0xb002, type: 7, count: 16 * N, data: table },
  ];
  if (ids && strict.ids) indexTags.push({ tag: 0xb003, type: 7, count: strict.ids.length, data: strict.ids });
  if (b004) indexTags.push({ tag: 0xb004, type: 4, count: 1, data: b004.data });
  // Lays out one IFD at `off`, with out-of-line values right after it.
  const ifd = (list, off, next) => {
    const head = [w16(list.length)];
    const values = [];
    let valAt = off + 2 + list.length * 12 + 4;
    for (const e of list) {
      let field;
      if (e.data.length <= 4) { field = new Uint8Array(4); field.set(e.data); }
      else { field = w32(valAt); values.push(e.data); valAt += e.data.length; if (valAt & 1) { values.push(new Uint8Array(1)); valAt++; } }
      head.push(w16(e.tag), w16(e.type), w32(e.count), field);
    }
    head.push(w32(next));
    return concat([...head, ...values]);
  };
  const headLen = 8;
  const indexLen = ifd(indexTags, headLen, 0).length;
  const attrAt = attrIfdEntries.length ? headLen + indexLen : 0;
  const indexIfd = ifd(indexTags, headLen, attrAt);
  const attrIfd = attrIfdEntries.length ? ifd(attrIfdEntries, attrAt, 0) : new Uint8Array(0);
  const header = concat([le ? encodeLatin1('II') : encodeLatin1('MM'), w16(42), w32(headLen)]);
  const mp = concat([header, indexIfd, attrIfd]);
  // The entry table is the first out-of-line value of the Index IFD.
  const tablePos = headLen + 2 + indexTags.length * 12 + 4;
  return { payload: concat([encodeLatin1('MPF\0'), mp]), tablePos };
}

// ISO 21496-1 gain map metadata after its identifier: the 4-byte version-only form, or a
// full block (flags, headrooms and per-channel values, with or without one common
// denominator). Returns { ok, full, length } where length is the number of bytes the
// structure uses; ok is false when it cannot be read as one: a minimum version other than
// 0, reserved flag bits set, or too few bytes for its flags.
const ISO_MULTI = 0x80;
const ISO_COMMON = 0x08;
const ISO_RESERVED = 0x33;
export function parseIsoGain(b, start, end) {
  const n = end - start;
  if (n < 4 || u16be(b, start) !== 0) return { ok: false };
  if (n === 4) return { ok: true, full: false, length: 4 };
  const flags = b[start + 4];
  if (flags & ISO_RESERVED) return { ok: false };
  const channels = flags & ISO_MULTI ? 3 : 1;
  const length = 5 + (flags & ISO_COMMON ? 12 + channels * 20 : 16 + channels * 40);
  if (n < length) return { ok: false };
  return { ok: true, full: true, length };
}

// Hints the primary XMP gives about trailing media.
function xmpHints(text) {
  const hints = { videoLength: 0, motion: false };
  if (!text) return hints;
  if (/MotionPhoto|MicroVideo/.test(text)) hints.motion = true;
  const items = text.match(/<Container:Item\b[^>]*>/g) || [];
  for (const tag of items) {
    if (/Semantic=["']MotionPhoto["']/.test(tag)) {
      const len = /Item:Length=["'](\d+)["']/.exec(tag);
      if (len) hints.videoLength = +len[1];
    }
  }
  const mv = /MicroVideoOffset(?:=["']|>)(\d+)/.exec(text);
  if (!hints.videoLength && mv) hints.videoLength = +mv[1];
  return hints;
}

function samsungTrailer(b, from) {
  const n = b.length;
  if (n - from < 16 || !startsWith(b, n - 4, 'SEFT')) return null;
  const dirLen = u32le(b, n - 8);
  const sefh = n - 8 - dirLen;
  if (sefh < from || !startsWith(b, sefh, 'SEFH')) return null;
  const count = u32le(b, sefh + 8);
  let start = sefh;
  for (let i = 0; i < Math.min(count, 1000); i++) {
    const e = sefh + 12 + i * 12;
    if (e + 12 > n - 8) break;
    const s = sefh - u32le(b, e + 4);
    if (s >= from && s < start) start = s;
  }
  return { start, hasVideo: indexOfAscii(b, 'MotionPhoto_Data', start, sefh) >= 0 };
}

function isMp4At(b, p, limit) {
  return p + 12 <= limit && startsWith(b, p + 4, 'ftyp') && u32be(b, p) >= 8;
}

function mp4End(b, p, limit) {
  let q = p;
  while (q + 8 <= limit) {
    let size = u32be(b, q);
    const type = latin1(b, q + 4, q + 8);
    if (!/^[\x20-\x7e\xa9]{4}$/.test(type)) break;
    if (size === 1) { if (q + 16 > limit) break; size = u64be(b, q + 8); }
    else if (size === 0) size = limit - q;
    if (size < 8) break;
    if (q + size > limit) return limit;
    q += size;
  }
  return q;
}

// Whether a JPEG after the photo is plausibly its HDR gain map: it carries gain map
// metadata of its own (hdrgm Version with GainMapMax or HDRCapacityMax, Apple's
// HDRGainMapVersion, or a full ISO 21496-1 block), is no larger than the photo and has one
// or three colour channels. Anything else is an extra picture, which is red. Returns
// { eoiEnd, signals } or null; signals says which descriptions the gain map has (hdrgm,
// iso, apple), so the scrub can check the photo still points to it.
function gainMapEvidence(sub, photoSof) {
  const w = walkJpeg(sub);
  if (!w || w.eoiEnd < 0 || !w.sof) return null;
  if (w.sof.components !== 1 && w.sof.components !== 3) return null;
  if (photoSof && (w.sof.width > photoSof.width || w.sof.height > photoSof.height)) return null;
  const segs = w.segs.filter((s) => s.kind === 'seg');
  const signals = { hdrgm: false, iso: false, apple: false, appleHeadroom: false };
  const xmp = segs.find((s) => s.marker === 0xe1 && startsWith(sub, s.dataStart, XMP_ID));
  if (xmp) {
    const parsed = parseXmp(new TextDecoder('utf-8').decode(sub.subarray(xmp.dataStart + XMP_ID.length, xmp.end)));
    const f = gainFields(parsed, 'gainmap');
    // A boost written with more digits than it needs still counts: it is rounded when the
    // gain map's metadata is cleaned.
    const longer = new Set(gainFixes(parsed, 'gainmap').map((x) => x.local));
    signals.hdrgm = !!(f['hdrgm:Version'] && (f['hdrgm:GainMapMax'] || f['hdrgm:HDRCapacityMax'] || longer.has('GainMapMax') || longer.has('HDRCapacityMax')));
    // Readers find an Apple gain map only by Apple's fixed label next to the version
    // (Skia, SkXmp getGainmapInfoApple); without it the second picture is not a gain map.
    // A label with that value in another form is written again in the usual form.
    signals.apple = !!(f['HDRGainMap:HDRGainMapVersion'] && (f['apdi:AuxiliaryImageType'] || appleLabelFix(parsed)));
    // Newer Apple gain maps also give their headroom themselves.
    signals.appleHeadroom = !!f['HDRGainMap:HDRGainMapHeadroom'];
  }
  const iso = segs.find((s) => s.marker === 0xe2 && startsWith(sub, s.dataStart, ISO_GAIN_ID));
  if (iso) {
    const pr = parseIsoGain(sub, iso.dataStart + ISO_GAIN_ID.length, iso.end);
    signals.iso = pr.ok && pr.full;
  }
  return signals.hdrgm || signals.iso || signals.apple ? { eoiEnd: w.eoiEnd, signals } : null;
}

function classifyTrailing(b, start, mpf, hints, photoSof) {
  const regions = [];
  if (start >= b.length) return regions;
  const sam = samsungTrailer(b, start);
  const tail = sam ? sam.start : b.length;
  const mpfRegions = [];
  if (mpf) {
    for (const e of mpf.entries) {
      if (e.index === 0 || !e.size) continue;
      const s = mpf.base + e.offset;
      if (s >= start && s + e.size <= tail) mpfRegions.push({ start: s, end: s + e.size, entry: e });
    }
  }
  const videoStart = hints.videoLength && hints.videoLength <= tail - start ? tail - hints.videoLength : -1;
  let p = start;
  while (p < tail) {
    const mr = mpfRegions.find((r) => r.start === p);
    if (mr) {
      const type = mr.entry.attr & 0xffffff;
      const ev = gainMapEvidence(b.subarray(mr.start, mr.end), photoSof);
      if (ev) {
        // Bytes after the gain map's end marker but inside its MPF size: zeros stay with
        // the gain map, anything else is a part of its own.
        const jpegEnd = mr.start + ev.eoiEnd;
        const after = jpegEnd < mr.end && nonZero(b, jpegEnd, mr.end);
        const gm = { kind: 'gainmap', start: mr.start, end: after ? jpegEnd : mr.end, jpegEnd, entry: mr.entry, entryEnd: after ? jpegEnd : mr.end, signals: ev.signals };
        regions.push(gm);
        if (after) regions.push({ kind: 'gainmap-after', start: jpegEnd, end: mr.end, entry: mr.entry, owner: gm });
      } else {
        regions.push({ kind: (type === 0x010001 || type === 0x010002) ? 'preview' : 'mpf', start: mr.start, end: mr.end, entry: mr.entry, entryEnd: mr.end });
      }
      p = mr.end;
      continue;
    }
    if (p + 3 <= tail && b[p] === 0xff && b[p + 1] === 0xd8 && b[p + 2] === 0xff) {
      const w = walkJpeg(b.subarray(p, tail));
      if (w && w.eoiEnd > 0) {
        const end = p + w.eoiEnd;
        const gain = gainMapEvidence(b.subarray(p, end), photoSof);
        regions.push(gain ? { kind: 'gainmap', start: p, end, jpegEnd: end, signals: gain.signals } : { kind: 'jpeg', start: p, end });
        p = end;
        continue;
      }
    }
    if (isMp4At(b, p, tail)) {
      const end = Math.max(p + 8, mp4End(b, p, tail));
      regions.push({ kind: 'video', start: p, end });
      p = end;
      continue;
    }
    if (p === videoStart) {
      regions.push({ kind: 'video', start: p, end: tail });
      p = tail;
      continue;
    }
    let z = p;
    while (z < tail && b[z] === 0) z++;
    if (z > p) { regions.push({ kind: 'padding', start: p, end: z }); p = z; continue; }
    const anchors = [tail, ...mpfRegions.map((r) => r.start), videoStart].filter((x) => x > p);
    const end = Math.min(...anchors);
    regions.push({ kind: 'unknown', start: p, end });
    p = end;
  }
  if (sam) regions.push({ kind: 'samsung', start: sam.start, end: b.length, hasVideo: sam.hasVideo });
  // Zero padding belongs to the region after it (or before it, at the very end).
  for (let i = 0; i < regions.length; i++) {
    if (regions[i].kind !== 'padding') continue;
    const next = regions[i + 1];
    const prev = regions[i - 1];
    if (next) { next.contentStart = next.start; next.start = regions[i].start; regions.splice(i--, 1); }
    else if (prev) { prev.end = regions[i].end; regions.splice(i--, 1); }
  }
  return regions;
}

const TRAILING = {
  video: { id: 'jpeg:trailing:motion-video', group: 'hidden', tier: 'red', label: 'Hidden video clip (Motion Photo)', note: 'A short video recorded around the moment the photo was taken.' },
  samsung: { id: 'jpeg:trailing:samsung', group: 'hidden', tier: 'red', label: 'Samsung extra data', note: 'Data the phone adds after the picture, sometimes including a video clip.' },
  gainmap: { id: 'jpeg:trailing:gain-map', group: 'hidden', tier: 'amber', label: 'HDR gain map', note: 'An extra image that makes the picture brighter on HDR screens. Kept to start with, holding only what it needs to work; anything else in it or around it is listed on its own. Removing it leaves the normal picture unchanged.' },
  'gainmap-after': { id: 'jpeg:trailing:gain-map:after', group: 'hidden', tier: 'red', label: 'Unknown data after the HDR gain map', note: 'Bytes stored after the end of the gain map. No program needs them to show the picture. They may hold anything.' },
  mpf: { id: 'jpeg:trailing:mpf-image', group: 'hidden', tier: 'red', label: 'Extra embedded image', note: 'Another picture stored in the file, for example a second camera view or an uncropped version.' },
  preview: { id: 'jpeg:trailing:preview', group: 'hidden', tier: 'red', label: 'Built-in preview image', note: 'Can still show the original, uncropped photo after cropping.' },
  jpeg: { id: 'jpeg:trailing:picture', group: 'hidden', tier: 'red', label: 'Extra picture after the image', note: 'Could be an earlier or uncropped version of the picture.' },
  unknown: { id: 'jpeg:trailing:unknown', group: 'hidden', tier: 'red', label: 'Unknown data after the image' },
  padding: { id: 'jpeg:trailing:padding', group: 'technical', tier: 'green', label: 'Empty padding after the image' },
};

// Item ids inside a gain map that are part of the gain map itself, not metadata about the
// photo: its own gain map description and basic headers. Its colour profile is offered as
// a green detail of its own.
const GAIN_MAP_OWN = new Set(['xmp:gainmap', 'icc:profile', 'icc:text', 'icc:unreadable', 'jpeg:jfif', 'jpeg:adobe']);

// ======================================================================================
// Analysis

export function analyseJpeg(b, set, opts = {}) {
  const w = walkJpeg(b);
  if (!w) throw new Error('This file type is not supported. Use a JPEG, PNG, WebP or HEIC picture.');
  for (const x of w.warnings) set.warn(x);
  const model = { w, segs: w.segs, mpf: null, xmpPackets: [], jfif: [], adobe: [] };
  const byKind = (k) => w.segs.filter((s) => s.kind === 'seg' && s.kindApp === k);
  for (const s of w.segs) if (s.kind === 'seg' || s.kind === 'sos') s.kindApp = s.kind === 'sos' ? (wellFormed(b, s) ? 'structural' : 'marker') : appKind(b, s, w.sof);
  // JUMBF continuation packets follow the C2PA packet that opened them.
  let lastC2pa = false;
  for (const s of w.segs) {
    if (s.kindApp === 'c2pa') lastC2pa = true;
    else if (s.kindApp === 'jumbf') s.kindApp = lastC2pa ? 'c2pa' : 'unknown';
    else if (s.kindApp !== 'structural') lastC2pa = false;
  }

  // Main XMP packet first, because trailing media and XMP descriptors depend on each other.
  const xmpSegs = byKind('xmp');
  const xmpSeg = xmpSegs[0];
  const xmpText = xmpSeg ? new TextDecoder('utf-8').decode(b.subarray(xmpSeg.dataStart + XMP_ID.length, xmpSeg.end)) : '';
  const hints = xmpHints(xmpText);

  const mpfSegs = byKind('mpf');
  const mpfSeg = mpfSegs[0];
  if (mpfSeg) {
    model.mpf = parseMpf(b, mpfSeg);
    model.mpfStrict = parseMpfStrict(b, mpfSeg);
  }
  const regions = !opts.embedded && w.eoiEnd > 0 ? classifyTrailing(b, w.eoiEnd, model.mpf, hints, w.sof) : [];
  model.regions = regions;

  // Stray bytes, damaged parts and markers no decoder needs.
  const stray = w.segs.filter((s) => s.kind === 'junk');
  if (stray.length) {
    set.add({ id: 'jpeg:stray', group: 'hidden', tier: 'red', label: 'Stray data between parts of the file', value: formatBytes(stray.reduce((n, s) => n + s.end - s.start, 0)), source: 'JPEG', note: 'Bytes picture programs skip over. They may hold anything.' }, { kind: 'segs', segs: stray });
  }
  const cut = w.segs.filter((s) => s.kind === 'cut');
  if (cut.length) set.add({ id: 'jpeg:damaged', ...UNREADABLE.damaged, value: formatBytes(cut.reduce((n, s) => n + s.end - s.start, 0)), source: 'JPEG' }, { kind: 'segs', segs: cut });
  // A malformed scan header takes the scan data after it along.
  const markers = [];
  w.segs.forEach((s, i) => {
    if ((s.kind !== 'seg' && s.kind !== 'sos') || s.kindApp !== 'marker') return;
    markers.push(s);
    if (s.kind === 'sos' && w.segs[i + 1] && w.segs[i + 1].kind === 'entropy') markers.push(w.segs[i + 1]);
  });
  if (markers.length) {
    const named = markers.filter((s) => s.marker >= 0);
    set.add({ id: 'jpeg:marker', group: 'hidden', tier: 'red', label: 'Unidentified extra data from the device or software', value: `${named.length === 1 ? `Marker ${named[0].marker.toString(16).toUpperCase()}` : `${named.length} markers`}, ${formatBytes(markers.reduce((n, s) => n + s.end - s.start, 0))}`, source: 'JPEG', note: 'A part of the file no picture program can use. It may hold anything.' }, { kind: 'segs', segs: markers });
  }

  // Decoder tables no scan uses.
  const tables = unusedTables(b, w);
  if (tables) {
    set.add({ id: 'jpeg:unused-tables', group: 'hidden', tier: 'red', label: 'Unused decoder tables', value: `${tables.tables} ${tables.tables === 1 ? 'table' : 'tables'}, ${formatBytes(tables.bytes)}`, source: 'JPEG', note: 'Tables of numbers stored with the picture data that the picture never uses. They may hold anything. Removing them leaves the picture unchanged.' }, { kind: 'tables', rebuild: tables.rebuild });
  }

  // EXIF: the first few blocks in detail, any further copies as one item.
  const exifSegs = byKind('exif');
  for (const s of exifSegs.slice(0, MAX_DETAILED)) {
    const tStart = s.dataStart + 6;
    const m = parseTiff(b.subarray(tStart, s.end));
    if (!m || m.damaged) {
      if (m) for (const x of m.warnings) set.warn(x);
      set.add({ id: 'exif:unreadable', group: 'hidden', tier: 'red', label: 'EXIF data that could not be read', value: formatBytes(s.end - s.dataStart), source: 'EXIF', note: 'It may hold anything, so removing it is the safe choice.' }, { kind: 'segs', segs: [s] });
      continue;
    }
    for (const x of m.warnings) set.warn(x);
    // The identifier is "Exif" and two zeros; the second zero is not checked by readers, so
    // a block that stays has it set to zero.
    if (b[s.dataStart + 5] !== 0) { set.normalise = true; model.exifPad = (model.exifPad || []).concat([s]); }
    if (model.orientation === undefined) model.orientation = tiffOrientation(m);
    if (!model.exifFirst) model.exifFirst = { seg: s, m };
    for (const it of tiffItems(m)) {
      const pub = { id: `exif:${it.key}`, group: it.group, tier: it.tier, label: it.label, value: it.value, source: 'EXIF' };
      if (it.note) pub.note = it.note;
      set.add(pub, { kind: 'exif', seg: s, key: it.key });
    }
  }
  if (exifSegs.length > MAX_DETAILED) {
    const extra = exifSegs.slice(MAX_DETAILED);
    set.add({ id: 'exif:extra-copies', group: 'hidden', tier: 'red', label: 'More copies of EXIF data', value: `${extra.length} more, ${formatBytes(extra.reduce((n, s) => n + s.end - s.start, 0))}`, source: 'EXIF', note: 'A file normally holds one EXIF block. Extra copies can repeat anything.' }, { kind: 'segs', segs: extra });
  }

  // Trailing media items (needed before XMP so descriptors can follow their tier).
  const trailingItems = new Map();
  // An Apple gain map that nothing else describes needs the HDR brightness from the photo's
  // Apple maker notes, or a headroom of its own; without either no screen can show it in
  // HDR, so it is red, like any extra picture.
  const appleBrightness = !!(model.exifFirst && appleHdrAny(model.exifFirst.m));
  const unusable = (r) => r.kind === 'gainmap' && r.signals && r.signals.apple && !r.signals.hdrgm && !r.signals.iso && !r.signals.appleHeadroom && !appleBrightness;
  for (const r of regions) {
    const def = TRAILING[r.kind];
    if (!trailingItems.has(def.id)) trailingItems.set(def.id, { def: { ...def }, ranges: [], segs: [], couple: [], regions: [] });
    const t = trailingItems.get(def.id);
    if (unusable(r)) Object.assign(t.def, { tier: 'red', note: GAIN_MAP_UNUSABLE });
    t.ranges.push([r.start, r.end]);
    t.regions.push(r);
    if (r.kind === 'samsung' && r.hasVideo) t.def.label = 'Hidden video clip and Samsung extra data';
  }
  const mpfOwner = ['gainmap', 'mpf', 'preview'].map((k) => TRAILING[k].id).find((id) => trailingItems.has(id));
  const isoSegs = byKind('isogain');
  if (!opts.embedded && (mpfSegs.length || isoSegs.length)) {
    if (mpfOwner) trailingItems.get(mpfOwner).segs.push(...mpfSegs, ...isoSegs);
    else {
      trailingItems.set('jpeg:mpf', {
        def: { id: 'jpeg:mpf', group: 'hidden', tier: 'amber', label: 'Extra embedded image, for example an HDR gain map', note: 'Only the index is present; the extra image itself was not found.' },
        ranges: [], segs: [...mpfSegs, ...isoSegs], couple: [], regions: [],
      });
    }
  }
  // What the multi-picture index and the ISO 21496-1 segments hold beyond what a reader
  // needs to find and show the extra image, each removable while the image stays.
  if (opts.embedded && mpfSegs.length) {
    set.add({ id: 'jpeg:mpf:embedded', group: 'hidden', tier: 'red', label: 'Multi-picture index inside the gain map', value: formatBytes(mpfSegs.reduce((n, x) => n + x.end - x.start, 0)), source: 'JPEG', note: 'A gain map does not need an index of its own. It may hold anything.' }, { kind: 'segs', segs: mpfSegs });
  } else if (mpfSeg) {
    const st = model.mpfStrict;
    if (st.ok && st.ids) {
      set.add({ id: 'jpeg:mpf:ids', group: 'hidden', tier: 'red', label: 'Unique image IDs in the multi-picture index', value: formatBytes(st.ids.length), source: 'JPEG', note: 'Can link copies of the picture back to the original file.' }, { kind: 'mpfpart', part: 'ids' });
    }
    if (st.ok && st.layout.length) {
      set.add({ id: 'jpeg:mpf:layout', group: 'technical', tier: 'green', label: 'Multi-picture layout details', value: `${st.layout.length} field${st.layout.length === 1 ? '' : 's'}`, source: 'JPEG', note: 'How the pictures in the file relate to each other, such as viewing angles.' }, { kind: 'mpfpart', part: 'layout' });
    }
    const extraSegs = mpfSegs.slice(1);
    if (!st.ok || st.extra || extraSegs.length) {
      const tags = st.extraTags.filter((x) => x !== undefined).map((x) => `tag ${x.toString(16).toUpperCase()}`);
      const size = !st.ok ? mpfSeg.end - mpfSeg.start : 0;
      const more = extraSegs.reduce((n, x) => n + x.end - x.start, 0);
      const value = [!st.ok ? `unreadable index, ${formatBytes(size)}` : '', tags.join(', '), more ? `${extraSegs.length} more ${extraSegs.length === 1 ? 'index' : 'indexes'}, ${formatBytes(more)}` : ''].filter(Boolean).join('; ') || 'Data no structure uses';
      set.add({ id: 'jpeg:mpf:extra', group: 'hidden', tier: 'red', label: 'Unexplained data in the multi-picture index', value, source: 'JPEG', note: 'Data in the index that no program needs to find the pictures. It may hold anything. Removing the image IDs or the layout details also removes it, because the index is then written again.' }, { kind: 'mpfpart', part: 'extra', whole: !st.ok, segs: extraSegs });
    }
  }
  if (isoSegs.length) {
    // The first segment may keep its parsed bytes; surplus bytes, an unreadable segment and
    // any further segment are offered as one red detail.
    const plan = [];
    let extraBytes = 0;
    isoSegs.forEach((x, i) => {
      const at = x.dataStart + ISO_GAIN_ID.length;
      const pr = i === 0 ? parseIsoGain(b, at, x.end) : { ok: false };
      let keepEnd = pr.ok ? at + pr.length : -1;
      // In the photo the segment only needs its version (the form Ultra HDR 1.1 writes
      // there): when the rest cannot be read, it is cut to those four bytes, not dropped.
      if (i === 0 && !pr.ok && !opts.embedded && x.end - at >= 4 && u16be(b, at) === 0) keepEnd = at + 4;
      if (keepEnd === x.end) return;
      plan.push({ seg: x, keepEnd });
      extraBytes += keepEnd < 0 ? x.end - x.start : x.end - keepEnd;
    });
    if (plan.length) {
      set.add({ id: 'jpeg:isogain:extra', group: 'hidden', tier: 'red', label: 'Unexplained data in the HDR gain map description (ISO 21496-1)', value: formatBytes(extraBytes), source: 'JPEG', note: 'Bytes in the ISO 21496-1 gain map segment that no program needs. They may hold anything.' }, { kind: 'iso', plan });
    }
  }
  // What in the photo points a reader to the gain map, so the scrub can check it stays.
  const isoAt = isoSegs.length ? isoSegs[0].dataStart + ISO_GAIN_ID.length : -1;
  model.signals = {
    iso: isoAt >= 0 && isoSegs[0].end - isoAt >= 4 && u16be(b, isoAt) === 0,
    version: false,
    dirGainMap: false,
  };
  const motionTier = trailingItems.has(TRAILING.video.id) ? 'red' : null;
  const gainTier = mpfOwner ? trailingItems.get(mpfOwner).def.tier : null;

  // XMP and Extended XMP
  const extSegs = byKind('xmpext');
  if (xmpSeg) {
    const parsed = parseXmp(xmpText);
    // Directory entries that stand for no part after the image are offered on their own.
    const dir = !opts.embedded ? directoryOf(parsed) : null;
    if (dir) offerDirectoryEntries(parsed, mapDirectory(dir, regions).map((r, n) => (r ? -1 : n)).filter((n) => n > 0));
    model.xmpPacket = { seg: xmpSeg, parsed, items: [] };
    let extended = null;
    if (extSegs.length) {
      const total = extSegs.reduce((n, s) => n + s.end - s.dataStart - XMP_EXT_ID.length - 40, 0);
      const extText = latin1(b, extSegs[0].dataStart + XMP_EXT_ID.length + 40, extSegs[0].end);
      const kinds = [];
      if (/GImage:Data|GImage:Mime/.test(extText)) kinds.push('a second picture');
      if (/GDepth:Data|GDepth:Format/.test(extText)) kinds.push('a depth map');
      extended = {
        label: 'Extra XMP data', tier: 'red',
        value: `${kinds.length ? kinds.join(' and ') + ', ' : ''}${formatBytes(total)}`,
        note: 'Large hidden XMP that can hold a depth map or a full-size copy of the original picture.',
      };
    }
    model.xmpPacket.items = addXmpItems(set, parsed, { motionTier, gainMapTier: gainTier, gainMapCoupled: mpfOwner === GAIN_MAP_ITEM, extended, carrier: opts.embedded ? 'gainmap' : 'photo', compact: !!opts.embedded }, { kind: 'xmp' }, xmpSeg.end - xmpSeg.dataStart - XMP_ID.length);
    model.signals.version = hasGainVersion(parsed);
    model.signals.dirGainMap = !!(dir && dir.dir.entries.some((e) => e.semantic === 'GainMap'));
    model.xmpPacket.extSegs = extSegs;
    // Extended XMP that stays is written again in the canonical form, with a new GUID: the
    // file changes unless its Extended XMP is already exactly that, in one run of segments.
    if (extSegs.length && !extendedCanonical(b, parsed, extSegs)) set.normalise = true;
    model.xmpPackets.push(model.xmpPacket);
    for (const it of model.xmpPacket.items) {
      if (it.key === 'motion' && trailingItems.has(TRAILING.video.id)) trailingItems.get(TRAILING.video.id).couple.push(it.id);
      if (it.key === 'gainmap' && mpfOwner) trailingItems.get(mpfOwner).couple.push(it.id);
    }
    // A file should hold one standard packet; further packets are listed on their own so
    // nothing in them stays hidden, and beyond a few they are offered as one item.
    for (const seg of xmpSegs.slice(1, MAX_DETAILED)) {
      const p = parseXmp(new TextDecoder('utf-8').decode(b.subarray(seg.dataStart + XMP_ID.length, seg.end)));
      const packet = { seg, parsed: p, items: [], extSegs: [] };
      packet.items = addXmpItems(set, p, { secondary: true, carrier: opts.embedded ? 'gainmap' : 'photo', compact: !!opts.embedded }, { kind: 'xmp' }, seg.end - seg.dataStart - XMP_ID.length);
      model.xmpPackets.push(packet);
    }
    if (xmpSegs.length > MAX_DETAILED) {
      const extra = xmpSegs.slice(MAX_DETAILED);
      set.normalise = true;
      set.add({ id: 'xmp:extra-copies', group: 'hidden', tier: 'red', label: 'More copies of XMP data', value: `${extra.length} more, ${formatBytes(extra.reduce((n, s) => n + s.end - s.start, 0))}`, source: 'XMP' }, { kind: 'segs', segs: extra });
    }
  } else if (extSegs.length) {
    set.normalise = true;
    set.add({ id: 'xmp:extended', group: 'hidden', tier: 'red', label: 'Extra XMP data', value: formatBytes(extSegs.reduce((n, s) => n + s.end - s.start, 0)), source: 'XMP' }, { kind: 'segs', segs: extSegs });
  }

  // ICC profile, possibly spread over several segments.
  const iccSegs = byKind('icc');
  if (iccSegs.length) {
    const chunks = iccSegs.map((s) => ({ seq: b[s.dataStart + 12], at: Math.min(s.end, s.dataStart + 14), end: s.end })).sort((a, c) => a.seq - c.seq);
    const profile = concat(chunks.map((c) => b.subarray(c.at, c.end)));
    model.iccProfile = profile;
    const info = inspectIcc(profile);
    // A profile that cannot be read safely is offered whole, as red; otherwise the profile
    // is green and any text in it that is not a known name is a red detail of its own.
    // The segments number themselves 1 to n of n; other numbers are free bytes.
    const numbered = chunks.every((c, i) => c.seq === i + 1 && b[c.at - 1] === chunks.length);
    if (!info.ok) set.add({ ...ICC_UNREADABLE_ITEM, value: formatBytes(profile.length) }, { kind: 'segs', segs: iccSegs });
    else {
      set.add({ id: 'icc:profile', group: 'technical', tier: 'green', label: 'Colour profile', value: iccDescription(profile), source: 'ICC profile', note: 'Keeps colours accurate on different screens.' }, { kind: 'segs', segs: iccSegs });
      if (!info.clean || !numbered) {
        const value = [info.clean ? '' : iccFreeText(info), numbered ? '' : 'segment numbers that do not count 1 to n'].filter(Boolean).join('; ');
        set.add({ ...ICC_TEXT_ITEM, value }, { kind: 'icctext', segs: iccSegs, chunks, profile });
      }
    }
  }

  // Photoshop resources with IPTC.
  const irbSegs = byKind('irb');
  if (irbSegs.length) analyseIrb(b, irbSegs, set, model);

  const c2pa = byKind('c2pa');
  if (c2pa.length) {
    const d = describeC2pa(c2pa.map((s) => b.subarray(s.dataStart, s.end)));
    set.add({ id: 'jpeg:c2pa', group: 'hidden', tier: d.tier, label: 'Content Credentials (C2PA)', value: d.value, source: 'C2PA', note: d.note }, { kind: 'segs', segs: c2pa });
    model.c2paId = 'jpeg:c2pa';
  }

  const com = byKind('com');
  if (com.length) {
    const texts = com.map((s) => { const raw = b.subarray(s.dataStart, s.end); try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return latin1(raw); } });
    set.add({ id: 'jpeg:comment', group: 'hidden', tier: 'red', label: 'Comment', note: 'Free text written by a person or an app. It can hold names, places or notes.', value: texts.join(' / ').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'Empty comment', source: 'JPEG' }, { kind: 'segs', segs: com });
  }

  // JFIF, JFXX, Adobe
  const sof = w.sof;
  const rgbIds = sof && sof.components === 3 && sof.ids[0] === 82 && sof.ids[1] === 71 && sof.ids[2] === 66;
  for (const s of byKind('jfif')) {
    const d = s.dataStart;
    const tw = b[d + 12];
    const th = b[d + 13];
    const thumbEnd = Math.min(s.end, d + 14 + 3 * tw * th);
    const jfif = { seg: s, thumbEnd };
    model.jfif.push(jfif);
    if (tw && th) {
      set.add({ id: 'jpeg:jfif-thumbnail', group: 'hidden', tier: 'red', label: 'Built-in preview image', value: `${tw} × ${th} pixels`, source: 'JPEG', note: 'Can still show the original, uncropped photo after cropping.' }, { kind: 'jfif', part: 'thumb', jfif });
    }
    if (thumbEnd < s.end && nonZero(b, thumbEnd, s.end)) {
      set.add({ id: 'jpeg:jfif-extra', group: 'hidden', tier: 'red', label: 'Extra data in the file header', value: formatBytes(s.end - thumbEnd), source: 'JPEG', note: 'Bytes after the end of the JFIF header that no program reads. They may hold anything.' }, { kind: 'jfif', part: 'extra', jfif });
    }
    if (!rgbIds) {
      const units = b[d + 7];
      const xd = u16be(b, d + 8);
      const value = `Version ${b[d + 5]}.${String(b[d + 6]).padStart(2, '0')}${units ? `, ${xd} ${units === 2 ? 'dots per cm' : 'dpi'}` : ''}`;
      set.add({ id: 'jpeg:jfif', group: 'technical', tier: 'green', label: 'JFIF header', value, source: 'JPEG', note: 'Basic file information that helps programs open the picture.' }, { kind: 'segs', segs: [s] });
    }
  }
  const jfxx = byKind('jfxx');
  if (jfxx.length) set.add({ id: 'jpeg:jfxx', group: 'hidden', tier: 'red', label: 'Built-in preview image', value: formatBytes(jfxx.reduce((n, s) => n + s.end - s.start, 0)), source: 'JPEG', note: 'Can still show the original, uncropped photo after cropping.' }, { kind: 'segs', segs: jfxx });
  for (const s of byKind('adobe')) {
    const transform = b[s.dataStart + 11];
    const needed = !sof || sof.components === 4 || (sof.components === 3 && transform !== 1);
    const adobe = { seg: s };
    model.adobe.push(adobe);
    if (s.end > s.dataStart + 12 && nonZero(b, s.dataStart + 12, s.end)) {
      set.add({ id: 'jpeg:adobe-extra', group: 'hidden', tier: 'red', label: 'Extra data in the Adobe colour marker', value: formatBytes(s.end - s.dataStart - 12), source: 'JPEG', note: 'Bytes after the end of the marker that no program reads. They may hold anything.' }, { kind: 'adobe', adobe });
    }
    if (!needed) {
      set.add({ id: 'jpeg:adobe', group: 'technical', tier: 'green', label: 'Adobe colour marker', value: 'Colour encoding flag', source: 'JPEG', note: 'Some programs need it to show the colours correctly.' }, { kind: 'segs', segs: [s] });
    }
  }

  // Unidentified APPn segments, one item per identifier (up to a limit).
  const unknown = new Map();
  const seenIds = new Set();
  for (const s of byKind('unknown')) {
    const ident = appIdentifier(b, s);
    const slug = ident.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'data';
    const key = cappedId(seenIds, `jpeg:app${s.marker - 0xe0}:${slug}`, 'jpeg:app:other');
    if (!unknown.has(key)) unknown.set(key, { ident: key === 'jpeg:app:other' ? 'Several kinds' : ident, segs: [], marker: s.marker });
    unknown.get(key).segs.push(s);
  }
  for (const [key, u] of unknown) {
    const size = formatBytes(u.segs.reduce((n, s) => n + s.end - s.start, 0));
    set.add({ id: key, group: 'hidden', tier: 'red', label: 'Unidentified extra data from the device or software', value: u.ident ? `${u.ident} (${size})` : `APP${u.marker - 0xe0}, ${size}`, source: 'JPEG' }, { kind: 'segs', segs: u.segs });
  }

  for (const [id, t] of trailingItems) {
    const total = t.ranges.reduce((n, [s, e]) => n + e - s, 0);
    const def = t.def;
    const pub = { id, group: def.group, tier: def.tier, label: def.label, value: total ? formatBytes(total) : 'Index only', source: id === 'jpeg:mpf' ? 'JPEG' : 'After the image' };
    if (def.note) pub.note = def.note;
    set.add(pub, { kind: 'trailing', ranges: t.ranges, segs: t.segs, couple: t.couple });
  }

  // The gain map is a second picture with its own metadata; offer that metadata as its
  // own item, so the gain map can stay while what it says about the photo goes. Its colour
  // profile is green, like the photo's own.
  for (const r of regions.filter((x) => x.kind === 'gainmap')) {
    const inner = embeddedMetadata(b.subarray(r.contentStart ?? r.start, r.jpegEnd ?? r.end));
    if (!inner) continue;
    // The gain map's own XMP is kept in the canonical form too.
    if (inner.normalise) set.normalise = true;
    if (inner.meta) {
      // Red, so it is ticked to start with (only red is, since 0.0.3): inside the gain map a
      // detail can only go with all the others, and even a technical one may hold free text.
      set.add({ id: 'jpeg:trailing:gain-map:metadata', group: 'hidden', tier: 'red', label: 'Metadata inside the HDR gain map', value: inner.meta.value, source: 'After the image', note: 'The gain map is a second, hidden picture with its own copy of details about the photo. Removing this keeps the gain map but clears those details.' }, { kind: 'clean', region: r, part: 'meta' });
    }
    if (inner.icc) {
      // A readable profile is green, like the photo's own: an ISO 21496-1 gain map may be
      // applied in its own colour space (Skia uses the gain map's profile then), and any
      // text in it is a red detail of its own (colour-text below).
      set.add({ id: 'jpeg:trailing:gain-map:colour', group: 'technical', tier: 'green', label: 'Colour profile of the HDR gain map', value: inner.icc.value, source: 'After the image', note: 'Some HDR screens use it to apply the gain map in the right colours. Text in it is listed separately.' }, { kind: 'clean', region: r, part: 'icc' });
    }
    if (inner.iccBad) {
      set.add({ id: 'jpeg:trailing:gain-map:colour', group: 'hidden', tier: 'red', label: 'Colour profile of the HDR gain map that could not be read', value: inner.iccBad.value, source: 'After the image', note: 'It may hold anything, so removing it is the safe choice. Removing it keeps the gain map.' }, { kind: 'clean', region: r, part: 'icc' });
    }
    if (inner.iccText) {
      set.add({ id: 'jpeg:trailing:gain-map:colour-text', group: 'hidden', tier: 'red', label: 'Text inside the colour profile of the HDR gain map', value: inner.iccText.value, source: 'After the image', note: 'Text in the gain map\'s colour profile that is not a known profile name or copyright line, or data no colour engine reads. Removing it rewrites only that text and keeps the gain map.' }, { kind: 'clean', region: r, part: 'icctext' });
    }
  }

  // Apple's gain map needs the HDR headroom from the photo's Apple MakerNote. When a kept
  // Apple gain map follows, those two numbers are a detail of their own (amber, kept with
  // the gain map), so the rest of the MakerNote can go without them.
  const gainOwner = mpfOwner === GAIN_MAP_ITEM ? trailingItems.get(GAIN_MAP_ITEM) : null;
  if (gainOwner && model.exifFirst && regions.some((r) => r.kind === 'gainmap' && r.signals && r.signals.apple)) {
    const v = appleHdr(model.exifFirst.m);
    if (v && !set.has('exif:apple-hdr')) {
      set.add({ id: 'exif:apple-hdr', group: 'hidden', tier: 'amber', label: 'Apple HDR brightness', value: appleHdrValue(v), source: 'EXIF', note: 'Two numbers from the Apple maker notes that tell HDR screens how much brighter the gain map may make the photo. They stay with the gain map in a maker note of their own when the rest of the maker notes go. Removing them removes the HDR gain map too.' }, { kind: 'applehdr', seg: model.exifFirst.seg, values: v });
    }
  }
  if (gainOwner && set.has('exif:apple-hdr')) set.get(GAIN_MAP_ITEM).couple.push('exif:apple-hdr');

  model.width = sof ? sof.width : 0;
  model.height = sof ? sof.height : 0;
  model.orientation = model.orientation || 1;
  return model;
}

// What an embedded JPEG (a gain map) holds beyond what it needs to work as a gain map:
// { meta: { tier, value } | null, icc: { value, bytes } | null }, or null when it cannot be
// read.
function embeddedMetadata(sub) {
  const inner = new ItemSet();
  let m;
  try { m = analyseJpeg(sub, inner, { embedded: true }); } catch { return null; }
  const items = inner.items.filter((i) => !GAIN_MAP_OWN.has(i.id));
  const iccItem = inner.items.find((i) => i.id === 'icc:profile');
  const icc = iccItem ? { value: iccItem.value, bytes: m.iccProfile } : null;
  const iccText = inner.items.find((i) => i.id === 'icc:text') || null;
  const iccBad = inner.items.find((i) => i.id === 'icc:unreadable') || null;
  let meta = null;
  if (items.length) {
    const labels = [...new Set(items.map((i) => i.label))];
    meta = { tier: strictest(items.map((i) => i.tier)), value: labels.length > 3 ? `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more` : labels.join(', ') };
  }
  return { meta, icc, iccText, iccBad, normalise: !!inner.normalise };
}

// The same embedded JPEG with only what it needs to work as a gain map: its picture data,
// the first ISO 21496-1 segment cut to the bytes it defines, and the allowed gain map
// fields of its first XMP packet (meta), and with or without its colour profile (icc:
// true removes it). With meta false only the colour profile goes. icctext rewrites the
// text inside the colour profile to neutral values (same length, colours untouched); when
// that cannot be done safely the profile goes instead. Either way every XMP packet that
// stays is written in the canonical form (see rewriteXmp in xmp.js), without the packet
// wrapper; a packet that cannot be, and Extended XMP, go. Returns { bytes, lost } (lost:
// XMP the user kept had to go), or null when the gain map cannot be read.
function cleanEmbedded(sub, { meta = true, icc = false, icctext = false } = {}) {
  let w = walkJpeg(sub);
  if (!w || w.eoiEnd < 0) return null;
  if (icctext && !icc) {
    const segs = w.segs.filter((s) => s.kind === 'seg' && appKind(sub, s, w.sof) === 'icc');
    const chunks = segs.map((s) => ({ seq: sub[s.dataStart + 12], at: Math.min(s.end, s.dataStart + 14), end: s.end })).sort((a, c) => a.seq - c.seq);
    const cleaned = chunks.length ? cleanIcc(concat(chunks.map((c) => sub.subarray(c.at, c.end)))) : null;
    if (!cleaned) icc = true;
    else {
      sub = sub.slice();
      let o = 0;
      chunks.forEach((c, i) => { sub.set(cleaned.subarray(o, o + c.end - c.at), c.at); o += c.end - c.at; sub[c.at - 2] = i + 1; sub[c.at - 1] = chunks.length; });
      w = walkJpeg(sub);
      if (!w || w.eoiEnd < 0) return null;
    }
  }
  const parts = [];
  let lost = false;
  let isoSeen = false;
  let xmpSeen = false;
  const xmpOf = (s) => parseXmp(new TextDecoder('utf-8').decode(sub.subarray(s.dataStart + XMP_ID.length, s.end)));
  const xmpSeg = (text) => (text ? makeSegment(0xe1, concat([encodeLatin1(XMP_ID), encodeUtf8(text)])) : null);
  if (meta) for (const s of w.segs) if (s.kind === 'seg' || s.kind === 'sos') s.kindApp = s.kind === 'sos' ? (wellFormed(sub, s) ? 'structural' : 'marker') : appKind(sub, s, w.sof);
  const tables = meta ? unusedTables(sub, w) : null;
  for (const s of w.segs) {
    if (!meta) {
      const k = s.kind === 'seg' ? appKind(sub, s, w.sof) : null;
      if (icc && k === 'icc') continue;
      if (k === 'xmp') {
        const seg = xmpSeg(canonicalXmp(xmpOf(s), true));
        if (seg) parts.push(seg); else lost = true;
        continue;
      }
      if (k === 'xmpext') { lost = true; continue; }
      parts.push(sub.subarray(s.start, s.end));
      continue;
    }
    if (s.kind === 'junk' || s.kind === 'cut') continue;
    if (s.kind !== 'seg') { parts.push(sub.subarray(s.start, s.end)); continue; }
    const k = appKind(sub, s, w.sof);
    if (k === 'structural') {
      // Unused decoder tables go; the tables in use stay byte for byte.
      if (tables && tables.rebuild.has(s)) { const p = tables.rebuild.get(s); if (p) parts.push(makeSegment(s.marker, p)); continue; }
      parts.push(sub.subarray(s.start, s.end));
      continue;
    }
    if (k === 'icc') { if (!icc) parts.push(sub.subarray(s.start, s.end)); continue; }
    if (k === 'isogain') {
      if (isoSeen) continue;
      isoSeen = true;
      const pr = parseIsoGain(sub, s.dataStart + ISO_GAIN_ID.length, s.end);
      if (pr.ok) parts.push(makeSegment(0xe2, sub.subarray(s.dataStart, s.dataStart + ISO_GAIN_ID.length + pr.length)));
      continue;
    }
    if (k === 'jfif') {
      const head = sub.slice(s.dataStart, s.dataStart + 14);
      head[12] = 0; head[13] = 0;
      parts.push(makeSegment(0xe0, head));
      continue;
    }
    if (k === 'adobe') { parts.push(makeSegment(0xee, sub.subarray(s.dataStart, s.dataStart + 12))); continue; }
    if (k === 'xmp') {
      if (xmpSeen) continue;
      xmpSeen = true;
      const parsed = xmpOf(s);
      const allowed = gainAllowed(parsed, 'gainmap');
      const label = appleLabelFix(parsed);
      const seg = xmpSeg(keepOnlyXmp(parsed, (p, i) => allowed.has(i), [...(label ? [label.add] : []), ...gainFixes(parsed, 'gainmap').map((x) => x.add)]));
      if (seg) parts.push(seg);
      continue;
    }
    if (k === 'marker') continue;
    // EXIF, IPTC, comments, Content Credentials, MPF and anything unidentified go.
  }
  return { bytes: concat(parts), lost };
}

function analyseIrb(b, segs, set, model) {
  const payload = concat(segs.map((s) => b.subarray(s.dataStart + PS_ID.length, s.end)));
  const irb = parseIrb(payload);
  model.irb = { segs, irb, items: [] };
  const iptcRes = irb.res.find((r) => r.id === IRB_IPTC);
  if (iptcRes) {
    const iptc = parseIptc(payload.subarray(iptcRes.dataStart, iptcRes.dataEnd));
    model.irb.iptc = iptc;
    model.irb.iptcRes = iptcRes;
    for (const it of iptcItems(iptc)) {
      const pub = { id: `iptc:${it.key}`, group: it.group, tier: it.tier, label: it.label, value: it.value, source: 'IPTC' };
      if (it.note) pub.note = it.note;
      const id = set.add(pub, { kind: 'irb', part: 'iptc', key: it.key });
      model.irb.items.push(id);
    }
  }
  const thumbs = irb.res.filter((r) => IRB_THUMBS.has(r.id));
  if (thumbs.length) {
    const id = set.add({ id: 'irb:thumbnail', group: 'hidden', tier: 'red', label: 'Built-in preview image', value: formatBytes(thumbs.reduce((n, r) => n + r.dataEnd - r.dataStart, 0)), source: 'IPTC', note: 'Photoshop preview. Can still show the original, uncropped photo after cropping.' }, { kind: 'irb', part: 'thumbs' });
    model.irb.items.push(id);
  }
  const embedded = irb.res.filter((r) => r.id === IRB_XMP || IRB_EXIF.has(r.id));
  if (embedded.length) {
    const id = set.add({ id: 'irb:embedded', group: 'hidden', tier: 'red', label: 'Copy of EXIF or XMP inside Photoshop data', value: irbOtherValue(embedded), source: 'IPTC', note: 'May repeat location, names or serial numbers.' }, { kind: 'irb', part: 'embedded' });
    model.irb.items.push(id);
  }
  const other = irb.res.filter((r) => r.id !== IRB_IPTC && r.id !== IRB_IPTC_DIGEST && !IRB_THUMBS.has(r.id) && r.id !== IRB_XMP && !IRB_EXIF.has(r.id));
  if (other.length) {
    const id = set.add({ id: 'irb:other', group: 'hidden', tier: 'red', label: 'Other Photoshop data', value: irbOtherValue(other), source: 'IPTC', note: IRB_OTHER_NOTE }, { kind: 'irb', part: 'other' });
    model.irb.items.push(id);
  }
  if (irb.rest < payload.length && nonZero(payload, irb.rest, payload.length)) {
    const id = set.add({ id: 'irb:unreadable', group: 'hidden', tier: 'red', label: 'Photoshop data that could not be read', value: formatBytes(payload.length - irb.rest), source: 'IPTC', note: 'It may hold anything, so removing it is the safe choice.' }, { kind: 'irb', part: 'rest' });
    model.irb.items.push(id);
  }
  // The block only stays in the canonical form (see canonicalIrb in iptc.js): when the
  // file's block is not already exactly that, keeping everything still changes the file.
  const canon = irbSegments(canonicalIrb(irb, model.irb.iptc, model.irb.iptcRes));
  const old = concat(segs.map((s) => b.subarray(s.start, s.end)));
  if (!canon || !bytesEqual(concat(canon), old)) set.normalise = true;
}

// The APP13 segments that carry a Photoshop block, or null when a part is too large.
function irbSegments(data) {
  const out = [];
  for (let p = 0; p < data.length; p += 65000) {
    const seg = makeSegment(0xed, concat([encodeLatin1(PS_ID), data.subarray(p, p + 65000)]));
    if (!seg) return null;
    out.push(seg);
  }
  return out;
}

const bytesEqual = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

// ======================================================================================
// Removal

const GAIN_MAP_ITEM = TRAILING.gainmap.id;
export const GAIN_MAP_UNUSABLE = 'An Apple HDR gain map without the HDR brightness it needs, so no screen can show it in HDR. It is a second picture that may hold anything, so it is removed by default. Removing it leaves the normal picture unchanged.';
export const IRB_REST_KEPT = 'Photoshop data that could not be read was removed although it was not ticked: Photoshop data is always written again in a standard form, which only holds what can be read.';

// Extended XMP (XMP Specification Part 3, 1.1.3.1): one packet split across APP1 segments,
// each holding the identifier, a 32-character GUID (the MD5 of the whole packet in upper-case
// hexadecimal), the packet's full length and this part's offset, both 32-bit big-endian,
// then the part. extendedText gathers the parts with the GUID the photo's packet gives and
// returns the packet, or null when they do not make it up exactly.
const EXT_HEAD = XMP_EXT_ID.length + 32 + 8;
function extendedText(b, segs, guid) {
  if (!/^[0-9A-F]{32}$/.test(guid)) return null;
  const parts = [];
  let total = -1;
  for (const s of segs) {
    if (s.end - s.dataStart < EXT_HEAD || latin1(b, s.dataStart + XMP_EXT_ID.length, s.dataStart + XMP_EXT_ID.length + 32) !== guid) continue;
    const full = u32be(b, s.dataStart + XMP_EXT_ID.length + 32);
    if (total >= 0 && full !== total) return null;
    total = full;
    parts.push({ off: u32be(b, s.dataStart + XMP_EXT_ID.length + 36), data: b.subarray(s.dataStart + EXT_HEAD, s.end) });
  }
  if (total < 0 || total > 64 << 20) return null;
  parts.sort((x, y) => x.off - y.off);
  const whole = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    if (p.off !== at || at + p.data.length > total) return null;
    whole.set(p.data, at);
    at += p.data.length;
  }
  if (at !== total) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(whole); } catch { return null; }
}

// Whether a file's Extended XMP is already in the form the scrub writes: the packet the
// photo's HasExtendedXMP points to, canonical, split as extendedSegments splits it, in
// consecutive segments with nothing else among them.
function extendedCanonical(b, parsed, extSegs) {
  const f = parsed.ok ? parsed.props.find((p) => p.key === 'xmpNote:HasExtendedXMP' && (p.kind === 'attr' || p.kind === 'elem')) : null;
  const text = f ? extendedText(b, extSegs, String(f.value).trim()) : null;
  const canon = text !== null ? canonicalXmp(parseXmp(text), true) : null;
  const segs = canon !== null ? extendedSegments(canon) : null;
  if (!segs || segs.guid !== String(f.value).trim()) return false;
  const contiguous = extSegs.every((x, i) => i === 0 || extSegs[i - 1].end === x.start);
  return contiguous && bytesEqual(concat(segs.segs), b.subarray(extSegs[0].start, extSegs[extSegs.length - 1].end));
}

// The segments of an Extended XMP packet written from text: { guid, segs }, or null.
function extendedSegments(text) {
  const bytes = encodeUtf8(text);
  const guid = Array.from(md5(bytes), (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  const room = 65533 - EXT_HEAD;
  const segs = [];
  for (let off = 0; off < bytes.length; off += room) {
    const head = new Uint8Array(8);
    const v = new DataView(head.buffer);
    v.setUint32(0, bytes.length);
    v.setUint32(4, off);
    const seg = makeSegment(0xe1, concat([encodeLatin1(XMP_EXT_ID), encodeLatin1(guid), head, bytes.subarray(off, off + room)]));
    if (!seg) return null;
    segs.push(seg);
  }
  return segs.length ? { guid, segs } : null;
}
// Parts after the image that a Container directory entry can stand for.
const MEDIA = new Set(['gainmap', 'mpf', 'preview', 'jpeg', 'video', 'samsung']);

// The part after the image each directory entry stands for: 'primary' for the first, a
// region, or null when it stands for nothing found. A Motion Photo video may sit inside a
// Samsung trailer; no other entry is matched to one.
function mapDirectory(dir, regions) {
  const media = regions.filter((r) => MEDIA.has(r.kind));
  const used = new Set();
  const take = (test) => { const r = media.find((x) => !used.has(x) && test(x)); if (r) used.add(r); return r || null; };
  return dir.dir.entries.map((e, n) => {
    if (n === 0) return 'primary';
    if (e.semantic === 'GainMap') return take((x) => x.kind === 'gainmap') || take((x) => x.kind !== 'video' && x.kind !== 'samsung');
    if (e.semantic === 'MotionPhoto') return take((x) => x.kind === 'video') || take((x) => x.kind === 'samsung' && x.hasVideo);
    return take((x) => x.kind !== 'samsung');
  });
}

// Where each directory entry's part lands in the new file, and the Item:Length and
// Item:Padding that follow from it. Positions are relative to the end of the photo. Returns
// a patch for rewriteXmp, or null when nothing in the directory changes. An entry whose part
// is cut goes; a video inside a kept Samsung trailer keeps its entry as it is, because its
// position counts from the end of the file, which does not move.
function planDirectory(dir, regions, placed, isCut) {
  const map = mapDirectory(dir, regions);
  const drop = new Set();
  const length = new Map();
  const padding = new Map();
  const spans = map.map((r, n) => {
    if (r === 'primary') return { at: 0, len: 0 };
    if (!r) return null;
    if (isCut(r)) { drop.add(n); return 'gone'; }
    if (r.kind === 'samsung') return null;
    const parts = regions.filter((x) => x === r || x.owner === r).map((x) => placed.get(x)).filter(Boolean);
    if (!parts.length) return null;
    const len = parts.reduce((s, p) => s + p.contentLen, 0);
    length.set(n, len);
    return { at: parts[0].contentAt, len };
  });
  spans.forEach((sp, n) => {
    if (!sp || sp === 'gone' || !dir.dir.entries[n].fields.Padding) return;
    for (let m = n + 1; m < spans.length; m++) {
      if (spans[m] === 'gone') continue;
      if (spans[m]) padding.set(n, Math.max(0, spans[m].at - (sp.at + sp.len)));
      return;
    }
  });
  const differs = (map2, field) => [...map2].some(([n, v]) => { const f = dir.dir.entries[n].fields[field]; return f && f.value !== String(v); });
  if (!drop.size && !differs(length, 'Length') && !differs(padding, 'Padding')) return null;
  return { index: dir.index, drop, length, padding };
}

// Whether the HDR gain map in a finished file can still be found and used: every image the
// MPF index lists starts with a JPEG start marker at its offset and ends inside its size,
// the first entry is the photo, the directory's gain map length is one of those sizes and
// its entries land on their parts, and the photo still carries what pointed a reader to
// the gain map before (need: { version, iso, dirGainMap }, each true when required).
function gainMapIntact(bytes, need = {}) {
  const w = walkJpeg(bytes);
  if (!w || w.eoiEnd < 0) return false;
  const seg = w.segs.find((s) => s.kind === 'seg' && s.marker === 0xe2 && startsWith(bytes, s.dataStart, 'MPF\0'));
  const sizes = [];
  const starts = [];
  if (seg) {
    const m = parseMpf(bytes, seg);
    if (!m) return false;
    for (const e of m.entries) {
      if (e.index === 0) { if (e.size !== w.eoiEnd) return false; continue; }
      if (!e.size) continue;
      const at = m.base + e.offset;
      if (at < w.eoiEnd || at + e.size > bytes.length) return false;
      const ew = walkJpeg(bytes.subarray(at, at + e.size));
      if (!ew || ew.eoiEnd < 0) return false;
      sizes.push(e.size);
      starts.push(at);
    }
  }
  const x = w.segs.find((s) => s.kind === 'seg' && s.marker === 0xe1 && startsWith(bytes, s.dataStart, XMP_ID));
  const parsed = x ? parseXmp(new TextDecoder('utf-8').decode(bytes.subarray(x.dataStart + XMP_ID.length, x.end))) : null;
  const d = parsed ? directoryOf(parsed) : null;
  if (seg && d) {
    if (d.dir.entries.some((e) => e.semantic === 'GainMap' && e.length !== null && !sizes.includes(e.length))) return false;
    // Each entry counted from the end of the photo: a gain map entry lands on an image the
    // index lists, and nothing points past the end of the file.
    let pos = w.eoiEnd;
    for (const [n, e] of d.dir.entries.entries()) {
      if (n === 0) { pos += e.padding || 0; continue; }
      if (e.length === null) break;
      if (e.semantic === 'GainMap' && !starts.includes(pos)) return false;
      if (pos + e.length > bytes.length) return false;
      pos += e.length + (e.padding || 0);
    }
  }
  if (need.dirGainMap && !(d && d.dir.entries.some((e) => e.semantic === 'GainMap'))) return false;
  if (need.version && !hasGainVersion(parsed)) return false;
  if (need.iso) {
    const iso = w.segs.find((s) => s.kind === 'seg' && s.marker === 0xe2 && startsWith(bytes, s.dataStart, ISO_GAIN_ID));
    const at = iso ? iso.dataStart + ISO_GAIN_ID.length : -1;
    if (!iso || iso.end - at < 4 || u16be(bytes, at) !== 0) return false;
  }
  return true;
}

export function scrubJpeg(b, model, set, removeIn, retry = true) {
  const remove = new Set(removeIn);
  const warnings = [];
  const out = b.slice();
  const drop = new Set();
  const replace = new Map();
  const cut = [];
  const clean = new Map();
  let mpfParts = null;
  let wholeMpf = false;
  const isoPlans = [];
  let iccText = null;
  // Starts again without the gain map, when it cannot be kept safely.
  const withoutGainMap = (why) => {
    const again = scrubJpeg(b, model, set, new Set([...removeIn, GAIN_MAP_ITEM]), false);
    return { bytes: again.bytes, warnings: [why, ...again.warnings] };
  };

  // Coupled removals. A gain map whose XMP description goes cannot be found any more, so it
  // goes too; and trailing media take their XMP descriptors with them.
  const gainItem = set.get(GAIN_MAP_ITEM);
  if (gainItem && gainItem.couple.some((c) => remove.has(c))) remove.add(GAIN_MAP_ITEM);
  for (const id of [...remove]) {
    const it = set.get(id);
    if (it && it.kind === 'trailing') for (const c of it.couple) remove.add(c);
  }

  const exifKeys = new Map();
  const jfifParts = new Map();
  const adobeExtra = new Set();
  for (const id of remove) {
    const it = set.get(id);
    if (!it) continue;
    switch (it.kind) {
      case 'exif':
        if (!exifKeys.has(it.seg)) exifKeys.set(it.seg, new Set());
        exifKeys.get(it.seg).add(it.key);
        break;
      case 'segs':
        for (const s of it.segs) drop.add(s);
        break;
      case 'jfif':
        if (!jfifParts.has(it.jfif)) jfifParts.set(it.jfif, new Set());
        jfifParts.get(it.jfif).add(it.part);
        break;
      case 'adobe':
        adobeExtra.add(it.adobe);
        break;
      case 'trailing':
        for (const s of it.segs) drop.add(s);
        cut.push(...it.ranges);
        break;
      case 'clean': {
        const c = clean.get(it.region) || { meta: false, icc: false, icctext: false };
        c[it.part] = true;
        clean.set(it.region, c);
        break;
      }
      case 'mpfpart':
        // The index is written again from what a reader needs, so rebuilding it for the image
        // IDs or the layout details also leaves out the unexplained data.
        if (!mpfParts) mpfParts = new Set();
        mpfParts.add(it.part);
        if (it.whole) wholeMpf = true;
        for (const s of it.segs || []) drop.add(s);
        break;
      case 'iso':
        isoPlans.push(...it.plan);
        break;
      case 'icctext':
        iccText = it;
        break;
      case 'tables':
        for (const [seg, payload] of it.rebuild) {
          if (!payload) drop.add(seg);
          else replace.set(seg, makeSegment(seg.marker, payload));
        }
        break;
      default:
        break;
    }
  }

  // An Apple gain map that stays keeps the photo's two HDR numbers: when the MakerNote
  // goes, a MakerNote holding only those takes its place.
  const appleId = set.has('exif:apple-hdr') && set.get('exif:apple-hdr').kind === 'applehdr' ? 'exif:apple-hdr' : null;
  const apple = appleId && !remove.has(appleId) ? set.get(appleId) : null;
  for (const [s, keys] of exifKeys) {
    const tStart = s.dataStart + 6;
    const m = parseTiff(out.subarray(tStart, s.end));
    if (!m) continue;
    const shrink = !!apple && apple.seg === s && keys.has('makernote');
    const rest = shrink ? new Set([...keys].filter((k) => k !== 'makernote')) : keys;
    const res = rest.size ? removeTiffKeys(m, rest) : { empty: false };
    if (shrink) {
      const m2 = parseTiff(out.subarray(tStart, s.end));
      if (!m2 || !shrinkAppleNote(m2, apple.values)) {
        if (m2) removeTiffKeys(m2, new Set(['makernote']));
        warnings.push('The Apple HDR brightness could not be kept on its own, so the maker notes were removed with it.');
      }
    }
    if (res.empty) drop.add(s);
  }

  for (const s of model.exifPad || []) out[s.dataStart + 5] = 0;

  // JFIF: the 14-byte header, then the thumbnail and any extra bytes only if kept.
  for (const [jfif, parts] of jfifParts) {
    const s = jfif.seg;
    if (drop.has(s)) continue;
    const head = out.slice(s.dataStart, s.dataStart + 14);
    if (parts.has('thumb')) { head[12] = 0; head[13] = 0; }
    const pieces = [head];
    if (!parts.has('thumb')) pieces.push(out.subarray(s.dataStart + 14, jfif.thumbEnd));
    if (!parts.has('extra')) pieces.push(out.subarray(jfif.thumbEnd, s.end));
    replace.set(s, makeSegment(0xe0, concat(pieces)));
  }
  for (const adobe of adobeExtra) {
    const s = adobe.seg;
    if (!drop.has(s)) replace.set(s, makeSegment(0xee, out.subarray(s.dataStart, s.dataStart + 12)));
  }

  // After the image: each region is cut, copied as it is or cleaned. Planned before the XMP,
  // because the Container directory lists the lengths that result. Positions are relative
  // to the end of the photo.
  const isCut = (r) => cut.some(([s, e]) => s <= r.start && r.end <= e) || (r.owner ? isCut(r.owner) : false);
  const eoiEnd = model.w.eoiEnd;
  const plan = [];
  const placed = new Map();
  if (eoiEnd >= 0) {
    let rel = 0;
    let p = eoiEnd;
    for (const r of model.regions) {
      if (r.start > p) { plan.push({ range: [p, r.start] }); rel += r.start - p; }
      p = r.end;
      if (isCut(r)) continue;
      const cs = r.contentStart ?? r.start;
      // A kept gain map is always passed through cleanEmbedded, so its XMP is written in the
      // canonical form even when nothing in it goes.
      const c = clean.get(r) || (r.kind === 'gainmap' ? { meta: false, icc: false, icctext: false } : null);
      let pl;
      if (c) {
        const res = cleanEmbedded(out.subarray(cs, r.jpegEnd ?? r.end), c);
        if (!res) {
          if (retry) return withoutGainMap('The metadata inside the HDR gain map could not be cleared safely, so the gain map was removed instead.');
          continue;
        }
        const cleaned = res.bytes;
        if (res.lost) warnings.push('Some XMP data inside the HDR gain map could not be written again in a standard form, so it was removed.');
        pl = { r, range: cs > r.start ? [r.start, cs] : null, bytes: cleaned, contentAt: rel + cs - r.start, contentLen: cleaned.length };
        rel += cs - r.start + cleaned.length;
      } else {
        // Zero padding after an MPF image, outside its size, is copied but not counted in it.
        pl = { r, range: [r.start, r.end], contentAt: rel + cs - r.start, contentLen: (r.entryEnd ?? r.end) - cs };
        rel += r.end - r.start;
      }
      plan.push(pl);
      placed.set(r, pl);
    }
    if (p < out.length) plan.push({ range: [p, out.length] });
  }

  // The Container directory follows the parts it lists: an entry goes with its part, and
  // lengths and padding are set to what the new file holds. When only the gain map goes,
  // a kept Motion Photo video keeps the directory.
  const pk = model.xmpPacket;
  let dirPatch = null;
  let rescue = null;
  const dir = pk && eoiEnd >= 0 ? directoryOf(pk.parsed) : null;
  if (dir) {
    const holder = pk.items.find((it) => it.props.includes(dir.index));
    const motion = pk.items.find((it) => it.key === 'motion');
    const videoKept = model.regions.some((r) => r.kind === 'video' && !isCut(r));
    const holderGone = holder && remove.has(holder.id);
    if (holderGone && holder.key === 'gainmap' && motion && !remove.has(motion.id) && videoKept) rescue = new Set([dir.index]);
    if (!holderGone || rescue) dirPatch = planDirectory(dir, model.regions, placed, isCut);
  }

  // A kept gain map described by hdrgm needs hdrgm:Version in the photo: a malformed one that
  // goes is written again with the one value the specification defines.
  const keptGain = model.regions.find((r) => r.kind === 'gainmap' && !isCut(r)) || null;
  let add = [];
  if (pk && keptGain && keptGain.signals && keptGain.signals.hdrgm) {
    const fix = versionFix(pk.parsed);
    const owner = fix ? pk.items.find((it) => it.props.includes(fix.index)) : null;
    if (owner && remove.has(owner.id)) add = [fix.add];
    // Gain map numbers with more digits than they need are written again, rounded.
    for (const fx of gainFixes(pk.parsed)) {
      const it = pk.items.find((x) => x.props.includes(fx.index));
      if (it && remove.has(it.id)) add.push(fx.add);
    }
  }

  // Extended XMP that stays is written again in the canonical form, split into segments
  // again, and the photo's packet points to it by the new GUID. When it cannot be, it goes
  // with the field that points to it.
  let extPlan = null;
  const extItem = pk ? pk.items.find((i) => i.key === 'extended') : null;
  if (pk && pk.extSegs.length && extItem && !remove.has(extItem.id)) {
    const fieldIdx = pk.parsed.props.findIndex((p) => p.key === 'xmpNote:HasExtendedXMP' && (p.kind === 'attr' || p.kind === 'elem'));
    const field = fieldIdx >= 0 ? pk.parsed.props[fieldIdx] : null;
    const text = field ? extendedText(out, pk.extSegs, field.value.trim()) : null;
    const canon = text !== null ? canonicalXmp(parseXmp(text), true) : null;
    const segs = canon !== null ? extendedSegments(canon) : null;
    if (segs) {
      const name = field.kind === 'attr' ? field.attr.name : field.node.name;
      extPlan = { segs: segs.segs, also: [fieldIdx], add: { key: field.key, name, node: field.node, value: segs.guid } };
    } else {
      remove.add(extItem.id);
      warnings.push('The extra XMP data could not be written again in a standard form, so it was removed.');
    }
  }

  // XMP
  for (const pkt of model.xmpPackets) {
    const { seg, parsed, items, extSegs } = pkt;
    const main = pkt === pk ? { dirPatch, rescue, add: extPlan ? [...add, extPlan.add] : add, also: extPlan ? extPlan.also : [] } : {};
    const xplan = planXmp(parsed, items, remove, false, main);
    if (xplan.warning) warnings.push(xplan.warning);
    const ext = items.find((i) => i.key === 'extended');
    // The old segments go in every case; kept Extended XMP takes the place of the first.
    for (const s of extSegs) drop.add(s);
    if (xplan.action === 'drop') {
      drop.add(seg);
    } else {
      const seg2 = makeSegment(0xe1, concat([encodeLatin1(XMP_ID), encodeUtf8(xplan.text)]));
      if (seg2) replace.set(seg, seg2);
      else { drop.add(seg); warnings.push('The XMP data was too large to rewrite, so all of it was removed instead.'); }
      if (seg2 && ext && extPlan && pkt === pk && !remove.has(ext.id)) {
        drop.delete(extSegs[0]);
        replace.set(extSegs[0], concat(extPlan.segs));
      }
    }
  }
  // Further copies of the packet, and Extended XMP without a packet that points to it, are
  // never kept as they are: a further copy that stays is written again in the canonical
  // form, and orphaned Extended XMP goes.
  for (const id of ['xmp:extra-copies', 'xmp:extended']) {
    const it = set.has(id) ? set.get(id) : null;
    if (!it || it.kind !== 'segs' || remove.has(id)) continue;
    if (id === 'xmp:extended') {
      for (const s of it.segs) drop.add(s);
      warnings.push('Extra XMP data that no XMP packet points to was removed, because it cannot be kept in a standard form.');
      continue;
    }
    for (const s of it.segs) {
      const text = canonicalXmp(parseXmp(new TextDecoder('utf-8').decode(out.subarray(s.dataStart + XMP_ID.length, s.end))));
      const seg2 = text !== null ? makeSegment(0xe1, concat([encodeLatin1(XMP_ID), encodeUtf8(text)])) : null;
      if (seg2) replace.set(s, seg2);
      else { drop.add(s); warnings.push('A copy of the XMP data could not be written again in a standard form, so it was removed.'); }
    }
  }

  // The multi-picture index, written again without the parts removed from it.
  const mpfSeg = model.segs.find((s) => s.kindApp === 'mpf');
  let mpfBuilt = null;
  if (mpfSeg && mpfParts && !drop.has(mpfSeg)) {
    if (wholeMpf || !model.mpf || !model.mpfStrict.ok) {
      drop.add(mpfSeg);
      warnings.push('The multi-picture index could not be read, so it was removed. Some programs may no longer find the extra image after the picture.');
    } else {
      const built = buildMpf(model.mpfStrict, model.mpf.entries, { ids: !mpfParts.has('ids'), layout: !mpfParts.has('layout') });
      const seg2 = makeSegment(0xe2, built.payload);
      if (seg2) { replace.set(mpfSeg, seg2); mpfBuilt = built; } else drop.add(mpfSeg);
    }
  }
  // Text inside the colour profile: the profile is rewritten in place (same length, the
  // colour tags untouched), across the segments it is split over.
  if (iccText && !iccText.segs.some((s) => drop.has(s))) {
    const cleaned = cleanIcc(iccText.profile);
    if (cleaned) {
      let o = 0;
      iccText.chunks.forEach((c, i) => {
        out.set(cleaned.subarray(o, o + c.end - c.at), c.at);
        o += c.end - c.at;
        // The segments are numbered again 1 to n of n, in the order the profile is read.
        if (c.at >= 2) { out[c.at - 2] = i + 1; out[c.at - 1] = iccText.chunks.length; }
      });
    } else {
      for (const s of iccText.segs) drop.add(s);
      warnings.push('The text inside the colour profile could not be removed safely, so the whole colour profile was removed. Colours may look slightly different.');
    }
  }
  // ISO 21496-1: the first segment cut to the bytes it defines, anything else dropped.
  for (const { seg, keepEnd } of isoPlans) {
    if (drop.has(seg)) continue;
    if (keepEnd < 0) drop.add(seg);
    else replace.set(seg, makeSegment(0xe2, out.subarray(seg.dataStart, keepEnd)));
  }

  // Photoshop resources: a block that stays is always written again in the canonical form
  // (see canonicalIrb in iptc.js), even when nothing in it goes.
  if (model.irb) {
    const { segs, irb, iptc, iptcRes, items } = model.irb;
    const gone = items.filter((id) => remove.has(id));
    if (gone.length === items.length) {
      for (const s of segs) drop.add(s);
    } else {
      const removeIptc = new Set(gone.filter((id) => set.get(id).part === 'iptc').map((id) => set.get(id).key));
      const parts = new Set(gone.map((id) => set.get(id).part));
      if (items.some((id) => set.get(id).part === 'rest' && !remove.has(id))) warnings.push(IRB_REST_KEPT);
      const chunks = irbSegments(canonicalIrb(irb, iptc, iptcRes, { parts, removeIptc }));
      if (!chunks || !chunks.length) for (const s of segs) drop.add(s);
      else segs.forEach((s, i) => { if (i === 0) replace.set(s, concat(chunks)); else drop.add(s); });
    }
  }

  // Keeping Content Credentials while changing anything else breaks their signature.
  if (model.c2paId && !remove.has(model.c2paId) && (drop.size || replace.size || cut.length || exifKeys.size || clean.size || iccText)) {
    warnings.push('Content Credentials were kept, but any change to the file makes their signature fail, so checkers will report the picture as altered.');
  }

  const asm = new Assembler(out);
  let lastWasSoi = false;
  let mpfOutAt = -1;
  for (const s of model.segs) {
    if (drop.has(s)) continue;
    // Stray bytes right after the start marker would stop the picture from opening.
    if (lastWasSoi && s.kind === 'junk') { warnings.push('Stray bytes at the start of the file were removed, because the picture would not open with them there.'); continue; }
    lastWasSoi = s.kind === 'soi';
    if (replace.has(s)) {
      if (s === mpfSeg) mpfOutAt = asm.length;
      asm.add(replace.get(s));
      continue;
    }
    asm.copy(s.start, s.end);
  }

  // After the image, as planned.
  const trailStart = asm.length;
  if (eoiEnd < 0) {
    const last = model.segs[model.segs.length - 1];
    if (last && last.end < out.length) asm.copy(last.end, out.length);
  } else {
    for (const pl of plan) {
      if (pl.range) asm.copy(pl.range[0], pl.range[1]);
      if (pl.bytes) asm.add(pl.bytes);
    }
  }
  // Nothing left after the start marker: end the file properly, so it is still a JPEG.
  if (asm.length === 2) asm.add(new Uint8Array([0xff, 0xd9]));
  const result = asm.finish();

  // Keep the MPF index pointing at the images it lists, with their new sizes.
  if (model.mpf && mpfSeg && !drop.has(mpfSeg)) {
    const le = model.mpf.le;
    const put = (pos, v) => {
      if (le) { result[pos] = v & 255; result[pos + 1] = (v >>> 8) & 255; result[pos + 2] = (v >>> 16) & 255; result[pos + 3] = v >>> 24; }
      else { result[pos] = v >>> 24; result[pos + 1] = (v >>> 16) & 255; result[pos + 2] = (v >>> 8) & 255; result[pos + 3] = v & 255; }
    };
    const base = mpfBuilt ? mpfOutAt + 8 : asm.map(model.mpf.base);
    const posOf = mpfBuilt
      ? (e) => [base + mpfBuilt.tablePos + 16 * e.index + 4, base + mpfBuilt.tablePos + 16 * e.index + 8]
      : (e) => [asm.map(e.sizePos), asm.map(e.offsetPos)];
    for (const e of model.mpf.entries) {
      const [sizePos, offPos] = posOf(e);
      if (base < 0 || sizePos < 0 || offPos < 0) continue;
      if (e.index === 0) {
        if (eoiEnd > 0) put(sizePos, asm.map(eoiEnd - 1) + 1);
        continue;
      }
      const mine = plan.filter((pl) => pl.r && pl.r.entry === e);
      if (mine.length) {
        put(offPos, trailStart + mine[0].contentAt - base);
        put(sizePos, mine.reduce((n, pl) => n + pl.contentLen, 0));
        continue;
      }
      if (!e.size) continue;
      const target = asm.map(model.mpf.base + e.offset);
      if (target < 0) { put(sizePos, 0); put(offPos, 0); continue; }
      put(offPos, target - base);
    }
  }

  // A kept gain map must still be found where the index and the directory say it is, and
  // the photo must still point to it the way it did.
  if (retry && keptGain) {
    const sig = keptGain.signals || {};
    const need = {
      version: !!(sig.hdrgm && model.signals && model.signals.version),
      iso: !!(sig.iso && model.signals && model.signals.iso),
      dirGainMap: !!(model.signals && model.signals.dirGainMap),
    };
    if (!gainMapIntact(result, need)) return withoutGainMap('The HDR gain map could not be kept safely, so it was removed.');
  }
  return { bytes: result, warnings };
}

// ======================================================================================
// Insertion into a freshly encoded JPEG

export function insertJpegExif(b, tiff) {
  const w = walkJpeg(b);
  if (!w) throw new Error('Not a JPEG file');
  const payload = concat([encodeLatin1('Exif\0\0'), tiff]);
  const seg = makeSegment(0xe1, payload);
  if (!seg) throw new Error('The EXIF data is too large for a JPEG segment');
  const asm = new Assembler(b);
  let inserted = false;
  for (const s of w.segs) {
    const isExif = s.kind === 'seg' && s.marker === 0xe1 && startsWith(b, s.dataStart, 'Exif\0');
    if (isExif) continue;
    const isJfif = s.kind === 'seg' && s.marker === 0xe0;
    if (!inserted && s.kind !== 'soi' && !isJfif) { asm.add(seg); inserted = true; }
    asm.copy(s.start, s.end);
  }
  if (!inserted) asm.add(seg);
  const last = w.segs[w.segs.length - 1];
  if (last.end < b.length) asm.copy(last.end, b.length);
  return asm.finish();
}
