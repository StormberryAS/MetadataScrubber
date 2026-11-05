/*! src/core/png.js is compiled from ts/src/core/png.ts by tools/build-ts.sh, which leaves out
    every comment but this one: the explanations are in the source. Edit the TypeScript, never the
    .js: the build refuses to overwrite a hand edit, and its check mode fails on one. */

// PNG container.
//
// Walks the chunks and checks every CRC. Metadata lives in eXIf, the text chunks (tEXt,
// zTXt, iTXt; including XMP and ImageMagick's hex "Raw profile" blocks), tIME, the colour
// chunks, caBX (C2PA) and any private chunk. Critical chunks are never removed, and every
// chunk that is changed gets a fresh CRC.

import {
  Assembler, clip, concat, crc32, encodeLatin1, encodeUtf8, formatBytes, hexDecode, hexEncodeLines, inflate, latin1,
  startsWith, u16be, u32be, utf8, w32be, zlibStored,
} from './bytes.js';
import { describeC2pa } from './c2pa.js';
import { ICC_TEXT_ITEM, ICC_UNREADABLE_ITEM, cleanIcc, iccDescription, iccFreeText, iccNameAllowed, inspectIcc } from './icc.js';
import {
  IRB_EXIF, IRB_IPTC, IRB_IPTC_DIGEST, IRB_OTHER_NOTE, IRB_THUMBS, IRB_XMP, canonicalIrb, iptcItems, irbOtherValue, parseIptc, parseIrb, rebuildIptc,
} from './iptc.js';
import type { IrbResource, ParsedIptc, ParsedIrb } from './iptc.js';
import { UNREADABLE, cappedId } from './taxonomy.js';
import type { ItemInternal, ItemSet, ItemSpec, Tier } from './taxonomy.js';
import {
  TIFF_ITEMS, amberTextOk, deviceNameOk, findTiffStart, isAmberTextKey, keyForTagName, parseTiff, removeTiffKeys, tagNameOf, technicalTextOk, tiffItems, tiffOrientation,
} from './tiff.js';
import { addXmpItems, canonicalXmp, parseXmp, planXmp, xmpText } from './xmp.js';

export type TiffModel = NonNullable<ReturnType<typeof parseTiff>>;
/**
 * One chunk. `bad` marks a damaged type name, `resynced` a chunk cut short where an
 * intact chunk was found inside it.
 */
export interface PngChunk {
  type: string;
  start: number;
  dataStart: number;
  dataEnd: number;
  end: number;
  bad: boolean;
  crcOk?: boolean;
  resynced?: boolean;
}
export interface PngWalk {
  chunks: PngChunk[];
  iendEnd: number;
  tailStart: number;
  damagedStart: number;
  damagedType: string;
  warnings: string[];
}
/** An ImageMagick raw profile. */
export type RawProfile = { type: string; bytes: Uint8Array };
/** A decoded text chunk; raw is null when it could not be read. */
export interface PngText {
  keyword: string;
  raw: Uint8Array | null;
  text: string;
  compressed?: boolean;
  chunkType?: string;
  rawProfile?: RawProfile;
}
/** An EXIF block: an eXIf chunk, or a raw profile (with info and prof). */
export type PngExifEntry = { chunk: PngChunk; off: number; info?: PngText; prof?: RawProfile };
export type PngXmpEntry = { chunk: PngChunk; parsed: ReturnType<typeof parseXmp>; info: PngText; items: ReturnType<typeof addXmpItems> };
/** Photoshop data (irb set) or a bare IPTC block (irb unset) in a raw profile. */
export interface PngIrbEntry {
  chunk: PngChunk;
  info: PngText;
  keyword: string;
  prof: RawProfile;
  items: string[];
  irb?: ParsedIrb;
  bytes?: Uint8Array;
  iptc?: ParsedIptc;
  iptcRes?: IrbResource;
}
export interface PngModel {
  w: PngWalk;
  chunks: PngChunk[];
  exif: PngExifEntry[];
  xmp: PngXmpEntry[];
  irb: PngIrbEntry[];
  /** chunks written in their canonical form when they stay */
  canon: Map<PngChunk, Uint8Array>;
  width: number;
  height: number;
  orientation: number | undefined;
  c2pa?: boolean;
}
/** A detail chunks are grouped under. */
export type PngDef = { id: string; group: string; tier: Tier; label: string; note?: string; source?: string };
/** Where a colour profile came from: an iCCP chunk (name) or a raw profile (raw). */
export type ProfileWhere = { name?: string | null; raw?: { info: PngText; type: string } };
/** The removal data this module stores with each item. */
export type PngInternal = { kind: 'chunks'; chunks: PngChunk[] }
  | { kind: 'trailing' | 'damaged' | 'iend' }
  | ({ kind: 'icctext'; chunk: PngChunk; prof: Uint8Array } & ProfileWhere)
  | { kind: 'exif' | 'rawexif'; entry: PngExifEntry; key: string }
  | { kind: 'irb'; entry: PngIrbEntry; part: string; key?: string }
  | { kind: 'iptc'; entry: PngIrbEntry; key: string }
  | { kind: 'xmp'; entry: PngXmpEntry };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const STRUCTURAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'acTL', 'fcTL', 'fdAT']);
