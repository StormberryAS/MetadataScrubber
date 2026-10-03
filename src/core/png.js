// PNG container.
//
// Walks the chunks and checks every CRC. Metadata lives in eXIf, the text chunks (tEXt,
// zTXt, iTXt; including XMP and ImageMagick's hex "Raw profile" blocks), tIME, the colour
// chunks, caBX (C2PA) and any private chunk. Critical chunks are never removed, and every
// chunk that is changed gets a fresh CRC.

import {
  Assembler, clip, concat, crc32, encodeLatin1, encodeUtf8, formatBytes, hexDecode, hexEncodeLines, inflate, latin1,
  startsWith, u16be, u32be, utf8, w32be, zlibStored,
} from './bytes.js?v=b373c219';
import { describeC2pa } from './c2pa.js?v=366e87df';
import { iccDescription } from './icc.js?v=1ac906b0';
import {
  IRB_EXIF, IRB_IPTC, IRB_IPTC_DIGEST, IRB_THUMBS, IRB_XMP, iptcItems, irbOtherValue, parseIptc, parseIrb, rebuildIptc, rebuildIrb,
} from './iptc.js?v=0c70531b';
import { UNREADABLE, cappedId } from './taxonomy.js?v=5970adfd';
import { TIFF_ITEMS, findTiffStart, keyForTagName, parseTiff, removeTiffKeys, tiffItems, tiffOrientation } from './tiff.js?v=262e0fe8';
import { addXmpItems, parseXmp, planXmp, xmpText } from './xmp.js?v=f2cbf417';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const STRUCTURAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'acTL', 'fcTL', 'fdAT']);
const COLOUR = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'mDCV', 'cLLI', 'mDCv', 'cLLi']);
const DISPLAY = new Set(['bKGD', 'sBIT', 'hIST', 'sPLT', 'oFFs', 'pCAL', 'sCAL']);

export function isPng(b) {
  return b.length >= 8 && SIGNATURE.every((v, i) => b[i] === v);
}

// Walks the chunks. A chunk with a damaged type name is still stepped over by its length
// (and offered for removal), so the chunks after it are read too. Where the file stops in
// the middle of a chunk, damagedStart marks the place.
export function walkPng(b) {
  const chunks = [];
  const warnings = [];
  let p = 8;
  let iendEnd = -1;
  let damagedStart = -1;
  let damagedType = '';
  let badCrc = 0;
  let badCrcType = '';
  while (p + 12 <= b.length) {
    const n = u32be(b, p);
    const type = latin1(b, p + 4, p + 8);
    if (p + 12 + n > b.length) { damagedStart = p; damagedType = type; break; }
    let c = { type, start: p, dataStart: p + 8, dataEnd: p + 8 + n, end: p + 12 + n, bad: !/^[A-Za-z]{4}$/.test(type) };
    c.crcOk = !c.bad && crc32(b, p + 4, p + 8 + n) === u32be(b, p + 8 + n);
    if (!c.bad && !c.crcOk) {
      badCrc++;
      badCrcType = type;
      // A damaged length can swallow the chunks after it. If an intact chunk starts inside
      // this one, the damaged chunk ends there and the walk goes on from it.
      const q = resync(b, c.dataStart, c.end);
      if (q > 0) c = { ...c, dataEnd: q - 4 >= c.dataStart ? q - 4 : q, end: q, resynced: true };
    }
    chunks.push(c);
    p = c.end;
    if (type === 'IEND') { iendEnd = p; break; }
  }
  if (iendEnd < 0 && damagedStart < 0 && p < b.length) damagedStart = p;
  if (damagedStart >= 0) warnings.push('The PNG file is damaged or cut short at the end.');
  if (chunks.some((c) => c.bad)) warnings.push('The PNG file has a part with a damaged name.');
  if (badCrc === 1) warnings.push(`The ${badCrcType} chunk has a wrong checksum.`);
  else if (badCrc > 1) warnings.push(`${badCrc} parts of the file have a wrong checksum.`);
  return { chunks, iendEnd, tailStart: p, damagedStart, damagedType, warnings };
}

