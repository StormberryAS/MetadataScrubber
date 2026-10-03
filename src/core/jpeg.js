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
  Assembler, concat, encodeLatin1, encodeUtf8, formatBytes, indexOfAscii, latin1, startsWith, u16be, u32be, u32le, u64be, w16be,
} from './bytes.js?v=b373c219';
import { describeC2pa } from './c2pa.js?v=366e87df';
import { iccDescription } from './icc.js?v=1ac906b0';
import {
  IRB_EXIF, IRB_IPTC, IRB_IPTC_DIGEST, IRB_THUMBS, IRB_XMP, iptcItems, irbOtherValue, parseIptc, parseIrb, rebuildIptc, rebuildIrb,
} from './iptc.js?v=0c70531b';
import { ItemSet, UNREADABLE, cappedId, strictest } from './taxonomy.js?v=5970adfd';
import { parseTiff, removeTiffKeys, tiffItems, tiffOrientation } from './tiff.js?v=262e0fe8';
import { addXmpItems, keepOnlyXmp, parseXmp, planXmp } from './xmp.js?v=f2cbf417';

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
      sizePos: base + p + 4,
      offsetPos: base + p + 8,
      le: m.le,
    });
  }
  return { base, entries, le: m.le };
}

// Hints the primary XMP gives about trailing media.
function xmpHints(text) {
  const hints = { videoLength: 0, gainMap: false, motion: false };
  if (!text) return hints;
  if (/hdrgm:|HDRGainMap/.test(text) || /Semantic=["']GainMap["']/.test(text)) hints.gainMap = true;
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

function embeddedIsGainMap(b, start, end) {
  const w = walkJpeg(b.subarray(start, end));
  if (!w) return false;
  const sub = b.subarray(start, end);
  return w.segs.some((s) => s.kind === 'seg' && ((s.marker === 0xe2 && startsWith(sub, s.dataStart, ISO_GAIN_ID))
    || (s.marker === 0xe1 && startsWith(sub, s.dataStart, XMP_ID) && indexOfAscii(sub, 'hdrgm', s.dataStart, s.end) >= 0)));
}

function classifyTrailing(b, start, mpf, hints) {
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
      const gain = embeddedIsGainMap(b, mr.start, mr.end) || (hints.gainMap && type === 0);
      regions.push({ kind: gain ? 'gainmap' : (type === 0x010001 || type === 0x010002) ? 'preview' : 'mpf', start: mr.start, end: mr.end });
      p = mr.end;
      continue;
    }
    if (p + 3 <= tail && b[p] === 0xff && b[p + 1] === 0xd8 && b[p + 2] === 0xff) {
      const w = walkJpeg(b.subarray(p, tail));
      if (w && w.eoiEnd > 0) {
        const end = p + w.eoiEnd;
        regions.push({ kind: embeddedIsGainMap(b, p, end) ? 'gainmap' : 'jpeg', start: p, end });
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
  gainmap: { id: 'jpeg:trailing:gain-map', group: 'hidden', tier: 'amber', label: 'HDR gain map', note: 'An extra image that makes the picture brighter on HDR screens. Removing it leaves the normal picture unchanged.' },
  mpf: { id: 'jpeg:trailing:mpf-image', group: 'hidden', tier: 'red', label: 'Extra embedded image', note: 'Another picture stored in the file, for example a second camera view or an uncropped version.' },
  preview: { id: 'jpeg:trailing:preview', group: 'hidden', tier: 'red', label: 'Built-in preview image', note: 'Can still show the original, uncropped photo after cropping.' },
  jpeg: { id: 'jpeg:trailing:picture', group: 'hidden', tier: 'red', label: 'Extra picture after the image', note: 'Could be an earlier or uncropped version of the picture.' },
  unknown: { id: 'jpeg:trailing:unknown', group: 'hidden', tier: 'red', label: 'Unknown data after the image' },
  padding: { id: 'jpeg:trailing:padding', group: 'technical', tier: 'green', label: 'Empty padding after the image' },
};

// Item ids inside a gain map that are part of the gain map itself, not metadata about the
// photo: its own gain map description, colour profile and basic headers.
const GAIN_MAP_OWN = new Set(['xmp:gainmap', 'icc:profile', 'jpeg:jfif', 'jpeg:adobe']);

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

  const mpfSeg = byKind('mpf')[0];
  if (mpfSeg) model.mpf = parseMpf(b, mpfSeg);
  const regions = !opts.embedded && w.eoiEnd > 0 ? classifyTrailing(b, w.eoiEnd, model.mpf, hints) : [];
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
    if (model.orientation === undefined) model.orientation = tiffOrientation(m);
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
  for (const r of regions) {
    const def = TRAILING[r.kind];
    if (!trailingItems.has(def.id)) trailingItems.set(def.id, { def: { ...def }, ranges: [], segs: [], couple: [], regions: [] });
    const t = trailingItems.get(def.id);
    t.ranges.push([r.start, r.end]);
    t.regions.push(r);
    if (r.kind === 'samsung' && r.hasVideo) t.def.label = 'Hidden video clip and Samsung extra data';
  }
  const mpfOwner = ['gainmap', 'mpf', 'preview'].map((k) => TRAILING[k].id).find((id) => trailingItems.has(id));
  const isoSegs = byKind('isogain');
  if (!opts.embedded && (mpfSeg || isoSegs.length)) {
    if (mpfOwner) trailingItems.get(mpfOwner).segs.push(...(mpfSeg ? [mpfSeg] : []), ...isoSegs);
    else {
      trailingItems.set('jpeg:mpf', {
        def: { id: 'jpeg:mpf', group: 'hidden', tier: 'amber', label: 'Extra embedded image, for example an HDR gain map', note: 'Only the index is present; the extra image itself was not found.' },
        ranges: [], segs: [...(mpfSeg ? [mpfSeg] : []), ...isoSegs], couple: [], regions: [],
      });
    }
  }
  const motionTier = trailingItems.has(TRAILING.video.id) ? 'red' : null;
  const gainTier = mpfOwner ? trailingItems.get(mpfOwner).def.tier : null;

  // XMP and Extended XMP
  const extSegs = byKind('xmpext');
  if (xmpSeg) {
    const parsed = parseXmp(xmpText);
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
    model.xmpPacket.items = addXmpItems(set, parsed, { motionTier, gainMapTier: gainTier, extended }, { kind: 'xmp' }, xmpSeg.end - xmpSeg.dataStart);
    model.xmpPacket.extSegs = extSegs;
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
      packet.items = addXmpItems(set, p, {}, { kind: 'xmp' }, seg.end - seg.dataStart);
      model.xmpPackets.push(packet);
    }
    if (xmpSegs.length > MAX_DETAILED) {
      const extra = xmpSegs.slice(MAX_DETAILED);
      set.add({ id: 'xmp:extra-copies', group: 'hidden', tier: 'red', label: 'More copies of XMP data', value: `${extra.length} more, ${formatBytes(extra.reduce((n, s) => n + s.end - s.start, 0))}`, source: 'XMP' }, { kind: 'segs', segs: extra });
    }
  } else if (extSegs.length) {
    set.add({ id: 'xmp:extended', group: 'hidden', tier: 'red', label: 'Extra XMP data', value: formatBytes(extSegs.reduce((n, s) => n + s.end - s.start, 0)), source: 'XMP' }, { kind: 'segs', segs: extSegs });
  }

  // ICC profile, possibly spread over several segments.
  const iccSegs = byKind('icc');
  if (iccSegs.length) {
    const chunks = iccSegs.map((s) => ({ seq: b[s.dataStart + 12], data: b.subarray(Math.min(s.end, s.dataStart + 14), s.end) })).sort((a, c) => a.seq - c.seq);
    const profile = concat(chunks.map((c) => c.data));
    set.add({ id: 'icc:profile', group: 'technical', tier: 'green', label: 'Colour profile', value: iccDescription(profile), source: 'ICC profile', note: 'Keeps colours accurate on different screens.' }, { kind: 'segs', segs: iccSegs });
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
    set.add({ id: 'jpeg:comment', group: 'hidden', tier: 'amber', label: 'Comment', value: texts.join(' / ').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'Empty comment', source: 'JPEG' }, { kind: 'segs', segs: com });
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
  // own item, so the gain map can stay while what it says about the photo goes.
  model.cleanable = [];
  for (const r of regions.filter((x) => x.kind === 'gainmap')) {
    const inner = embeddedMetadata(b.subarray(r.start, r.end));
    if (!inner) continue;
    model.cleanable.push(r);
    const id = set.add({ id: 'jpeg:trailing:gain-map:metadata', group: 'hidden', tier: inner.tier, label: 'Metadata inside the HDR gain map', value: inner.value, source: 'After the image', note: 'The gain map is a second, hidden picture with its own copy of details about the photo. Removing this keeps the gain map but clears those details.' }, { kind: 'clean', region: r });
    r.cleanId = id;
  }

  model.width = sof ? sof.width : 0;
  model.height = sof ? sof.height : 0;
  model.orientation = model.orientation || 1;
  return model;
}

// What an embedded JPEG (a gain map) says about the photo, beyond its own gain map data.
function embeddedMetadata(sub) {
  const inner = new ItemSet();
  try { analyseJpeg(sub, inner, { embedded: true }); } catch { return null; }
  const items = inner.items.filter((i) => !GAIN_MAP_OWN.has(i.id) && i.id !== 'jpeg:trailing:padding');
  if (!items.length) return null;
  const labels = [...new Set(items.map((i) => i.label))];
  const tier = strictest(items.map((i) => i.tier));
  return { tier, value: labels.length > 3 ? `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more` : labels.join(', ') };
}

// The same embedded JPEG with only what it needs to work as a gain map: its picture data,
// colour profile, the ISO gain map marker and the hdrgm description in XMP.
function cleanEmbedded(sub) {
  const w = walkJpeg(sub);
  if (!w || w.eoiEnd < 0) return null;
  const parts = [];
  for (const s of w.segs) {
    if (s.kind === 'junk' || s.kind === 'cut') continue;
    if (s.kind !== 'seg') { parts.push(sub.subarray(s.start, s.end)); continue; }
    const k = appKind(sub, s, w.sof);
    if (k === 'structural') { parts.push(sub.subarray(s.start, s.end)); continue; }
    if (k === 'icc' || k === 'isogain') { parts.push(sub.subarray(s.start, s.end)); continue; }
    if (k === 'jfif') {
      const head = sub.slice(s.dataStart, s.dataStart + 14);
      head[12] = 0; head[13] = 0;
      parts.push(makeSegment(0xe0, head));
      continue;
    }
    if (k === 'adobe') { parts.push(makeSegment(0xee, sub.subarray(s.dataStart, s.dataStart + 12))); continue; }
    if (k === 'xmp') {
      const parsed = parseXmp(new TextDecoder('utf-8').decode(sub.subarray(s.dataStart + XMP_ID.length, s.end)));
      const text = keepOnlyXmp(parsed, (p) => p.prefix === 'hdrgm' || p.prefix === 'HDRGainMap');
      const seg = text ? makeSegment(0xe1, concat([encodeLatin1(XMP_ID), encodeUtf8(text)])) : null;
      if (seg) parts.push(seg);
      continue;
    }
    if (k === 'marker') continue;
    // EXIF, IPTC, comments, Content Credentials, MPF and anything unidentified go.
  }
  return concat(parts);
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
    const id = set.add({ id: 'irb:other', group: 'hidden', tier: 'amber', label: 'Other Photoshop data', value: irbOtherValue(other), source: 'IPTC' }, { kind: 'irb', part: 'other' });
    model.irb.items.push(id);
  }
  if (irb.rest < payload.length && nonZero(payload, irb.rest, payload.length)) {
    const id = set.add({ id: 'irb:unreadable', group: 'hidden', tier: 'red', label: 'Photoshop data that could not be read', value: formatBytes(payload.length - irb.rest), source: 'IPTC', note: 'It may hold anything, so removing it is the safe choice.' }, { kind: 'irb', part: 'rest' });
    model.irb.items.push(id);
  }
}

// ======================================================================================
// Removal

export function scrubJpeg(b, model, set, remove) {
  const warnings = [];
  const out = b.slice();
  const drop = new Set();
  const replace = new Map();
  const cut = [];
  const clean = new Map();

  // Coupled removals: trailing media take their XMP descriptors with them.
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
      case 'clean':
        clean.set(it.region.start, it.region);
        break;
      default:
        break;
    }
  }

  for (const [s, keys] of exifKeys) {
    const tStart = s.dataStart + 6;
    const m = parseTiff(out.subarray(tStart, s.end));
    if (!m) continue;
    const res = removeTiffKeys(m, keys);
    if (res.empty) drop.add(s);
  }

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

  // XMP
  for (const { seg, parsed, items, extSegs } of model.xmpPackets) {
    const plan = planXmp(parsed, items, remove);
    if (plan.warning) warnings.push(plan.warning);
    const ext = items.find((i) => i.key === 'extended');
    if (plan.action === 'drop') {
      drop.add(seg);
      for (const s of extSegs) drop.add(s);
    } else {
      if (plan.action === 'rewrite') {
        const seg2 = makeSegment(0xe1, concat([encodeLatin1(XMP_ID), encodeUtf8(plan.text)]));
        if (seg2) replace.set(seg, seg2);
        else { drop.add(seg); warnings.push('The XMP data was too large to rewrite, so all of it was removed instead.'); }
      }
      if (ext && remove.has(ext.id)) for (const s of extSegs) drop.add(s);
    }
  }

  // Photoshop resources
  if (model.irb) {
    const { segs, irb, iptc, iptcRes, items } = model.irb;
    const gone = items.filter((id) => remove.has(id));
    if (gone.length) {
      if (gone.length === items.length) {
        for (const s of segs) drop.add(s);
      } else {
        const removeIptcKeys = new Set(gone.filter((id) => set.get(id).part === 'iptc').map((id) => set.get(id).key));
        const parts = new Set(gone.map((id) => set.get(id).part));
        const newIptc = iptc && removeIptcKeys.size ? rebuildIptc(iptc, removeIptcKeys) : null;
        const replaceMap = new Map();
        if (newIptc) replaceMap.set(iptcRes, newIptc);
        const keep = (r) => {
          if (r.id === IRB_IPTC) return !removeIptcKeys.size || !!newIptc;
          if (r.id === IRB_IPTC_DIGEST) return !removeIptcKeys.size;
          if (IRB_THUMBS.has(r.id)) return !parts.has('thumbs');
          if (r.id === IRB_XMP || IRB_EXIF.has(r.id)) return !parts.has('embedded');
          return !parts.has('other');
        };
        const data = rebuildIrb(irb, keep, replaceMap);
        const chunks = [];
        for (let p = 0; p < data.length; p += 65000) chunks.push(makeSegment(0xed, concat([encodeLatin1(PS_ID), data.subarray(p, p + 65000)])));
        segs.forEach((s, i) => { if (i === 0 && chunks.length) replace.set(s, concat(chunks)); else drop.add(s); });
        if (!data.length) drop.add(segs[0]);
      }
    }
  }

  // Keeping Content Credentials while changing anything else breaks their signature.
  if (model.c2paId && !remove.has(model.c2paId) && (drop.size || replace.size || cut.length || exifKeys.size || clean.size)) {
    warnings.push('Content Credentials were kept, but any change to the file makes their signature fail, so checkers will report the picture as altered.');
  }

  const asm = new Assembler(out);
  let lastWasSoi = false;
  for (const s of model.segs) {
    if (drop.has(s)) continue;
    // Stray bytes right after the start marker would stop the picture from opening.
    if (lastWasSoi && s.kind === 'junk') { warnings.push('Stray bytes at the start of the file were removed, because the picture would not open with them there.'); continue; }
    lastWasSoi = s.kind === 'soi';
    if (replace.has(s)) { asm.add(replace.get(s)); continue; }
    asm.copy(s.start, s.end);
  }

  // After the image: each region is cut, cleaned or copied as it is.
  const placed = new Map();
  const eoiEnd = model.w.eoiEnd;
  if (eoiEnd < 0) {
    const last = model.segs[model.segs.length - 1];
    if (last && last.end < out.length) asm.copy(last.end, out.length);
  } else {
    const isCut = (r) => cut.some(([s, e]) => s <= r.start && r.end <= e);
    let p = eoiEnd;
    for (const r of model.regions) {
      if (r.start > p) asm.copy(p, r.start);
      p = r.end;
      if (isCut(r)) continue;
      const at = asm.length;
      if (clean.has(r.start)) {
        const cleaned = cleanEmbedded(out.subarray(r.start, r.end));
        if (cleaned) { asm.add(cleaned); placed.set(r.contentStart ?? r.start, { at, len: cleaned.length }); continue; }
        warnings.push('The metadata inside the HDR gain map could not be cleared safely, so the gain map was removed instead.');
        continue;
      }
      asm.copy(r.start, r.end);
    }
    if (p < out.length) asm.copy(p, out.length);
  }
  // Nothing left after the start marker: end the file properly, so it is still a JPEG.
  if (asm.length === 2) asm.add(new Uint8Array([0xff, 0xd9]));
  const result = asm.finish();

  // Keep the MPF index pointing at the images it lists, with their new sizes.
  const mpfSeg = model.segs.find((s) => s.kindApp === 'mpf');
  if (model.mpf && mpfSeg && !drop.has(mpfSeg)) {
    const base = asm.map(model.mpf.base);
    const put = (pos, v) => {
      if (model.mpf.le) { result[pos] = v & 255; result[pos + 1] = (v >>> 8) & 255; result[pos + 2] = (v >>> 16) & 255; result[pos + 3] = v >>> 24; }
      else { result[pos] = v >>> 24; result[pos + 1] = (v >>> 16) & 255; result[pos + 2] = (v >>> 8) & 255; result[pos + 3] = v & 255; }
    };
    for (const e of model.mpf.entries) {
      const sizePos = asm.map(e.sizePos);
      const offPos = asm.map(e.offsetPos);
      if (base < 0 || sizePos < 0 || offPos < 0) continue;
      if (e.index === 0) {
        if (eoiEnd > 0) put(sizePos, asm.map(eoiEnd - 1) + 1);
        continue;
      }
      if (!e.size) continue;
      const cleaned = placed.get(model.mpf.base + e.offset);
      if (cleaned) { put(offPos, cleaned.at - base); put(sizePos, cleaned.len); continue; }
      const target = asm.map(model.mpf.base + e.offset);
      if (target < 0) { put(sizePos, 0); put(offPos, 0); continue; }
      put(offPos, target - base);
    }
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