const COLOUR = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'mDCV', 'cLLI', 'mDCv', 'cLLi']);
const DISPLAY = new Set(['bKGD', 'sBIT', 'hIST', 'sPLT', 'oFFs', 'pCAL', 'sCAL']);
// Green chunks are kept by default, so each must have the size and form the PNG
// specification (third edition) gives it; anything else may carry text and is red. sPLT
// and pCAL hold a free-text name (and pCAL a unit), so they are never green.
const GREEN_TECH_KEYS = new Set(['orientation', 'resolution', 'colour', 'dimensions', 'exposure', 'format']);
const NUM_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
function greenChunkOk(b: Uint8Array, c: PngChunk): boolean {
  const n = c.dataEnd - c.dataStart;
  const d = c.dataStart;
  switch (c.type) {
    case 'sRGB': return n === 1 && b[d] <= 3;
    case 'gAMA': return n === 4;
    case 'cHRM': return n === 32;
    case 'cICP': return n === 4;
    case 'mDCV': case 'mDCv': return n === 24;
    case 'cLLI': case 'cLLi': return n === 8;
    case 'pHYs': return n === 9 && b[d + 8] <= 1;
    case 'bKGD': return n === 1 || n === 2 || n === 6;
    case 'sBIT': return n >= 1 && n <= 4;
    case 'hIST': return n % 2 === 0 && n <= 512;
    case 'oFFs': return n === 9 && b[d + 8] <= 1;
    case 'sCAL': {
      const parts = latin1(b, d + 1, c.dataEnd).split('\0');
      return (b[d] === 1 || b[d] === 2) && parts.length === 2 && parts.every((x) => NUM_TEXT.test(x) && x.length <= 32);
    }
    default: return false;
  }
}

export function isPng(b: Uint8Array): boolean {
  return b.length >= 8 && SIGNATURE.every((v, i) => b[i] === v);
}