const IEND = new Uint8Array([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

const isLetter = (x) => (x >= 0x41 && x <= 0x5a) || (x >= 0x61 && x <= 0x7a);

// The first position in [from, to) where a complete chunk starts that is either intact
// itself or followed by an intact chunk (so one damaged chunk cannot hide the next), or
// -1. Bounded, so a crafted file cannot make it slow.
function resync(b, from, to) {
  let checks = 0;
  let budget = 32 * 1024 * 1024;
  const header = (q) => q + 12 <= b.length && isLetter(b[q + 4]) && isLetter(b[q + 5]) && isLetter(b[q + 6]) && isLetter(b[q + 7]) && q + 12 + u32be(b, q) <= b.length;
  const intact = (q) => {
    const n = u32be(b, q);
    budget -= n + 4;
    checks++;
    return crc32(b, q + 4, q + 8 + n) === u32be(b, q + 8 + n);
  };
  const end = Math.min(to, b.length - 12, from + 16 * 1024 * 1024);
  for (let q = from; q <= end; q++) {
    if (!header(q)) continue;
    if (checks > 64 || budget < 0) return -1;
    if (intact(q)) return q;
    const next = q + 12 + u32be(b, q);
    if (header(next) && intact(next)) return q;
  }
  return -1;
}

export function makeChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  w32be(out, 0, data.length);
  out.set(encodeLatin1(type), 4);
  out.set(data, 8);
  w32be(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

// Decodes one text chunk: { keyword, text (string), bytes (raw text bytes), compressed, chunkType }.
async function readText(b, c) {
  const d = b.subarray(c.dataStart, c.dataEnd);
  let z = d.indexOf(0);
  if (z < 0) z = d.length;
  const keyword = latin1(d, 0, z);
  if (c.type === 'tEXt') {
    const raw = d.subarray(Math.min(z + 1, d.length));
    return { keyword, raw, text: latin1(raw), compressed: false };
  }
  if (c.type === 'zTXt') {
    const raw = await inflate(d.subarray(z + 2));
    return raw ? { keyword, raw, text: latin1(raw), compressed: true } : { keyword, raw: null, text: '', compressed: true };
  }
  // iTXt
  const flag = d[z + 1];
  let p = z + 3;
  const lang = d.indexOf(0, p);
  if (lang < 0) return { keyword, raw: null, text: '' };
  const trans = d.indexOf(0, lang + 1);
  if (trans < 0) return { keyword, raw: null, text: '' };
  p = trans + 1;
  const raw = flag ? await inflate(d.subarray(p)) : d.subarray(p);
  return raw ? { keyword, raw, text: utf8(raw), compressed: !!flag } : { keyword, raw: null, text: '', compressed: !!flag };
}

function textChunk(type, keyword, raw) {
  const key = encodeLatin1(keyword);
  if (type === 'tEXt') return makeChunk('tEXt', concat([key, new Uint8Array([0]), raw]));
  if (type === 'zTXt') return makeChunk('zTXt', concat([key, new Uint8Array([0, 0]), zlibStored(raw)]));
  return makeChunk('iTXt', concat([key, new Uint8Array([0, 0, 0, 0, 0]), raw]));
}

// ImageMagick raw profile: "\n<type>\n<length>\n<hex>\n".
function decodeRawProfile(text) {
  const m = /^\s*([^\n]*)\n\s*(\d+)\n([\s\S]*)$/.exec(text);
  if (!m) return null;
  const bytes = hexDecode(m[3]);
  if (bytes.length < +m[2]) return null;
  return { type: m[1].trim(), bytes: bytes.subarray(0, +m[2]) };
}

function encodeRawProfile(type, bytes) {
  return encodeLatin1(`\n${type}\n${String(bytes.length).padStart(8, ' ')}\n${hexEncodeLines(bytes)}\n`);
}

const TEXT_KEYS = {
  author: { id: 'png:author', group: 'who', tier: 'red', label: 'Author name' },
  artist: { id: 'png:author', group: 'who', tier: 'red', label: 'Author name' },
  copyright: { id: 'png:copyright', group: 'who', tier: 'red', label: 'Copyright notice', note: "Usually contains the photographer's name." },
  'creation time': { id: 'png:dates', group: 'when', tier: 'amber', label: 'Dates and times' },
  'date:create': { id: 'png:dates', group: 'when', tier: 'amber', label: 'Dates and times' },
  'date:modify': { id: 'png:dates', group: 'when', tier: 'amber', label: 'Dates and times' },
  'date:timestamp': { id: 'png:dates', group: 'when', tier: 'amber', label: 'Dates and times' },
  software: { id: 'png:software', group: 'device', tier: 'amber', label: 'Editing software' },
  source: { id: 'png:source', group: 'device', tier: 'amber', label: 'Device that made the picture' },
  comment: { id: 'png:comment', group: 'hidden', tier: 'amber', label: 'Comment' },
  description: { id: 'png:description', group: 'hidden', tier: 'amber', label: 'Description' },
  title: { id: 'png:title', group: 'hidden', tier: 'amber', label: 'Title' },
  disclaimer: { id: 'png:notes', group: 'hidden', tier: 'amber', label: 'Disclaimer and warning' },
  warning: { id: 'png:notes', group: 'hidden', tier: 'amber', label: 'Disclaimer and warning' },
};

// Text chunks with other keywords are judged by the keyword, so "Location" or "GPSLatitude"
// written by some tool is still recognised as a place.
function textKeyDef(lower) {
  if (TEXT_KEYS[lower]) return TEXT_KEYS[lower];
  if (/gps|latitude|longitude|altitude|geotag|coordinat/.test(lower)) return { id: 'png:gps', group: 'where', tier: 'red', label: 'GPS position' };
  if (/location|address|place|city|country|street|postal|province|landmark/.test(lower)) return { id: 'png:place', group: 'where', tier: 'red', label: 'Place names' };
  if (/serial/.test(lower)) return { id: 'png:serial', group: 'who', tier: 'red', label: 'Serial number' };
  if (/host ?computer|computer ?name|host ?name|machine ?name/.test(lower)) return { id: 'png:computer', group: 'who', tier: 'red', label: 'Computer name', note: "Often contains the owner's name." };
  if (/author|artist|owner|creator|by-?line|photographer|e-?mail|phone|contact|^names?$|^person|^people/.test(lower) && !/tool|software/.test(lower)) return { id: 'png:author', group: 'who', tier: 'red', label: 'Author name' };
  if (/uuid|guid|unique|document ?id|instance ?id|^id$/.test(lower)) return { id: 'png:ids', group: 'hidden', tier: 'red', label: 'Unique ID', note: 'Can link copies of the picture back to the original file.' };
  return null;
}

function gpsFromText(values) {
  const num = (v) => (v || '').split(',').map((x) => { const [a, c] = x.split('/').map(Number); return c ? a / c : a; });
  const dms = (v) => { const n = num(v); return n.length >= 1 && n.every(Number.isFinite) ? (n[0] || 0) + (n[1] || 0) / 60 + (n[2] || 0) / 3600 : null; };
  if (!values.GPSLatitude || !values.GPSLongitude) return '';
  const lat = dms(values.GPSLatitude);
  const lon = dms(values.GPSLongitude);
  if (lat === null || lon === null) return '';
  return `${lat.toFixed(4)} ${(values.GPSLatitudeRef || 'N').charAt(0)}, ${lon.toFixed(4)} ${(values.GPSLongitudeRef || 'E').charAt(0)}`;
}

export async function analysePng(b, set) {
  const w = walkPng(b);
  for (const x of w.warnings) set.warn(x);
  const model = { w, chunks: w.chunks, exif: [], xmp: [], irb: [], width: 0, height: 0, orientation: undefined };
  const ihdr = w.chunks.find((c) => c.type === 'IHDR');
  if (ihdr) { model.width = u32be(b, ihdr.dataStart); model.height = u32be(b, ihdr.dataStart + 4); }

  const groups = new Map();
  const group = (def, chunk, value) => {
    if (!groups.has(def.id)) groups.set(def.id, { def, chunks: [], values: [] });
    const g = groups.get(def.id);
    g.chunks.push(chunk);
    if (value) g.values.push(value);
  };
  const exifText = new Map();

  const addTiff = (m, internal) => {
    for (const x of m.warnings) set.warn(x);
    if (model.orientation === undefined) model.orientation = tiffOrientation(m);
    for (const it of tiffItems(m)) {
      const pub = { id: `exif:${it.key}`, group: it.group, tier: it.tier, label: it.label, value: it.value, source: 'EXIF' };
      if (it.note) pub.note = it.note;
      set.add(pub, { ...internal, key: it.key });
    }
  };
  const addIrb = (bytes, chunk, info, keyword, prof) => {
    const irb = parseIrb(bytes);
    const entry = { chunk, info, keyword, irb, bytes, prof, items: [] };
    model.irb.push(entry);
    const iptcRes = irb.res.find((r) => r.id === IRB_IPTC);
    if (iptcRes) {
      entry.iptc = parseIptc(bytes.subarray(iptcRes.dataStart, iptcRes.dataEnd));
      entry.iptcRes = iptcRes;
      for (const it of iptcItems(entry.iptc)) {
        const pub = { id: `iptc:${it.key}`, group: it.group, tier: it.tier, label: it.label, value: it.value, source: 'IPTC' };
        if (it.note) pub.note = it.note;
        entry.items.push(set.add(pub, { kind: 'irb', entry, part: 'iptc', key: it.key }));
      }
    }
    const thumbs = irb.res.filter((r) => IRB_THUMBS.has(r.id));
    if (thumbs.length) entry.items.push(set.add({ id: 'irb:thumbnail', group: 'hidden', tier: 'red', label: 'Built-in preview image', value: irbOtherValue(thumbs), source: 'IPTC', note: 'Can still show the original, uncropped photo after cropping.' }, { kind: 'irb', entry, part: 'thumbs' }));
    const embedded = irb.res.filter((r) => r.id === IRB_XMP || IRB_EXIF.has(r.id));
    if (embedded.length) entry.items.push(set.add({ id: 'irb:embedded', group: 'hidden', tier: 'red', label: 'Copy of EXIF or XMP inside Photoshop data', value: irbOtherValue(embedded), source: 'IPTC' }, { kind: 'irb', entry, part: 'embedded' }));
    const other = irb.res.filter((r) => r.id !== IRB_IPTC && r.id !== IRB_IPTC_DIGEST && !IRB_THUMBS.has(r.id) && r.id !== IRB_XMP && !IRB_EXIF.has(r.id));
    if (other.length) entry.items.push(set.add({ id: 'irb:other', group: 'hidden', tier: 'amber', label: 'Other Photoshop data', value: irbOtherValue(other), source: 'IPTC' }, { kind: 'irb', entry, part: 'other' }));
    if (irb.rest < bytes.length && bytes.subarray(irb.rest).some((x) => x)) entry.items.push(set.add({ id: 'irb:unreadable', group: 'hidden', tier: 'red', label: 'Photoshop data that could not be read', value: formatBytes(bytes.length - irb.rest), source: 'IPTC', note: 'It may hold anything, so removing it is the safe choice.' }, { kind: 'irb', entry, part: 'rest' }));
  };
  const addXmp = (text, chunk, info) => {
    const parsed = parseXmp(text);
    const entry = { chunk, parsed, info, items: [] };
    model.xmp.push(entry);
    entry.items = addXmpItems(set, parsed, {}, { kind: 'xmp', entry }, text.length);
  };

  const seenUnknown = new Set();
  const unknownChunk = (c, label) => {
    const slug = c.bad ? `x${Array.from(c.type, (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')}` : c.type.toLowerCase();
    const id = cappedId(seenUnknown, `png:chunk:${slug}`, 'png:chunk:other');
    group({ id, ...UNREADABLE.unknown, source: 'PNG' }, c, id === 'png:chunk:other' ? 'Several kinds' : label);
  };
  for (const c of w.chunks) {
    const t = c.type;
    if (c.bad) { unknownChunk(c, `Chunk with a damaged name, ${formatBytes(c.dataEnd - c.dataStart)}`); continue; }
    if (STRUCTURAL.has(t)) continue;
    if (COLOUR.has(t)) {
      const names = { sRGB: 'sRGB', gAMA: 'Gamma', cHRM: 'Colour primaries', cICP: 'Colour code points', mDCV: 'HDR display data', cLLI: 'HDR brightness data', mDCv: 'HDR display data', cLLi: 'HDR brightness data' };
      let value = t === 'iCCP' ? latin1(b, c.dataStart, b.indexOf(0, c.dataStart)) : names[t];
      if (t === 'iCCP') {
        const z = b.indexOf(0, c.dataStart);
        const prof = await inflate(b.subarray(z + 2, c.dataEnd));
        if (prof) value = iccDescription(prof);
      }
      group({ id: 'png:colour', group: 'technical', tier: 'green', label: 'Colour profile', note: 'Keeps colours accurate on different screens.' }, c, value);
      continue;
    }
    if (t === 'pHYs') {
      const ppu = u32be(b, c.dataStart);
      const unit = b[c.dataStart + 8];
      group({ id: 'png:phys', group: 'technical', tier: 'green', label: 'Print resolution' }, c, unit === 1 ? `${Math.round(ppu * 0.0254)} dpi` : 'Pixel shape only');
      continue;
    }
    if (DISPLAY.has(t)) {
      group({ id: 'png:display', group: 'technical', tier: 'green', label: 'Display hints', note: 'Background colour and similar hints for viewers.' }, c, t);
      continue;
    }
    if (t === 'tIME') {
      const d = c.dataStart;
      const v = `${u16be(b, d)}-${String(b[d + 2]).padStart(2, '0')}-${String(b[d + 3]).padStart(2, '0')} ${String(b[d + 4]).padStart(2, '0')}:${String(b[d + 5]).padStart(2, '0')}:${String(b[d + 6]).padStart(2, '0')}`;
      group({ id: 'png:time', group: 'when', tier: 'amber', label: 'Last modified time' }, c, v);
      continue;
    }
    if (t === 'eXIf') {
      const data = b.subarray(c.dataStart, c.dataEnd);
      const off = findTiffStart(data, 8);
      const m = off >= 0 ? parseTiff(data.subarray(off)) : null;
      if (!m || m.damaged) { group({ id: 'png:exif-unreadable', group: 'hidden', tier: 'red', label: 'EXIF data that could not be read', note: 'It may hold anything, so removing it is the safe choice.' }, c, formatBytes(data.length)); continue; }
      const entry = { chunk: c, off };
      model.exif.push(entry);
      addTiff(m, { kind: 'exif', entry });
      continue;
    }
    if (t === 'caBX') {
      const d = describeC2pa([b.subarray(c.dataStart, c.dataEnd)]);
      group({ id: 'png:c2pa', group: 'hidden', tier: d.tier, label: 'Content Credentials (C2PA)', note: d.note, source: 'C2PA' }, c, d.value);
      model.c2pa = true;
      continue;
    }
    if (t === 'tEXt' || t === 'zTXt' || t === 'iTXt') {
      const info = await readText(b, c);
      info.chunkType = t;
      const kw = info.keyword;
      const lower = kw.toLowerCase();
      if (info.raw === null) {
        group({ id: `png:text:${lower.replace(/[^a-z0-9]+/g, '-')}`, group: 'hidden', tier: 'red', label: `Text that could not be read: ${clip(kw, 40)}`, source: 'PNG text' }, c, formatBytes(c.dataEnd - c.dataStart));
        continue;
      }
      if (kw === 'XML:com.adobe.xmp') { addXmp(info.text, c, info); continue; }
      if (lower.startsWith('raw profile type ')) {
        const kind = lower.slice(17).trim();
        const prof = decodeRawProfile(info.text);
        if (prof && (kind === 'exif' || kind === 'app1')) {
          const off = findTiffStart(prof.bytes, 16);
          const m = off >= 0 ? parseTiff(prof.bytes.subarray(off)) : null;
          if (m && !m.damaged) {
            const entry = { chunk: c, info, prof, off };
            model.exif.push(entry);
            addTiff(m, { kind: 'rawexif', entry });
            continue;
          }
        }
        if (prof && (kind === 'iptc' || kind === '8bim')) {
          if (startsWith(prof.bytes, 0, '8BIM')) { addIrb(prof.bytes, c, info, kw, prof); continue; }
          const iptc = parseIptc(prof.bytes);
          if (iptc.sets.length) {
            const entry = { chunk: c, info, keyword: kw, prof, iptc, items: [] };
            model.irb.push(entry);
            for (const it of iptcItems(iptc)) {
              const pub = { id: `iptc:${it.key}`, group: it.group, tier: it.tier, label: it.label, value: it.value, source: 'IPTC' };
              if (it.note) pub.note = it.note;
              entry.items.push(set.add(pub, { kind: 'iptc', entry, key: it.key }));
            }
            continue;
          }
        }
        if (prof && kind === 'xmp') { addXmp(xmpText(prof.bytes), c, { ...info, rawProfile: prof }); continue; }
        if (prof && (kind === 'icc' || kind === 'icm')) {
          group({ id: 'png:colour', group: 'technical', tier: 'green', label: 'Colour profile', note: 'Keeps colours accurate on different screens.' }, c, iccDescription(prof.bytes));
          continue;
        }
        group({ id: `png:profile:${kind.replace(/[^a-z0-9]+/g, '-') || 'data'}`, group: 'hidden', tier: 'red', label: 'Unidentified extra data from the device or software', source: 'PNG text' }, c, `${kw}, ${formatBytes(prof ? prof.bytes.length : info.raw.length)}`);
        continue;
      }
      if (lower.startsWith('exif:')) {
        const name = kw.slice(5);
        const key = keyForTagName(name);
        if (!exifText.has(key)) exifText.set(key, { chunks: [], values: {} });
        exifText.get(key).chunks.push(c);
        exifText.get(key).values[name] = info.text;
        continue;
      }
      const def = textKeyDef(lower);
      if (def) { group(def, c, info.text); continue; }
      const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'text';
      group({ id: `png:text:${slug}`, group: 'hidden', tier: 'amber', label: `Text: ${clip(kw, 40)}`, source: 'PNG text' }, c, info.text);
      continue;
    }
    // An unknown chunk marked as essential stops picture programs from opening the file,
    // so removing it cannot break the picture; it is offered like any unknown chunk.
    unknownChunk(c, `${t} chunk, ${formatBytes(c.dataEnd - c.dataStart)}`);
  }

  // ImageMagick copies EXIF fields into plain text chunks named "exif:...".
  for (const [key, g] of exifText) {
    const def = TIFF_ITEMS[key] || TIFF_ITEMS.other;
    let value = key === 'gps' ? gpsFromText(g.values) : '';
    if (!value) value = clip(Object.entries(g.values).map(([k, v]) => `${k} ${v}`).join(', '));
    const pub = { id: `png:exif-text:${key}`, group: def.group, tier: def.tier, label: def.label, value, source: 'PNG text' };
    if (def.note) pub.note = def.note;
    set.add(pub, { kind: 'chunks', chunks: g.chunks });
  }
  for (const [id, g] of groups) {
    const def = g.def;
    const values = [...new Set(g.values.filter(Boolean))];
    const pub = { id, group: def.group, tier: def.tier, label: def.label, value: clip(values.join(', ') || def.label), source: def.source || (id === 'png:colour' && g.chunks.some((c) => c.type === 'iCCP') ? 'ICC profile' : 'PNG') };
    if (def.note) pub.note = def.note;
    if (def.source === undefined && /^png:(author|copyright|computer|dates|software|source|comment|description|title|notes|gps|place|serial|ids)$/.test(id)) pub.source = 'PNG text';
    set.add(pub, { kind: 'chunks', chunks: g.chunks });
  }
  const iend = w.chunks.find((c) => c.type === 'IEND');
  if (iend && iend.dataEnd > iend.dataStart) {
    set.add({ id: 'png:iend-data', group: 'hidden', tier: 'red', label: 'Data hidden in the end marker', value: formatBytes(iend.dataEnd - iend.dataStart), source: 'PNG', note: 'The end marker should be empty. Picture programs ignore what is in it.' }, { kind: 'iend' });
  }
  // A file cut short inside its picture data keeps what there is of the picture.
  if (w.damagedStart >= 0 && w.damagedType !== 'IDAT') {
    set.add({ id: 'png:damaged', ...UNREADABLE.damaged, value: formatBytes(b.length - w.damagedStart), source: 'PNG' }, { kind: 'damaged' });
  }
  if (w.iendEnd > 0 && w.iendEnd < b.length) {
    set.add({ id: 'png:trailing', group: 'hidden', tier: 'red', label: 'Unknown data after the image', value: formatBytes(b.length - w.iendEnd), source: 'After the image' }, { kind: 'trailing' });
  }
  model.orientation = model.orientation || 1;
  return model;
}

export async function scrubPng(b, model, set, remove) {
  const warnings = [];
  const out = b.slice();
  const drop = new Set();
  const replace = new Map();
  let cutTrailing = false;
  let cutDamaged = false;
  let cleanIend = false;

  const exifKeys = new Map();
  const irbRemovals = new Map();
  for (const id of remove) {
    const it = set.get(id);
    if (!it) continue;
    if (it.kind === 'chunks') for (const c of it.chunks) drop.add(c);
    else if (it.kind === 'trailing') cutTrailing = true;
    else if (it.kind === 'damaged') cutDamaged = true;
    else if (it.kind === 'iend') cleanIend = true;
    else if (it.kind === 'exif' || it.kind === 'rawexif') {
      if (!exifKeys.has(it.entry)) exifKeys.set(it.entry, { kind: it.kind, keys: new Set() });
      exifKeys.get(it.entry).keys.add(it.key);
    } else if (it.kind === 'irb' || it.kind === 'iptc') {
      if (!irbRemovals.has(it.entry)) irbRemovals.set(it.entry, []);
      irbRemovals.get(it.entry).push(id);
    }
  }

  for (const [entry, { kind, keys }] of exifKeys) {
    const c = entry.chunk;
    if (kind === 'exif') {
      const data = out.subarray(c.dataStart, c.dataEnd);
      const m = parseTiff(data.subarray(entry.off));
      const res = removeTiffKeys(m, keys);
      if (res.empty) drop.add(c);
      else replace.set(c, makeChunk('eXIf', out.slice(c.dataStart, c.dataEnd)));
    } else {
      const bytes = entry.prof.bytes.slice();
      const m = parseTiff(bytes.subarray(entry.off));
      const res = removeTiffKeys(m, keys);
      if (res.empty) drop.add(c);
      else replace.set(c, textChunk(entry.info.chunkType, entry.info.keyword, encodeRawProfile(entry.prof.type, bytes)));
    }
  }

  for (const entry of model.xmp) {
    const plan = planXmp(entry.parsed, entry.items, remove);
    if (plan.warning) warnings.push(plan.warning);
    if (plan.action === 'drop') drop.add(entry.chunk);
    else if (plan.action === 'rewrite') {
      const raw = encodeUtf8(plan.text);
      const info = entry.info;
      const data = info.rawProfile ? encodeRawProfile(info.rawProfile.type, raw) : raw;
      replace.set(entry.chunk, textChunk(info.rawProfile ? info.chunkType : 'iTXt', info.keyword, data));
    }
  }

  for (const [entry, ids] of irbRemovals) {
    if (ids.length === entry.items.length) { drop.add(entry.chunk); continue; }
    let bytes;
    if (entry.irb) {
      const parts = new Set(ids.map((id) => set.get(id).part));
      const removeIptc = new Set(ids.filter((id) => set.get(id).part === 'iptc').map((id) => set.get(id).key));
      const newIptc = entry.iptc && removeIptc.size ? rebuildIptc(entry.iptc, removeIptc) : null;
      const repl = new Map();
      if (newIptc) repl.set(entry.iptcRes, newIptc);
      bytes = rebuildIrb(entry.irb, (r) => {
        if (r.id === IRB_IPTC) return !removeIptc.size || !!newIptc;
        if (r.id === IRB_IPTC_DIGEST) return !removeIptc.size;
        if (IRB_THUMBS.has(r.id)) return !parts.has('thumbs');
        if (r.id === IRB_XMP || IRB_EXIF.has(r.id)) return !parts.has('embedded');
        return !parts.has('other');
      }, repl);
    } else {
      bytes = rebuildIptc(entry.iptc, new Set(ids.map((id) => set.get(id).key)));
    }
    if (!bytes || !bytes.length) { drop.add(entry.chunk); continue; }
    const kind = entry.prof ? entry.prof.type : entry.irb ? '8bim' : 'iptc';
    replace.set(entry.chunk, textChunk(entry.info.chunkType, entry.info.keyword || entry.keyword, encodeRawProfile(kind, bytes)));
  }

  if (model.c2pa && !remove.has('png:c2pa') && (drop.size || replace.size || cutTrailing || cutDamaged || cleanIend)) {
    warnings.push('Content Credentials were kept, but any change to the file makes their signature fail, so checkers will report the picture as altered.');
  }

  const asm = new Assembler(out);
  asm.copy(0, 8);
  for (const c of model.chunks) {
    if (drop.has(c) && (c.bad || !STRUCTURAL.has(c.type))) continue;
    if (c.type === 'IEND' && cleanIend) { asm.add(IEND); continue; }
    if (replace.has(c)) { asm.add(replace.get(c)); continue; }
    asm.copy(c.start, c.end);
  }
  if (model.w.iendEnd > 0) {
    if (!cutTrailing && model.w.iendEnd < out.length) asm.copy(model.w.iendEnd, out.length);
  } else if (model.w.damagedStart >= 0) {
    if (!cutDamaged) asm.copy(model.w.damagedStart, out.length);
    else if (model.chunks.some((c) => c.type === 'IDAT')) {
      asm.add(IEND);
      warnings.push('The file was cut short. The damaged end was removed and a proper end marker added.');
    }
  }
  return { bytes: asm.finish(), warnings };
}

export function insertPngExif(b, tiff) {
  const w = walkPng(b);
  const asm = new Assembler(b);
  asm.copy(0, 8);
  let inserted = false;
  for (const c of w.chunks) {
    if (c.type === 'eXIf') continue;
    if (!inserted && c.type === 'IDAT') { asm.add(makeChunk('eXIf', tiff)); inserted = true; }
    asm.copy(c.start, c.end);
  }
  if (!inserted) throw new Error('The PNG file has no picture data');
  const tail = w.iendEnd > 0 ? w.iendEnd : w.tailStart;
  if (tail < b.length) asm.copy(tail, b.length);
  return asm.finish();
}

// Synchronous lookup of the first EXIF block, for buildExif. Compressed raw profiles need an
// asynchronous inflate, so only eXIf and uncompressed raw profiles are read here.
export function firstPngTiff(b) {
  const w = walkPng(b);
  for (const c of w.chunks) {
    if (c.type === 'eXIf') {
      const data = b.subarray(c.dataStart, c.dataEnd);
      const off = findTiffStart(data, 8);
      if (off >= 0) return data.subarray(off);
    }
    if (c.type === 'tEXt' || c.type === 'iTXt') {
      const d = b.subarray(c.dataStart, c.dataEnd);
      const z = d.indexOf(0);
      const kw = latin1(d, 0, z < 0 ? 0 : z).toLowerCase();
      if (kw !== 'raw profile type exif' && kw !== 'raw profile type app1') continue;
      let p = z + 1;
      if (c.type === 'iTXt') {
        if (d[z + 1]) continue;
        const lang = d.indexOf(0, z + 3);
        const trans = lang < 0 ? -1 : d.indexOf(0, lang + 1);
        if (trans < 0) continue;
        p = trans + 1;
      }
      const prof = decodeRawProfile(latin1(d, p));
      if (!prof) continue;
      const off = findTiffStart(prof.bytes, 16);
      if (off >= 0) return prof.bytes.subarray(off);
    }
  }
  return null;
}