// Walks the chunks. A chunk with a damaged type name is still stepped over by its length
// (and offered for removal), so the chunks after it are read too. Where the file stops in
// the middle of a chunk, damagedStart marks the place.
export function walkPng(b: Uint8Array): PngWalk {
  const chunks: PngChunk[] = [];
  const warnings: string[] = [];
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
    let c: PngChunk = { type, start: p, dataStart: p + 8, dataEnd: p + 8 + n, end: p + 12 + n, bad: !/^[A-Za-z]{4}$/.test(type) };
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

const isLetter = (x: number) => (x >= 0x41 && x <= 0x5a) || (x >= 0x61 && x <= 0x7a);

// The first position in [from, to) where a complete chunk starts that is either intact
// itself or followed by an intact chunk (so one damaged chunk cannot hide the next), or
// -1. Bounded, so a crafted file cannot make it slow.
function resync(b: Uint8Array, from: number, to: number): number {
  let checks = 0;
  let budget = 32 * 1024 * 1024;
  const header = (q: number) => q + 12 <= b.length && isLetter(b[q + 4]) && isLetter(b[q + 5]) && isLetter(b[q + 6]) && isLetter(b[q + 7]) && q + 12 + u32be(b, q) <= b.length;
  const intact = (q: number) => {
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

export function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  w32be(out, 0, data.length);
  out.set(encodeLatin1(type), 4);
  out.set(data, 8);
  w32be(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

// Decodes one text chunk: { keyword, text (string), bytes (raw text bytes), compressed, chunkType }.
async function readText(b: Uint8Array, c: PngChunk): Promise<PngText> {
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

function textChunk(type: string, keyword: string, raw: Uint8Array): Uint8Array {
  const key = encodeLatin1(keyword);
  if (type === 'tEXt') return makeChunk('tEXt', concat([key, new Uint8Array([0]), raw]));
  if (type === 'zTXt') return makeChunk('zTXt', concat([key, new Uint8Array([0, 0]), zlibStored(raw)]));
  return makeChunk('iTXt', concat([key, new Uint8Array([0, 0, 0, 0, 0]), raw]));
}

const sameBytes: (x: Uint8Array, y: Uint8Array) => boolean = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

// ImageMagick's raw profiles, written in one canonical form whatever the file used: a zTXt
// chunk (stored, so nothing in how it was compressed survives) under the keyword
// "Raw profile type <kind>", holding the header lines and the hexadecimal data as
// encodeRawProfile writes them.
function rawProfileChunk(kind: string, bytes: Uint8Array): Uint8Array {
  return textChunk('zTXt', `Raw profile type ${kind}`, encodeRawProfile(kind, bytes));
}
const EXIF_HEAD = encodeLatin1('Exif\0\0');

// The chunk an XMP packet is written to: an uncompressed iTXt with no language and its
// fixed keyword, or, for ImageMagick's raw profile, a canonical raw profile.
function xmpChunk(info: PngText, text: string): Uint8Array {
  const raw = encodeUtf8(text);
  return info.rawProfile ? rawProfileChunk('xmp', raw) : textChunk('iTXt', 'XML:com.adobe.xmp', raw);
}

// Date and device text (amber, kept by default since 0.0.3) stays only with a value of the
// form its keyword gives, and only in one canonical form: a fresh tEXt chunk under the
// keyword's usual spelling. Nothing of the chunk it came in survives: no language tag or
// translated keyword (iTXt), no compression choices, no spelling of the keyword. A value
// that is not a date, or not one short line of printable text, is the red 'device-text'
// detail instead.
const ISO_DATE = /^\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:?\d\d)?)?$/;
const EXIF_STYLE_DATE = /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/;
const RFC1123_DATE = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), )?\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d\d:\d\d(?::\d\d)? (?:GMT|UTC|UT|Z|[+-]\d{4})$/;
const pngDateOk = (v: string) => ISO_DATE.test(v) || EXIF_STYLE_DATE.test(v) || RFC1123_DATE.test(v);
const latin1Line = (v: string) => v.length <= 64 && /^[\x20-\x7e\xa0-\xff]*$/.test(v);
const AMBER_TEXT: Record<'creation time' | 'date:create' | 'date:modify' | 'date:timestamp' | 'software' | 'source', [string, (v: string) => boolean]> = {
  'creation time': ['Creation Time', pngDateOk],
  'date:create': ['date:create', pngDateOk],
  'date:modify': ['date:modify', pngDateOk],
  'date:timestamp': ['date:timestamp', pngDateOk],
  software: ['Software', deviceNameOk],
  source: ['Source', deviceNameOk],
};
const textOnly: (keyword: string, value: string) => Uint8Array = (keyword, value) => makeChunk('tEXt', concat([encodeLatin1(keyword), new Uint8Array([0]), encodeLatin1(value)]));
const DEVICE_TEXT: PngDef = { id: 'png:device-text', ...TIFF_ITEMS['device-text'], source: 'PNG text' };

// ImageMagick raw profile: "\n<type>\n<length>\n<hex>\n".
function decodeRawProfile(text: string): RawProfile | null {
  const m = /^\s*([^\n]*)\n\s*(\d+)\n([\s\S]*)$/.exec(text);
  if (!m) return null;
  const bytes = hexDecode(m[3]);
  if (bytes.length < +m[2]) return null;
  return { type: m[1].trim(), bytes: bytes.subarray(0, +m[2]) };
}

function encodeRawProfile(type: string, bytes: Uint8Array): Uint8Array {
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
  // Free text can name people, so it is red (0.0.3).
  comment: { id: 'png:comment', group: 'hidden', tier: 'red', label: 'Comment', note: 'Free text written by a person or an app. It can hold names, places or notes.' },
  description: { id: 'png:description', group: 'hidden', tier: 'red', label: 'Description', note: 'Free text written by a person or an app. It can hold names, places or notes.' },
  title: { id: 'png:title', group: 'hidden', tier: 'red', label: 'Title', note: 'Free text written by a person or an app. It can hold names, places or notes.' },
  disclaimer: { id: 'png:notes', group: 'hidden', tier: 'red', label: 'Disclaimer and warning', note: 'Free text written by a person or an app. It can hold names, places or notes.' },
  warning: { id: 'png:notes', group: 'hidden', tier: 'red', label: 'Disclaimer and warning', note: 'Free text written by a person or an app. It can hold names, places or notes.' },
} satisfies Record<string, PngDef>;

// Text chunks with other keywords are judged by the keyword, so "Location" or "GPSLatitude"
// written by some tool is still recognised as a place.
function textKeyDef(lower: string): PngDef | null {
  // Own keys only: a keyword such as `constructor` must not find what every object inherits.
  if (Object.hasOwn(TEXT_KEYS, lower)) return TEXT_KEYS[lower as keyof typeof TEXT_KEYS];
  if (/gps|latitude|longitude|altitude|geotag|coordinat/.test(lower)) return { id: 'png:gps', group: 'where', tier: 'red', label: 'GPS position' };
  if (/location|address|place|city|country|street|postal|province|landmark/.test(lower)) return { id: 'png:place', group: 'where', tier: 'red', label: 'Place names' };
  if (/serial/.test(lower)) return { id: 'png:serial', group: 'who', tier: 'red', label: 'Serial number' };
  if (/host ?computer|computer ?name|host ?name|machine ?name/.test(lower)) return { id: 'png:computer', group: 'who', tier: 'red', label: 'Computer name', note: "Often contains the owner's name." };
  if (/author|artist|owner|creator|by-?line|photographer|e-?mail|phone|contact|^names?$|^person|^people/.test(lower) && !/tool|software/.test(lower)) return { id: 'png:author', group: 'who', tier: 'red', label: 'Author name' };
  if (/uuid|guid|unique|document ?id|instance ?id|^id$/.test(lower)) return { id: 'png:ids', group: 'hidden', tier: 'red', label: 'Unique ID', note: 'Can link copies of the picture back to the original file.' };
  return null;
}

function gpsFromText(values: Record<string, string>): string {
  const num = (v: string | undefined) => (v || '').split(',').map((x) => { const [a, c] = x.split('/').map(Number); return c ? a / c : a; });
  const dms = (v: string | undefined) => { const n = num(v); return n.length >= 1 && n.every(Number.isFinite) ? (n[0] || 0) + (n[1] || 0) / 60 + (n[2] || 0) / 3600 : null; };
  if (!values.GPSLatitude || !values.GPSLongitude) return '';
  const lat = dms(values.GPSLatitude);
  const lon = dms(values.GPSLongitude);
  if (lat === null || lon === null) return '';
  return `${lat.toFixed(4)} ${(values.GPSLatitudeRef || 'N').charAt(0)}, ${lon.toFixed(4)} ${(values.GPSLongitudeRef || 'E').charAt(0)}`;
}

export async function analysePng(b: Uint8Array, set: ItemSet): Promise<PngModel & { orientation: number }> {
  const w = walkPng(b);
  for (const x of w.warnings) set.warn(x);
  // canon: chunks that, when they stay, are written in their canonical form instead.
  const model: PngModel = { w, chunks: w.chunks, exif: [], xmp: [], irb: [], canon: new Map(), width: 0, height: 0, orientation: undefined };
  const canonical = (c: PngChunk, bytes: Uint8Array) => {
    model.canon.set(c, bytes);
    if (!sameBytes(bytes, b.subarray(c.start, c.end))) set.normalise = true;
  };
  const ihdr = w.chunks.find((c) => c.type === 'IHDR');
  if (ihdr) { model.width = u32be(b, ihdr.dataStart); model.height = u32be(b, ihdr.dataStart + 4); }

  const groups: Map<string, { def: PngDef; chunks: PngChunk[]; values: string[] }> = new Map();
  const group = (def: PngDef, chunk: PngChunk, value: string | null | undefined) => {
    if (!groups.has(def.id)) groups.set(def.id, { def, chunks: [], values: [] });
    const g = (groups.get(def.id) as { def: PngDef; chunks: PngChunk[]; values: string[] });
    g.chunks.push(chunk);
    if (value) g.values.push(value);
  };
  const exifText: Map<string, { chunks: PngChunk[]; values: Record<string, string> }> = new Map();

  const addTiff = (m: TiffModel, internal: { kind: 'exif' | 'rawexif'; entry: PngExifEntry }) => {
    for (const x of m.warnings) set.warn(x);
    if (model.orientation === undefined) model.orientation = tiffOrientation(m);
    for (const it of tiffItems(m)) {
      const pub: ItemSpec = { id: `exif:${it.key}`, group: it.group, tier: it.tier, label: it.label, value: it.value, source: 'EXIF' };
      if (it.note) pub.note = it.note;
      set.add(pub, { ...internal, key: it.key });
    }
  };
  const addIrb = (bytes: Uint8Array, chunk: PngChunk, info: PngText, keyword: string, prof: RawProfile) => {
    const irb = parseIrb(bytes);
    const entry: PngIrbEntry = { chunk, info, keyword, irb, bytes, prof, items: [] };
    model.irb.push(entry);
    const iptcRes = irb.res.find((r) => r.id === IRB_IPTC);
    if (iptcRes) {
      entry.iptc = parseIptc(bytes.subarray(iptcRes.dataStart, iptcRes.dataEnd));
      entry.iptcRes = iptcRes;
      for (const it of iptcItems(entry.iptc)) {
        const pub: ItemSpec = { id: `iptc:${it.key}`, group: it.group, tier: it.tier, label: it.label, value: it.value, source: 'IPTC' };
        if (it.note) pub.note = it.note;
        entry.items.push(set.add(pub, { kind: 'irb', entry, part: 'iptc', key: it.key }));
      }
    }
    const thumbs = irb.res.filter((r) => IRB_THUMBS.has(r.id));
    if (thumbs.length) entry.items.push(set.add({ id: 'irb:thumbnail', group: 'hidden', tier: 'red', label: 'Built-in preview image', value: irbOtherValue(thumbs), source: 'IPTC', note: 'Can still show the original, uncropped photo after cropping.' }, { kind: 'irb', entry, part: 'thumbs' }));
    const embedded = irb.res.filter((r) => r.id === IRB_XMP || IRB_EXIF.has(r.id));
    if (embedded.length) entry.items.push(set.add({ id: 'irb:embedded', group: 'hidden', tier: 'red', label: 'Copy of EXIF or XMP inside Photoshop data', value: irbOtherValue(embedded), source: 'IPTC' }, { kind: 'irb', entry, part: 'embedded' }));
    const other = irb.res.filter((r) => r.id !== IRB_IPTC && r.id !== IRB_IPTC_DIGEST && !IRB_THUMBS.has(r.id) && r.id !== IRB_XMP && !IRB_EXIF.has(r.id));
    if (other.length) entry.items.push(set.add({ id: 'irb:other', group: 'hidden', tier: 'red', label: 'Other Photoshop data', value: irbOtherValue(other), source: 'IPTC', note: IRB_OTHER_NOTE }, { kind: 'irb', entry, part: 'other' }));
    if (irb.rest < bytes.length && bytes.subarray(irb.rest).some((x) => x)) entry.items.push(set.add({ id: 'irb:unreadable', group: 'hidden', tier: 'red', label: 'Photoshop data that could not be read', value: formatBytes(bytes.length - irb.rest), source: 'IPTC', note: 'It may hold anything, so removing it is the safe choice.' }, { kind: 'irb', entry, part: 'rest' }));
    // The block only stays in the canonical form (canonicalIrb in iptc.js).
    const canon = canonicalIrb(irb, entry.iptc, entry.iptcRes);
    if (!canon.length || !sameBytes(rawProfileChunk('8bim', canon), b.subarray(chunk.start, chunk.end))) set.normalise = true;
  };
  const addXmp = (text: string, chunk: PngChunk, info: PngText) => {
    const parsed = parseXmp(text);
    const entry: PngXmpEntry = { chunk, parsed, info, items: [] };
    model.xmp.push(entry);
    // The packet stays only in the canonical form, in a chunk written as xmpChunk writes
    // it; a chunk already exactly so leaves the file as it is.
    const before = !!set.normalise;
    entry.items = addXmpItems(set, parsed, {}, { kind: 'xmp', entry }, text.length);
    const canon = canonicalXmp(parsed);
    const same = canon !== null && sameBytes(xmpChunk(info, canon), b.subarray(chunk.start, chunk.end));
    set.normalise = before || !same;
  };

  // A colour profile: false when it cannot be read (then it is offered whole, as red),
  // else true, after offering any unlisted text in it, or an unlisted iCCP name.
  const colourProfile = (c: PngChunk, prof: Uint8Array | null, where: ProfileWhere): boolean => {
    const info = ((prof ? inspectIcc(prof) : { ok: false }) as ReturnType<typeof inspectIcc>);
    if (!info.ok) {
      set.add({ ...ICC_UNREADABLE_ITEM, value: formatBytes(c.dataEnd - c.dataStart) }, { kind: 'chunks', chunks: [c] });
      return false;
    }
    // A readable iCCP profile always has its name read (see the iCCP branch below).
    const badName = where.name !== undefined && !iccNameAllowed(where.name as string);
    if (!info.clean || badName) {
      const value = [badName ? `profile name: ${where.name}` : '', info.clean ? '' : iccFreeText(info)].filter(Boolean).join('; ');
      set.add({ ...ICC_TEXT_ITEM, value: clip(value) }, { kind: 'icctext', chunk: c, prof, ...where });
    }
    return true;
  };

  const seenUnknown: Set<string> = new Set();
  const unknownChunk = (c: PngChunk, label: string) => {
    const slug = c.bad ? `x${Array.from(c.type, (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')}` : c.type.toLowerCase();
    const id = cappedId(seenUnknown, `png:chunk:${slug}`, 'png:chunk:other');
    group({ id, ...UNREADABLE.unknown, source: 'PNG' }, c, id === 'png:chunk:other' ? 'Several kinds' : label);
  };
  for (const c of w.chunks) {
    const t = c.type;
    if (c.bad) { unknownChunk(c, `Chunk with a damaged name, ${formatBytes(c.dataEnd - c.dataStart)}`); continue; }
    if (STRUCTURAL.has(t)) continue;
    if ((COLOUR.has(t) || DISPLAY.has(t) || t === 'pHYs') && t !== 'iCCP' && !greenChunkOk(b, c)) {
      group({ id: 'png:technical-text', ...TIFF_ITEMS['technical-text'], source: 'PNG' }, c, `${t} chunk, ${formatBytes(c.dataEnd - c.dataStart)}`);
      continue;
    }
    if (COLOUR.has(t)) {
      const names: Record<string, string> = { sRGB: 'sRGB', gAMA: 'Gamma', cHRM: 'Colour primaries', cICP: 'Colour code points', mDCV: 'HDR display data', cLLI: 'HDR brightness data', mDCv: 'HDR display data', cLLi: 'HDR brightness data' };
      let value = names[t];
      if (t === 'iCCP') {
        const z = b.indexOf(0, c.dataStart);
        const name = z > c.dataStart && z < c.dataEnd ? latin1(b, c.dataStart, z) : null;
        const prof = name !== null && b[z + 1] === 0 ? await inflate(b.subarray(z + 2, c.dataEnd)) : null;
        // The profile and its name are checked like any colour profile: unreadable is red
        // as a whole, and text that is not a known name is a red detail of its own.
        if (!colourProfile(c, prof, { name })) continue;
        value = iccDescription(prof as Uint8Array);
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
      // Seven bytes, each field in its range (PNG third edition, 11.3.6.1); anything else
      // holds data of a kind a time does not have.
      const ok = c.dataEnd - c.dataStart === 7 && b[d + 2] >= 1 && b[d + 2] <= 12 && b[d + 3] >= 1 && b[d + 3] <= 31 && b[d + 4] <= 23 && b[d + 5] <= 59 && b[d + 6] <= 60;
      if (ok) group({ id: 'png:time', group: 'when', tier: 'amber', label: 'Last modified time' }, c, v);
      else group(DEVICE_TEXT, c, `tIME chunk, ${formatBytes(c.dataEnd - c.dataStart)}`);
      continue;
    }
    if (t === 'eXIf') {
      const data = b.subarray(c.dataStart, c.dataEnd);
      const off = findTiffStart(data, 8);
      const m = off >= 0 ? parseTiff(data.subarray(off)) : null;
      if (!m || m.damaged) { group({ id: 'png:exif-unreadable', group: 'hidden', tier: 'red', label: 'EXIF data that could not be read', note: 'It may hold anything, so removing it is the safe choice.' }, c, formatBytes(data.length)); continue; }
      const entry: PngExifEntry = { chunk: c, off };
      model.exif.push(entry);
      addTiff(m, { kind: 'exif', entry });
      // An eXIf chunk starts with the TIFF header (PNG third edition); bytes before it are
      // free, so a chunk that stays loses them.
      if (off > 0) set.normalise = true;
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
            const entry: PngExifEntry = { chunk: c, info, prof, off };
            model.exif.push(entry);
            addTiff(m, { kind: 'rawexif', entry });
            canonical(c, rawProfileChunk('exif', concat([EXIF_HEAD, prof.bytes.subarray(off)])));
            continue;
          }
        }
        if (prof && (kind === 'iptc' || kind === '8bim')) {
          if (startsWith(prof.bytes, 0, '8BIM')) { addIrb(prof.bytes, c, info, kw, prof); continue; }
          const iptc = parseIptc(prof.bytes);
          if (iptc.sets.length) {
            const entry: PngIrbEntry = { chunk: c, info, keyword: kw, prof, iptc, items: [] };
            model.irb.push(entry);
            for (const it of iptcItems(iptc)) {
              const pub: ItemSpec = { id: `iptc:${it.key}`, group: it.group, tier: it.tier, label: it.label, value: it.value, source: 'IPTC' };
              if (it.note) pub.note = it.note;
              entry.items.push(set.add(pub, { kind: 'iptc', entry, key: it.key }));
            }
            const canon = rebuildIptc(iptc);
            if (!canon || !sameBytes(rawProfileChunk('iptc', canon), b.subarray(c.start, c.end))) set.normalise = true;
            continue;
          }
        }
        if (prof && kind === 'xmp') { addXmp(xmpText(prof.bytes), c, { ...info, rawProfile: prof }); continue; }
        if (prof && (kind === 'icc' || kind === 'icm')) {
          if (!colourProfile(c, prof.bytes, { raw: { info, type: prof.type } })) continue;
          group({ id: 'png:colour', group: 'technical', tier: 'green', label: 'Colour profile', note: 'Keeps colours accurate on different screens.' }, c, iccDescription(prof.bytes));
          canonical(c, rawProfileChunk('icc', prof.bytes));
          continue;
        }
        group({ id: `png:profile:${kind.replace(/[^a-z0-9]+/g, '-') || 'data'}`, group: 'hidden', tier: 'red', label: 'Unidentified extra data from the device or software', source: 'PNG text' }, c, `${kw}, ${formatBytes(prof ? prof.bytes.length : info.raw.length)}`);
        continue;
      }
      if (lower.startsWith('exif:')) {
        const name = kw.slice(5);
        const base = keyForTagName(name);
        // A copy of a technical field must read as numbers, as the field itself must, and a
        // copy of a date or device field must have that field's form.
        let key = base;
        if (GREEN_TECH_KEYS.has(base) && !(technicalTextOk(info.text, name) && latin1Line(info.text))) key = 'technical-text';
        else if (isAmberTextKey(base) && !(amberTextOk(base, name, info.text) && latin1Line(info.text))) key = 'device-text';
        // No prototype, so a keyword such as exif:__proto__ is stored like any other name.
        if (!exifText.has(key)) exifText.set(key, { chunks: [], values: Object.create(null) });
        // Set on the line above when missing.
        (exifText.get(key) as { chunks: PngChunk[]; values: Record<string, string> }).chunks.push(c);
        (exifText.get(key) as { chunks: PngChunk[]; values: Record<string, string> }).values[name] = info.text;
        // A copy that stays by default is written as a fresh tEXt chunk (see AMBER_TEXT).
        if (GREEN_TECH_KEYS.has(key) || isAmberTextKey(key)) canonical(c, textOnly(`exif:${tagNameOf(name)}`, info.text));
        continue;
      }
      const def = textKeyDef(lower);
      if (def && def.tier === 'amber') {
        // Only TEXT_KEYS entries are amber, and each of them is a key of AMBER_TEXT.
        const [keyword, ok] = AMBER_TEXT[lower as keyof typeof AMBER_TEXT] || [];
        if (keyword && latin1Line(info.text) && ok(info.text)) {
          group(def, c, info.text);
          canonical(c, textOnly(keyword, info.text));
        } else group(DEVICE_TEXT, c, `${clip(kw, 30)}: ${info.text}`);
        continue;
      }
      if (def) { group(def, c, info.text); continue; }
      const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'text';
      // A text chunk under any other keyword is free text, so it is red (0.0.3).
      group({ id: `png:text:${slug}`, group: 'hidden', tier: 'red', label: `Text: ${clip(kw, 40)}`, source: 'PNG text', note: 'Free text written by a person or an app. It can hold names, places or notes.' }, c, info.text);
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
    const pub: ItemSpec = { id: `png:exif-text:${key}`, group: def.group, tier: def.tier, label: def.label, value, source: 'PNG text' };
    if (def.note) pub.note = def.note;
    set.add(pub, { kind: 'chunks', chunks: g.chunks });
  }
  for (const [id, g] of groups) {
    const def = g.def;
    const values = [...new Set(g.values.filter(Boolean))];
    const pub: ItemSpec = { id, group: def.group, tier: def.tier, label: def.label, value: clip(values.join(', ') || def.label), source: def.source || (id === 'png:colour' && g.chunks.some((c) => c.type === 'iCCP') ? 'ICC profile' : 'PNG') };
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
  return (model as PngModel & { orientation: number });
}

export async function scrubPng(b: Uint8Array, model: PngModel, set: ItemSet, remove: Set<string>): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const warnings: string[] = [];
  const out = b.slice();
  const drop: Set<PngChunk> = new Set();
  const replace: Map<PngChunk, Uint8Array> = new Map();
  let cutTrailing = false;
  let cutDamaged = false;
  let cleanIend = false;

  const exifKeys: Map<PngExifEntry, { kind: 'exif' | 'rawexif'; keys: Set<string> }> = new Map();
  const irbRemovals: Map<PngIrbEntry, string[]> = new Map();
  const iccTexts: ({ kind: 'icctext'; chunk: PngChunk; prof: Uint8Array } & ProfileWhere)[] = [];
  for (const id of remove) {
    const it = (set.get(id) as PngInternal | undefined);
    if (!it) continue;
    if (it.kind === 'chunks') for (const c of it.chunks) drop.add(c);
    else if (it.kind === 'trailing') cutTrailing = true;
    else if (it.kind === 'damaged') cutDamaged = true;
    else if (it.kind === 'iend') cleanIend = true;
    else if (it.kind === 'icctext') iccTexts.push(it);
    else if (it.kind === 'exif' || it.kind === 'rawexif') {
      if (!exifKeys.has(it.entry)) exifKeys.set(it.entry, { kind: it.kind, keys: new Set() });
      (exifKeys.get(it.entry) as { keys: Set<string> }).keys.add(it.key);
    } else if (it.kind === 'irb' || it.kind === 'iptc') {
      if (!irbRemovals.has(it.entry)) irbRemovals.set(it.entry, []);
      (irbRemovals.get(it.entry) as string[]).push(id);
    }
  }

  for (const [entry, { kind, keys }] of exifKeys) {
    const c = entry.chunk;
    if (kind === 'exif') {
      const data = out.subarray(c.dataStart, c.dataEnd);
      // These bytes parsed as whole EXIF in analysePng, so they parse again here.
      const m = (parseTiff(data.subarray(entry.off)) as TiffModel);
      const res = removeTiffKeys(m, keys);
      if (res.empty) drop.add(c);
      else replace.set(c, makeChunk('eXIf', out.slice(c.dataStart + entry.off, c.dataEnd)));
    } else {
      // A rawexif entry always holds its raw profile.
      const bytes = (entry.prof as RawProfile).bytes.slice();
      const m = (parseTiff(bytes.subarray(entry.off)) as TiffModel);
      const res = removeTiffKeys(m, keys);
      if (res.empty) drop.add(c);
      else replace.set(c, rawProfileChunk('exif', concat([EXIF_HEAD, bytes.subarray(entry.off)])));
    }
  }
  // An eXIf chunk that stays starts with its TIFF header.
  for (const entry of model.exif) {
    const c = entry.chunk;
    if (!entry.prof && entry.off > 0 && !drop.has(c) && !replace.has(c)) replace.set(c, makeChunk('eXIf', out.slice(c.dataStart + entry.off, c.dataEnd)));
  }

  // Text inside a colour profile: the profile is rewritten with neutral text (its colour
  // tags untouched) and an unlisted iCCP name becomes a neutral one.
  for (const it of iccTexts) {
    const c = it.chunk;
    if (drop.has(c)) continue;
    const cleaned = cleanIcc(it.prof);
    if (!cleaned) {
      drop.add(c);
      warnings.push('The text inside the colour profile could not be removed safely, so the whole colour profile was removed. Colours may look slightly different.');
      continue;
    }
    if (it.raw) replace.set(c, rawProfileChunk('icc', cleaned));
    else {
      // Without raw, the text came from an iCCP chunk whose name was read (see colourProfile).
      const name = iccNameAllowed(it.name as string) ? (it.name as string) : 'ICC profile';
      replace.set(c, makeChunk('iCCP', concat([encodeLatin1(name), new Uint8Array([0, 0]), zlibStored(cleaned)])));
    }
  }

  for (const entry of model.xmp) {
    const plan = planXmp(entry.parsed, entry.items, remove);
    if (plan.warning) warnings.push(plan.warning);
    if (plan.action === 'drop') drop.add(entry.chunk);
    else replace.set(entry.chunk, xmpChunk(entry.info, plan.text));
  }

  // Photoshop and IPTC data that stays is always written again in the canonical form (see
  // canonicalIrb and rebuildIptc in iptc.js), even when nothing in it goes.
  for (const entry of model.irb) {
    const ids = irbRemovals.get(entry) || [];
    if (ids.length === entry.items.length) { drop.add(entry.chunk); continue; }
    let bytes;
    // Every id here is in the set: remove only holds ids the set has, and entry.items are
    // the ids set.add gave back.
    if (entry.irb) {
      const parts = new Set(ids.map((id) => (set.get(id) as ItemInternal).part));
      const removeIptc = new Set(ids.filter((id) => (set.get(id) as ItemInternal).part === 'iptc').map((id) => (set.get(id) as ItemInternal).key));
      if (entry.items.some((id) => (set.get(id) as ItemInternal).part === 'rest' && !ids.includes(id))) warnings.push('Photoshop data that could not be read was removed although it was not ticked: Photoshop data is always written again in a standard form, which only holds what can be read.');
      bytes = canonicalIrb(entry.irb, entry.iptc, entry.iptcRes, { parts, removeIptc });
    } else {
      // An entry without irb is a bare IPTC block, which always holds its parsed data.
      bytes = rebuildIptc(entry.iptc as ParsedIptc, new Set(ids.map((id) => (set.get(id) as ItemInternal).key)));
    }
    if (!bytes || !bytes.length) { drop.add(entry.chunk); continue; }
    replace.set(entry.chunk, rawProfileChunk(entry.irb ? '8bim' : 'iptc', bytes));
  }

  if (model.c2pa && !remove.has('png:c2pa') && (drop.size || replace.size || cutTrailing || cutDamaged || cleanIend)) {
    warnings.push('Content Credentials were kept, but any change to the file makes their signature fail, so checkers will report the picture as altered.');
  }

  const asm = new Assembler(out);
  asm.copy(0, 8);
  for (const c of model.chunks) {
    if (drop.has(c) && (c.bad || !STRUCTURAL.has(c.type))) continue;
    if (c.type === 'IEND' && cleanIend) { asm.add(IEND); continue; }
    if (replace.has(c)) { asm.add(replace.get(c) as Uint8Array); continue; }
    if (model.canon.has(c)) { asm.add(model.canon.get(c) as Uint8Array); continue; }
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

export function insertPngExif(b: Uint8Array, tiff: Uint8Array): Uint8Array {
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
export function firstPngTiff(b: Uint8Array): Uint8Array | null {
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
