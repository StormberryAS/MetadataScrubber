#!/usr/bin/env node
// Adversarial privacy audit of the MetadataScrubber engine (src/scrub-core.js).
//
// A skeptic's harness: it tries to prove that metadata survives a scrub. It is not part of
// the unit test suite (node --test does not pick it up) because it is slow and needs the
// same tools as the fixtures: exiftool, ImageMagick 7 (magick, with HEIC and WebP) and
// python3 with Pillow.
//
// Usage, from the repository root:
//   MS_AUDIT_DIR=<scratch>/audit MS_FIXTURE_DIR=<scratch>/core-fixtures node tests/audit.mjs
// Options:
//   --sections=registry,core,adversarial,reencode,hostile   run only these sections (default: all)
//   --fuzz=N            mutations per fixture in the hostile section (default 120)
//   --no-exiftool       skip the exiftool listing and validation (faster)
//
// Sections:
//   registry     every fixture in tests/fixtures/out, checked against out/canaries.tsv
//   core         every picture the engine tests generated (MS_FIXTURE_DIR), checked against
//                the PLANT values in tests/core-fixtures.mjs
//   adversarial  hand-built pictures that hide data where a scrubber might not look
//   reencode     buildExif() and insertExif() with every non-red detail kept (the page's
//                starting selection, which ticks red only since 0.0.3), as used after a
//                crop, a resize or a baked rotation
//   hostile      damaged and malicious inputs, run in a worker with a time limit
//
// For each picture it:
//   1. runs inspect() and works out which detail removes each planted string (one scrub per
//      detail), so a planted string with no detail, or with the wrong tier, is caught;
//   2. scrubs only the red details (red only: since 0.0.3 this is the page's starting
//      selection, as defaultIds() in app.js ticks red only; the audit checks the two agree)
//      and searches the output for red planted strings in plain, UTF-16, hex, base64 and
//      zlib-compressed form;
//   2b. scrubs the red-and-amber selection (red and amber ticked, green kept, except an
//      amber HDR gain map and its own amber details, as a user gets by ticking Amber and
//      leaving the gain map unticked; the page's starting selection before 0.0.3), searches
//      for red and amber planted strings and requires a read-back of green details only,
//      plus the gain map's own details when it is kept. Anything planted in or around a kept
//      gain map must still go: the gain map keeps only what it needs to render;
//   2b-min. on a picture with an amber HDR gain map, also scrubs every red and amber detail
//      with the gain map ticked (what a user gets who wants the minimal word), with the same
//      searches and a read-back of green details only;
//   3. scrubs every detail ("every detail ticked") and searches for every planted string;
//   4. lists what exiftool -a -u -G1 -ee3 -U still shows beyond pure structure;
//   5. checks the outputs decode (magick, Pillow), the decoded pixels are identical, exiftool
//      -validate reports nothing new, and HEIC box sizes and offsets did not move; where the
//      red-and-amber selection keeps an HDR gain map, that the gain map is still a whole JPEG found
//      through MPF (exiftool -b -MPImage2), decodes to the input gain map's pixels, has the
//      length the Container directory gives, and keeps the hdrgm values of the input;
//   6. looks for partial overwrites: fragments of removed strings and the raw GPS rationals;
//   7. feeds damaged inputs and checks nothing hangs, crashes or keeps data silently.
//
// Writes report.json, report.txt and every output file under MS_AUDIT_DIR (default
// os.tmpdir()/metadatascrubber-audit). Exit status 1 when a critical or high finding exists.
// Everything here is synthetic: no real photo is used, names and serials are invented and
// GPS positions are public landmarks.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import zlib from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CORE_URL = pathToFileURL(join(ROOT, 'src', 'scrub-core.js')).href;
const core = await import(CORE_URL);
const { canonicalXmp, parseXmp } = await import(pathToFileURL(join(ROOT, 'src', 'core', 'xmp.js')).href);
const { parseHeif } = await import(pathToFileURL(join(ROOT, 'src', 'core', 'heic.js')).href);

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return dflt;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};
const SECTIONS = new Set(String(opt('sections', 'registry,core,adversarial,reencode,hostile')).split(','));
const FUZZ = Number(opt('fuzz', 120));
const USE_EXIFTOOL = !opt('no-exiftool', false);
const OUT = process.env.MS_AUDIT_DIR || join(tmpdir(), 'metadatascrubber-audit');
const FIXTURES = process.env.MS_AUDIT_FIXTURES || join(ROOT, 'tests', 'fixtures', 'out');
const CORE_FIX = process.env.MS_FIXTURE_DIR || join(tmpdir(), 'metadatascrubber-core-fixtures');
for (const d of ['outputs', 'adversarial', 'hostile', 'exiftool']) mkdirSync(join(OUT, d), { recursive: true });

// ======================================================================================
// Small helpers

const sh = (cmd, args, { binary = false, input } = {}) => execFileSync(cmd, args, {
  encoding: binary ? 'buffer' : 'utf8', maxBuffer: 512 << 20, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], input,
});
const tryRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20 });
  return { ok: r.status === 0, status: r.status, out: r.stdout || '', err: r.stderr || '' };
};
const B = (x) => (Buffer.isBuffer(x) ? x : typeof x === 'string' ? Buffer.from(x, 'latin1') : Buffer.from(x));
const cat = (...parts) => Buffer.concat(parts.flat().map(B));
const be16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const be32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const le16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; };
const le32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const u8 = (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const extOf = (fmt) => ({ jpeg: 'jpg', png: 'png', webp: 'webp', heic: 'heic' }[fmt] || 'bin');
const log = (...a) => console.log(...a);
const hexAt = (n) => `0x${n.toString(16)}`;

// Deterministic pseudo-random numbers for fuzzing and planted IDs.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ======================================================================================
// Findings

const findings = [];
const passed = [];
const findingKeys = new Set();
function finding(severity, fixture, location, detail, reproduce, key) {
  const k = key || `${severity}|${fixture}|${location}|${detail}`;
  if (findingKeys.has(k)) return;
  findingKeys.add(k);
  findings.push({ severity, fixture, location, detail, reproduce });
}
const pass = (text) => passed.push(text);

// ======================================================================================
// Deep search: raw bytes, UTF-16 either way, and the inside of every zlib stream, hex run
// and base64 run (one level deep, plus zlib inside decoded hex).

function haystacks(bytes, depth = 0) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [{ kind: 'raw', b: raw }];
  // Every zlib stream, wherever it starts.
  for (let i = 0; i + 2 < raw.length; i++) {
    if (raw[i] !== 0x78) continue;
    const c = raw[i + 1];
    if (((0x78 << 8) | c) % 31 !== 0 || (c & 0x20)) continue;
    try {
      const inf = zlib.inflateSync(raw.subarray(i), { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: 64 << 20 });
      if (inf.length) out.push({ kind: `zlib@${i}`, b: inf });
    } catch { /* not a stream */ }
  }
  if (depth === 0) {
    const text = raw.toString('latin1');
    for (const m of text.matchAll(/(?:[0-9a-fA-F]{2}\s*){24,}/g)) {
      const hex = m[0].replace(/\s+/g, '');
      const dec = Buffer.from(hex.slice(0, hex.length & ~1), 'hex');
      out.push({ kind: `hex@${m.index}`, b: dec });
      for (const h of haystacks(dec, 1).slice(1)) out.push({ kind: `hex@${m.index}/${h.kind}`, b: h.b });
    }
    for (const m of text.matchAll(/[A-Za-z0-9+/]{64,}={0,2}/g)) {
      const dec = Buffer.from(m[0], 'base64');
      if (dec.length) out.push({ kind: `base64@${m.index}`, b: dec });
    }
  }
  return out;
}

const forms = (s) => [
  ['plain', Buffer.from(s, 'utf8')],
  ['utf16le', Buffer.from(s, 'utf16le')],
  ['utf16be', Buffer.from(s, 'utf16le').swap16()],
];
// Where a string is found: [{ kind, form, offset }], empty when absent.
function locate(hays, s) {
  const hits = [];
  for (const h of hays) {
    for (const [form, needle] of forms(s)) {
      const at = h.b.indexOf(needle);
      if (at >= 0) hits.push({ kind: h.kind, form, offset: at });
    }
  }
  return hits;
}
// How many times a string occurs in all haystacks and forms.
function countIn(hays, s) {
  let n = 0;
  for (const h of hays) {
    for (const [, needle] of forms(s)) {
      let at = h.b.indexOf(needle);
      while (at >= 0) { n++; at = h.b.indexOf(needle, at + 1); }
    }
  }
  return n;
}
const describeHits = (hits) => hits.map((h) => `${h.form} in ${h.kind}${h.kind === 'raw' ? ` at ${hexAt(h.offset)}` : ` (+${hexAt(h.offset)})`}`).join('; ');

// ======================================================================================
// Independent readers (never the engine's code): JPEG segments, PNG chunks, RIFF chunks,
// ISO boxes, and the raw GPS rationals of every TIFF block, for the zeroing check.

function jpegSegments(b) {
  const segs = [];
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const m = b[p + 1];
    if (m === 0xda || m === 0xd9) { segs.push({ marker: m, start: p }); break; }
    const len = b.readUInt16BE(p + 2);
    segs.push({ marker: m, start: p, data: p + 4, end: p + 2 + len });
    p += 2 + len;
  }
  return segs;
}
function pngChunks(b) {
  const out = [];
  let p = 8;
  while (p + 12 <= b.length) {
    const n = b.readUInt32BE(p);
    out.push({ type: b.toString('latin1', p + 4, p + 8), start: p, data: p + 8, end: p + 12 + n });
    if (b.toString('latin1', p + 4, p + 8) === 'IEND') break;
    p += 12 + n;
  }
  return out;
}
function isoBoxes(b, s = 0, e = b.length, depth = 0, prefix = '') {
  const out = [];
  let p = s;
  const containers = new Set(['meta', 'iprp', 'ipco', 'iinf', 'iref', 'dinf', 'moov', 'trak', 'mdia', 'minf', 'stbl']);
  while (p + 8 <= e) {
    let size = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) { size = Number(b.readBigUInt64BE(p + 8)); hdr = 16; } else if (size === 0) size = e - p;
    if (size < 8 || p + size > e) { out.push({ path: `${prefix}${type}!`, start: p, size: e - p }); break; }
    out.push({ path: prefix + type, start: p, size });
    if (depth < 4 && containers.has(type)) {
      let inner = p + hdr;
      if (type === 'meta') inner += 4;
      if (type === 'iinf') inner += 4 + (b[p + hdr] === 0 ? 2 : 4);
      if (type === 'iref') inner += 4;
      out.push(...isoBoxes(b, inner, p + size, depth + 1, `${prefix}${type}/`));
    }
    p += size;
  }
  return out;
}
// Raw bytes of GPSLatitude and GPSLongitude in every TIFF block of a file.
function gpsRationals(buf) {
  const res = [];
  const seen = new Set();
  const heads = [];
  for (let i = 0; i + 8 <= buf.length; i++) {
    if ((buf[i] === 0x49 && buf[i + 1] === 0x49 && buf[i + 2] === 42 && buf[i + 3] === 0)
      || (buf[i] === 0x4d && buf[i + 1] === 0x4d && buf[i + 2] === 0 && buf[i + 3] === 42)) heads.push(i);
  }
  for (const t of heads) {
    const le = buf[t] === 0x49;
    const r16 = (p) => (p + 2 <= buf.length ? (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p)) : 0);
    const r32 = (p) => (p + 4 <= buf.length ? (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p)) : 0);
    const dir = (off) => {
      const at = t + off;
      if (off < 8 || at + 2 > buf.length) return [];
      const n = r16(at);
      if (n > 500 || at + 2 + n * 12 > buf.length) return [];
      return Array.from({ length: n }, (_, i) => ({ tag: r16(at + 2 + i * 12), type: r16(at + 4 + i * 12), count: r32(at + 6 + i * 12), val: r32(at + 10 + i * 12) }));
    };
    const ifd0 = dir(r32(t + 4));
    const exifPtr = ifd0.find((e) => e.tag === 0x8769);
    const exif = exifPtr ? dir(exifPtr.val) : [];
    for (const g of [...ifd0, ...exif].filter((e) => e.tag === 0x8825)) {
      for (const e of dir(g.val)) {
        if ((e.tag === 2 || e.tag === 4) && e.type === 5 && e.count === 3 && t + e.val + 24 <= buf.length) {
          const bytes = Buffer.from(buf.subarray(t + e.val, t + e.val + 24));
          const k = bytes.toString('hex');
          if (!seen.has(k) && bytes.some((x) => x)) { seen.add(k); res.push({ label: e.tag === 2 ? 'GPSLatitude' : 'GPSLongitude', bytes }); }
        }
      }
    }
  }
  return res;
}

// ======================================================================================
// Tool wrappers: exiftool listing and validation, decoding and pixel hashes

const PY_HASH = `
import sys, json, hashlib, warnings
warnings.simplefilter('ignore')
from PIL import Image, ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES = True
out = {}
for f in sys.argv[1:]:
    try:
        im = Image.open(f)
        im.load()
        out[f] = {'ok': True, 'hash': im.mode + ':' + str(im.size) + ':' + hashlib.sha256(im.tobytes()).hexdigest()}
    except Exception as e:
        out[f] = {'ok': False, 'error': type(e).__name__ + ': ' + str(e)[:200]}
print(json.dumps(out))
`;
function pilHashes(files) {
  if (!files.length) return {};
  const res = {};
  for (let i = 0; i < files.length; i += 200) {
    const r = spawnSync('python3', ['-c', PY_HASH, ...files.slice(i, i + 200)], { encoding: 'utf8', maxBuffer: 64 << 20 });
    try { Object.assign(res, JSON.parse(r.stdout)); } catch { for (const f of files.slice(i, i + 200)) res[f] = { ok: false, error: r.stderr.slice(0, 300) }; }
  }
  return res;
}
function magickHash(file) {
  const r = spawnSync('magick', [`${file}[0]`, '-depth', '8', 'rgba:-'], { maxBuffer: 1 << 30 });
  return r.status === 0 ? { ok: true, hash: sha(r.stdout), warn: String(r.stderr).trim() } : { ok: false, error: String(r.stderr).trim().slice(0, 300) };
}
function magickIdentify(file) {
  const r = tryRun('magick', ['identify', '-regard-warnings', file]);
  return r.ok ? { ok: true } : { ok: false, error: (r.err || r.out).trim().slice(0, 300) };
}
const STRUCTURAL_GROUPS = new Set(['ExifTool', 'System', 'File', 'Composite']);
const STRUCTURAL_TAGS = new Set([
  'JFIF:JFIFVersion', 'JFIF:ResolutionUnit', 'JFIF:XResolution', 'JFIF:YResolution',
  'PNG:ImageWidth', 'PNG:ImageHeight', 'PNG:BitDepth', 'PNG:ColorType', 'PNG:Compression', 'PNG:Filter', 'PNG:Interlace',
  'PNG:Palette', 'PNG:Transparency',
  'RIFF:VP8Version', 'RIFF:ImageWidth', 'RIFF:HorizontalScale', 'RIFF:ImageHeight', 'RIFF:VerticalScale', 'RIFF:WebP_Flags',
  'RIFF:AlphaPreprocessing', 'RIFF:AlphaFiltering', 'RIFF:AlphaCompression', 'RIFF:AlphaIsUsed',
  'Adobe:DCTEncodeVersion', 'Adobe:APP14Flags0', 'Adobe:APP14Flags1', 'Adobe:ColorTransform',
]);
const QT_STRUCTURAL = /^(MajorBrand|MinorVersion|CompatibleBrands|HandlerType|PrimaryItemReference|MetaImageSize|HEVC.*|GeneralProfile.*|GeneralTier.*|GeneralLevel.*|MinSpatialSegmentation.*|ParallelismType|ChromaFormat|BitDepth.*|AverageFrameRate|ConstantFrameRate|NumTemporalLayers|TemporalIDNested|ImageSpatialExtent|ImagePixelDepth|Rotation|MediaDataSize|MediaDataOffset|ColorRepresentation|ColorPrimaries|TransferCharacteristics|MatrixCoefficients|VideoFullRangeFlag|ItemInfo|AuxiliaryImageType|ImageWidth|ImageHeight)$/;
const RED_TAG = /GPS|Artist|Creator|Author|By-?line|Owner|Serial|City|Country|Location|Sub-?location|Province|DocumentID|InstanceID|UniqueID|PreservedFileName|PersonInImage|Region|Copyright|Rights|Contact|E-?mail|Address|Phone|Ancestors|ThumbnailImage|PreviewImage|MakerNote|Comment|HostComputer/i;

function exiftoolList(file) {
  const r = tryRun('exiftool', ['-a', '-u', '-U', '-G1', '-ee3', '-s', '-m', file]);
  const rows = [];
  for (const line of r.out.split('\n')) {
    const m = /^\[([^\]]+)\]\s+(\S+)\s*:\s?(.*)$/.exec(line);
    if (m) rows.push({ group: m[1], tag: m[2], value: m[3] });
  }
  return rows;
}
function nonStructural(rows) {
  return rows.filter((r) => {
    if (STRUCTURAL_GROUPS.has(r.group)) return false;
    if (STRUCTURAL_TAGS.has(`${r.group}:${r.tag}`)) return false;
    if ((r.group === 'QuickTime' || r.group === 'Meta' || r.group === 'ItemList') && (QT_STRUCTURAL.test(r.tag) || /HEVC|Profile|Constraint|Chroma|Segmentation|Parallelism|Layers|MediaData|Spatial|PixelDepth|ColorRep|Primaries|Transfer|Matrix|FullRange|Auxiliary/.test(r.tag)) && !RED_TAG.test(r.tag)) return false;
    if (r.group === 'RIFF' && /^(VP8|Image|Horizontal|Vertical|WebP_Flags|Alpha)/.test(r.tag)) return false;
    return true;
  });
}
function exiftoolValidate(file) {
  const r = tryRun('exiftool', ['-validate', '-warning', '-error', '-a', '-G1', '-s', '-m', file]);
  return r.out.split('\n')
    .filter((l) => /^\[ExifTool\]\s+(Warning|Error)\b/.test(l))
    .map((l) => l.replace(/^\[[^\]]+\]\s+\S+\s*:\s*/, '').replace(/\s*\[x\d+\]$/, '').trim())
    // An entry's position moves up when an earlier entry is removed, so the same damaged
    // entry is compared without its number ("for IFD0 entry 2" and "entry 1" are one warning).
    .map((l) => l.replace(/\b(for \w+ entry) \d+\b/, '$1 N'))
    .filter((l) => !/^\[minor\] Validate/.test(l));
}

// ======================================================================================
// Core evaluation of one picture against a list of planted strings.
//
// canaries: [{ string, tier, basis, location, group }]
// Returns a record kept in the report and adds findings.

const outputsForTools = []; // { fixture, label, inFile, outFile, format }

// The HDR gain map (JPEG or HEIC), its XMP description and Apple HDR brightness: amber, and
// unticked in the red-and-amber selection (step 2b), as app.js GAIN_MAP_OWN.
const GAIN_MAP_OWN = new Set(['jpeg:trailing:gain-map', 'heic:gain-map', 'xmp:gainmap', 'exif:apple-hdr']);
const GAIN_MAP_IDS = new Set(['jpeg:trailing:gain-map', 'heic:gain-map']);

// Every XMP packet in a prepared file must be in the engine's canonical form (0.0.3,
// decision 4): written again, it gives the same text, so no white space between nodes, no
// padding, no comments and no order of the writer's choosing can carry anything. A packet
// with a wrapper is checked in that form, one without in the compact form; an emptied HEIC
// packet is the one fixed empty packet. Returns { packets, problems }.
const EMPTY_PACKET = '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>';
function xmpLayout(bytes) {
  const b = Buffer.from(bytes);
  const texts = [];
  const fmt = core.detectFormat(u8(b));
  if (fmt === 'jpeg') {
    // Every APP1 XMP segment anywhere in the file: the photo's and those of a gain map or
    // another picture after it.
    const head = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
    for (let i = b.indexOf(head); i >= 0; i = b.indexOf(head, i + 1)) {
      if (i < 4 || b[i - 4] !== 0xff || b[i - 3] !== 0xe1) continue;
      const end = i - 2 + b.readUInt16BE(i - 2);
      if (end <= b.length) texts.push(b.subarray(i + head.length, end).toString('utf8'));
    }
  } else if (fmt === 'png') {
    for (const c of pngChunks(b)) {
      if (!['tEXt', 'zTXt', 'iTXt'].includes(c.type)) continue;
      const d = b.subarray(c.data, c.end - 4);
      const z = d.indexOf(0);
      const kw = d.toString('latin1', 0, z);
      let raw;
      try {
        if (c.type === 'tEXt') raw = d.subarray(z + 1);
        else if (c.type === 'zTXt') raw = zlib.inflateSync(d.subarray(z + 2));
        else {
          const lang = d.indexOf(0, z + 3);
          const trans = d.indexOf(0, lang + 1);
          raw = d[z + 1] ? zlib.inflateSync(d.subarray(trans + 1)) : d.subarray(trans + 1);
        }
      } catch { continue; }
      if (kw === 'XML:com.adobe.xmp') texts.push(raw.toString(c.type === 'tEXt' ? 'latin1' : 'utf8'));
      else if (/^raw profile type xmp$/i.test(kw)) {
        // ImageMagick's form: "\nxmp\n<length>\n<hexadecimal lines>\n".
        const m = /^\s*[^\n]*\n\s*(\d+)\n([\s\S]*)$/.exec(raw.toString('latin1'));
        if (m) texts.push(Buffer.from(m[2].replace(/[^0-9a-fA-F]/g, ''), 'hex').subarray(0, Number(m[1])).toString('utf8'));
      }
    }
  } else if (fmt === 'webp') {
    for (let p = 12; p + 8 <= b.length;) {
      const n = b.readUInt32LE(p + 4);
      if (b.toString('latin1', p, p + 4) === 'XMP ') texts.push(b.subarray(p + 8, p + 8 + n).toString('utf8'));
      p += 8 + n + (n & 1);
    }
  } else if (fmt === 'heic') {
    const m = parseHeif(u8(b));
    for (const it of m.items.values()) {
      if (it.type !== 'mime' || !/rdf\+xml|xmp/i.test(it.contentType) || !it.ranges) continue;
      const t = Buffer.concat(it.ranges.map(([s, e]) => b.subarray(s, e)));
      if (!t.every((x) => x === 0)) texts.push(t.toString('utf8'));
    }
  }
  const problems = [];
  for (const t of texts) {
    if (t === EMPTY_PACKET) continue;
    const canon = canonicalXmp(parseXmp(t), !t.startsWith('<?xpacket'));
    if (canon !== t) problems.push(`${`"${t.slice(0, 60).replace(/\s+/g, ' ')}..."`}${/>[ \t\r\n]+</.test(t) ? ' (white space between nodes)' : ''}${/[ \t\r\n]{2,}(<\?xpacket end|$)/.test(t) ? ' (padding)' : ''}`);
  }
  return { packets: texts.length, problems };
}

async function evaluate(label, file, bytesIn, canaries, { section, gpsCheck = true } = {}) {
  const rec = { label, file, section, size: bytesIn.length };
  const inBuf = Buffer.from(bytesIn);
  const fmt = core.detectFormat(u8(inBuf));
  rec.format = fmt;
  if (!fmt) { rec.unsupported = true; return rec; }
  let ins;
  try { ins = await core.inspect(u8(inBuf)); } catch (e) {
    rec.error = `${e.name}: ${e.message}`;
    finding('medium', label, 'inspect()', `inspect() threw ${rec.error}, so nothing in this file can be offered for removal.`, `node -e "import('${CORE_URL}').then(async c=>console.log(await c.inspect(new Uint8Array(require('fs').readFileSync('${file}')))))"`);
    return rec;
  }
  rec.items = ins.items;
  rec.inspectWarnings = ins.warnings;
  const ids = ins.items.map((i) => i.id);
  const redIds = ins.items.filter((i) => i.tier === 'red').map((i) => i.id);
  const hayIn = haystacks(inBuf);
  const present = canaries.filter((c) => locate(hayIn, c.string).length);
  rec.missingInInput = canaries.filter((c) => !present.includes(c)).map((c) => c.string);

  // 1. attribution: which single detail removes each planted string
  const removedBy = new Map(present.map((c) => [c.string, []]));
  const touchedBy = new Map(present.map((c) => [c.string, []]));
  const countsIn = new Map(present.map((c) => [c.string, countIn(hayIn, c.string)]));
  for (const id of ids) {
    const r = await core.scrub(u8(inBuf), [id]);
    const hay = haystacks(r.bytes);
    for (const c of present) {
      const n = countIn(hay, c.string);
      if (!n) removedBy.get(c.string).push(id);
      if (n < countsIn.get(c.string)) touchedBy.get(c.string).push(id);
    }
  }
  const itemOf = (id) => ins.items.find((i) => i.id === id);

  // 2, 2b, 2b-min and 3. red only (the page's starting selection), red and amber with the
  // gain map kept, every red and amber detail, and every detail ticked
  const red = await core.scrub(u8(inBuf), redIds);
  const hdrKept = ins.items.some((i) => GAIN_MAP_IDS.has(i.id) && i.tier === 'amber');
  // Mirrors defaultIds() in app.js (0.0.3): every red detail, except a gain map's own details
  // when the file holds an amber gain map. For one file that must be the red-only selection.
  const pageIds = ins.items.filter((i) => i.tier === 'red' && !(hdrKept && GAIN_MAP_OWN.has(i.id))).map((i) => i.id);
  if (pageIds.join('\n') !== redIds.join('\n')) finding('high', label, 'starting selection', `The page's starting selection (red only) differs from the red-only scrub: ${redIds.filter((id) => !pageIds.includes(id)).join(', ')} would stay unticked.`, '');
  // The red-and-amber selection: every red and amber detail, except an amber HDR gain map and
  // its own amber details.
  rec.hdrKept = hdrKept;
  const startIds = ins.items.filter((i) => i.tier !== 'green' && !(hdrKept && i.tier === 'amber' && GAIN_MAP_OWN.has(i.id))).map((i) => i.id);
  rec.startIds = startIds;
  const start = await core.scrub(u8(inBuf), startIds);
  const hayStart = haystacks(start.bytes);
  rec.startWarnings = start.warnings;
  const minIds = ins.items.filter((i) => i.tier !== 'green').map((i) => i.id);
  const min = hdrKept ? await core.scrub(u8(inBuf), minIds) : start;
  const hayMin = hdrKept ? haystacks(min.bytes) : hayStart;
  rec.minWarnings = min.warnings;
  const all = await core.scrub(u8(inBuf), ids);
  const hayRed = haystacks(red.bytes);
  const hayAll = haystacks(all.bytes);
  rec.redWarnings = red.warnings;
  rec.allWarnings = all.warnings;
  const ext = extOf(fmt);
  const safe = label.replace(/[^A-Za-z0-9._-]+/g, '_');
  const redFile = join(OUT, 'outputs', `${safe}.red.${ext}`);
  const allFile = join(OUT, 'outputs', `${safe}.all.${ext}`);
  writeFileSync(redFile, red.bytes);
  writeFileSync(allFile, all.bytes);
  const startFile = join(OUT, 'outputs', `${safe}.start.${ext}`);
  writeFileSync(startFile, start.bytes);
  rec.startFile = startFile;
  if (hdrKept) writeFileSync(join(OUT, 'outputs', `${safe}.min.${ext}`), min.bytes);
  outputsForTools.push({ fixture: label, inFile: file, redFile, allFile, startFile, format: fmt, hdrKept, rec });
  rec.redFile = redFile;
  rec.allFile = allFile;

  const repro = (which) => `node --input-type=module -e "import * as c from '${CORE_URL}'; import fs from 'node:fs'; const b=new Uint8Array(fs.readFileSync('${file}')); const i=await c.inspect(b); const h=i.items.some(x=>['jpeg:trailing:gain-map','heic:gain-map'].includes(x.id)&&x.tier==='amber'); const r=await c.scrub(b, i.items${which === 'red' ? ".filter(x=>x.tier==='red')" : which === 'start' ? ".filter(x=>x.tier!=='green'&&!(h&&x.tier==='amber'&&['jpeg:trailing:gain-map','heic:gain-map','xmp:gainmap','exif:apple-hdr'].includes(x.id)))" : which === 'min' ? ".filter(x=>x.tier!=='green')" : ''}.map(x=>x.id)); fs.writeFileSync('/tmp/out.${ext}', r.bytes)"; then grep -c (or tests/fixtures/fixturekit.py scan) /tmp/out.${ext}`;

  rec.canaries = [];
  for (const c of present) {
    const by = removedBy.get(c.string);
    const touched = touchedBy.get(c.string);
    const byItems = (by.length ? by : touched).map(itemOf);
    const tiers = [...new Set(byItems.map((i) => i.tier))];
    const leftRed = locate(hayRed, c.string);
    const leftAll = locate(hayAll, c.string);
    const visible = byItems.some((i) => i.value.includes(c.string.slice(0, Math.min(24, c.string.length))));
    const leftStart = locate(hayStart, c.string);
    const leftMin = hdrKept ? locate(hayMin, c.string) : leftStart;
    const row = { string: c.string, expected: c.tier, removedBy: by, touchedBy: touched, tiers, leftAfterDefault: describeHits(leftRed), leftAfterStart: describeHits(leftStart), leftAfterMin: describeHits(leftMin), leftAfterAll: describeHits(leftAll) };
    rec.canaries.push(row);
    const where = c.location || '';
    if (c.tier === 'red' && leftRed.length) {
      let sev;
      let why;
      if (by.some((id) => itemOf(id).tier === 'red')) { sev = 'critical'; why = `a red detail (${by.filter((id) => itemOf(id).tier === 'red').join(', ')}) removes it on its own, yet it survives the red-only scrub`; }
      else if (touched.some((id) => itemOf(id).tier === 'red')) { sev = 'critical'; why = `red detail(s) ${touched.filter((id) => itemOf(id).tier === 'red').join(', ')} remove some copies but not all`; }
      else if (!by.length && !touched.length) { sev = 'critical'; why = leftAll.length ? 'no detail removes it, not even ticking every detail: the user is never offered its removal' : 'no single detail removes it; only ticking every detail does'; }
      else if (visible) { sev = c.basis === 'inferred' ? 'medium' : 'high'; why = `it is offered, with its value shown, only as ${byItems.map((i) => `${i.tier} detail ${i.id} "${i.label}"`).join(', ')}: a tier disagreement with the registry (${c.basis || 'spec'})`; }
      else { sev = c.basis === 'inferred' ? 'high' : 'critical'; why = `it is hidden inside ${byItems.map((i) => `${i.tier} detail ${i.id} "${i.label}" (shown as "${i.value}")`).join(', ')}, which the red-only scrub keeps and which never shows this value`; }
      finding(sev, label, where, `Red planted string ${JSON.stringify(c.string)} survives the red-only scrub: ${why}. Left at: ${describeHits(leftRed)}.`, repro('red'));
    }
    if ((c.tier === 'red' || c.tier === 'amber') && leftStart.length) {
      finding(c.tier === 'red' ? 'critical' : 'high', label, where, `${c.tier === 'red' ? 'Red' : 'Amber'} planted string ${JSON.stringify(c.string)} survives the red-and-amber selection (red and amber ticked${hdrKept ? ', the HDR gain map and its description kept' : ''})${by.length ? `; single details ${by.join(', ')} remove it` : ''}. Left at: ${describeHits(leftStart)}.`, repro('start'));
    }
    if (hdrKept && (c.tier === 'red' || c.tier === 'amber') && leftMin.length) {
      finding(c.tier === 'red' ? 'critical' : 'high', label, where, `${c.tier === 'red' ? 'Red' : 'Amber'} planted string ${JSON.stringify(c.string)} survives with every red and amber detail ticked, the HDR gain map included${by.length ? `; single details ${by.join(', ')} remove it` : ''}. Left at: ${describeHits(leftMin)}.`, repro('min'));
    }
    if (leftAll.length) {
      finding('high', label, where, `Planted string ${JSON.stringify(c.string)} (${c.tier}) survives the every-detail scrub: ${by.length ? `single details ${by.join(', ')} remove it, but not all of them together` : 'no detail covers it'}. Left at: ${describeHits(leftAll)}.`, repro('all'));
    }
    if (!by.length && !touched.length && !leftAll.length && c.tier !== 'red') {
      finding('medium', label, where, `Planted ${c.tier} string ${JSON.stringify(c.string)} has no detail of its own; only ticking every detail removes it, so the user cannot remove it selectively.`, repro('all'));
    }
    if (by.length && !tiers.includes(c.tier)) {
      const order = { red: 0, amber: 1, green: 2 };
      const strictest = tiers.sort((a, b) => order[a] - order[b])[0];
      if (c.tier !== 'red' && order[strictest] < order[c.tier]) {
        finding('low', label, where, `Planted ${c.tier} string ${JSON.stringify(c.string)} is only removable through ${by.join(', ')} (${tiers.join('/')}), so the default selection removes it too (over-removal, not a leak).`, repro('red'));
      } else if (c.tier === 'red' && !leftRed.length) {
        // Removed by default anyway (for example through a red container), nothing to report.
      }
    }
  }

  // A kept gain map should survive the red-and-amber selection. When the engine cannot keep it
  // safely it removes it and says so: that fails closed, so it is noted, not a leak.
  rec.hdrFellBack = hdrKept && start.warnings.some((w) => /HDR gain map/.test(w));
  if (rec.hdrFellBack) {
    finding('low', label, 'red-and-amber selection', `The red-and-amber selection was meant to keep the HDR gain map, but the engine removed it: ${start.warnings.filter((w) => /HDR gain map/.test(w)).join(' / ')}`, repro('start'));
  }

  // 6. partial overwrites: fragments of removed strings
  const others = canaries.map((c) => c.string);
  for (const [which, hay, sel] of [['red-only', hayRed, (c) => c.tier === 'red'], ['red-and-amber', hayStart, (c) => c.tier === 'red' || c.tier === 'amber'], ...(hdrKept ? [['minimal-selection', hayMin, (c) => c.tier === 'red' || c.tier === 'amber']] : []), ['every-detail', hayAll, () => true]]) {
    for (const c of present.filter(sel)) {
      if (locate(hay, c.string).length || c.string.length < 14 || !/^CANARY|^[A-Z]{3,}-/.test(c.string)) continue;
      const frags = [];
      for (let i = 0; i + 10 <= c.string.length; i++) {
        const w = c.string.slice(i, i + 10);
        if (others.some((o) => o !== c.string && o.includes(w))) continue;
        const h = locate(hay, w);
        if (h.length) frags.push(`${JSON.stringify(w)} ${describeHits(h)}`);
      }
      if (frags.length) finding(which === 'red-only' ? 'critical' : 'high', label, c.location || '', `Fragments of removed string ${JSON.stringify(c.string)} remain after the ${which} scrub (partial overwrite): ${frags.slice(0, 3).join(' | ')}.`, repro({ 'red-only': 'red', 'red-and-amber': 'start', 'minimal-selection': 'min' }[which] || 'all'));
    }
  }
  // 6b. raw GPS rationals of the input must be gone after the red-only scrub
  if (gpsCheck) {
    const gps = gpsRationals(inBuf);
    rec.gpsRationals = gps.length;
    for (const g of gps) {
      for (const [which, out] of [['red-only', red.bytes], ['every-detail', all.bytes]]) {
        const at = Buffer.from(out).indexOf(g.bytes);
        if (at >= 0) finding('critical', label, `EXIF GPS ${g.label}`, `The raw ${g.label} rational (${g.bytes.toString('hex')}) is still in the bytes after the ${which} scrub, at offset ${hexAt(at)}: the GPS value was unlinked, not erased.`, repro(which === 'red-only' ? 'red' : 'all'));
      }
    }
  }

  // read-back of the outputs
  try {
    const rbRed = await core.inspect(red.bytes);
    rec.readbackDefault = rbRed.items.map((i) => `${i.tier}:${i.id}`);
    rec.wordDefault = core.privacyWord(rbRed.items);
    const stillRed = rbRed.items.filter((i) => i.tier === 'red');
    if (stillRed.length) finding('high', label, 'read-back', `After the red-only scrub, the read-back still lists red details: ${stillRed.map((i) => `${i.id} (${i.value})`).join('; ')}. The word would be "${rec.wordDefault}".`, repro('red'));
  } catch (e) { finding('high', label, 'read-back', `inspect() of the red-only output throws ${e.name}: ${e.message}`, repro('red')); }
  try {
    const rbStart = await core.inspect(start.bytes);
    rec.readbackStart = rbStart.items.map((i) => `${i.tier}:${i.id}`);
    rec.wordStart = core.privacyWord(rbStart.items);
    const notGreen = rbStart.items.filter((i) => i.tier !== 'green' && !(hdrKept && i.tier === 'amber' && GAIN_MAP_OWN.has(i.id)));
    if (notGreen.length) finding('high', label, 'read-back', `After the red-and-amber selection (red and amber ticked${hdrKept ? ', the HDR gain map kept' : ''}), the read-back still lists red or amber details: ${notGreen.map((i) => `${i.tier}:${i.id} (${i.value})`).join('; ')}. The word would be "${rec.wordStart}".`, repro('start'));
    if (hdrKept && !rec.hdrFellBack && !rbStart.items.some((i) => GAIN_MAP_IDS.has(i.id))) finding('medium', label, 'read-back', 'The red-and-amber selection was meant to keep the HDR gain map, but the read-back no longer lists it, and the scrub did not say why.', repro('start'));
  } catch (e) { finding('high', label, 'read-back', `inspect() of the red-and-amber output throws ${e.name}: ${e.message}`, repro('start')); }
  if (hdrKept) {
    try {
      const rbMin = await core.inspect(min.bytes);
      rec.readbackMin = rbMin.items.map((i) => `${i.tier}:${i.id}`);
      rec.wordMin = core.privacyWord(rbMin.items);
      const notGreen = rbMin.items.filter((i) => i.tier !== 'green');
      if (notGreen.length) finding('high', label, 'read-back', `With every red and amber detail ticked, the HDR gain map included, the read-back still lists red or amber details: ${notGreen.map((i) => `${i.tier}:${i.id} (${i.value})`).join('; ')}. The word would be "${rec.wordMin}".`, repro('min'));
    } catch (e) { finding('high', label, 'read-back', `inspect() of the minimal-selection output throws ${e.name}: ${e.message}`, repro('min')); }
  }
  try {
    const rbAll = await core.inspect(all.bytes);
    rec.readbackAll = rbAll.items.map((i) => `${i.tier}:${i.id}`);
    rec.wordAll = core.privacyWord(rbAll.items);
    if (rbAll.items.length) finding('medium', label, 'read-back', `After the every-detail scrub, the read-back still lists details: ${rbAll.items.map((i) => `${i.tier}:${i.id} (${i.value})`).join('; ')}. The word is "${rec.wordAll}", not "clean".`, repro('all'));
  } catch (e) { finding('high', label, 'read-back', `inspect() of the every-detail output throws ${e.name}: ${e.message}`, repro('all')); }

  // 0.0.3, decision 4: every XMP packet left in a prepared file is in the canonical form.
  rec.xmpPackets = 0;
  for (const [which, out] of [['red-only', red.bytes], ['red-and-amber', start.bytes], ['every-detail', all.bytes]]) {
    const lay = xmpLayout(out);
    rec.xmpPackets += lay.packets;
    if (lay.problems.length) finding('high', label, 'XMP layout', `After the ${which} scrub, ${lay.problems.length} XMP packet(s) are not in the canonical form, so their layout (white space, padding, order) can carry data: ${lay.problems.slice(0, 3).join('; ')}.`, repro(which === 'red-only' ? 'red' : which === 'every-detail' ? 'all' : 'start'));
  }

  if (fmt === 'heic') {
    // Only XMP may change length (it is written in the canonical form); the boxes stay the
    // same and in the same order, and every other item keeps its length.
    const hin = parseHeif(u8(inBuf));
    for (const [which, out] of [['red-only', red.bytes], ['every-detail', all.bytes]]) {
      const ho = parseHeif(u8(Buffer.from(out)));
      const newWarn = ho.warnings.filter((w) => !hin.warnings.includes(w));
      const types = (m) => `${m.top.map((x) => x.type).join(',')} / ${m.metaKids.map((x) => x.type).join(',')}`;
      const resized = [...hin.items.values()].filter((it) => it.ranges && !(it.type === 'mime' && /rdf\+xml|xmp/i.test(it.contentType))).filter((it) => {
        const o = ho.items.get(it.id);
        const len = (x) => (x && x.ranges ? x.ranges.reduce((n, [a, e]) => n + e - a, 0) : -1);
        return len(o) !== len(it);
      });
      if (newWarn.length) finding('medium', label, 'HEIC structure', `The ${which} output reads with new warnings: ${newWarn.join(' / ')}`, repro(which === 'red-only' ? 'red' : 'all'));
      // The engine blanks a box by turning it into a 'free' box of the same size.
      if (types(hin).replace(/\b(colr|uuid|free)\b/g, 'X') !== types(ho).replace(/\b(colr|uuid|free)\b/g, 'X')) finding('medium', label, 'HEIC boxes', `Box layout changed after the ${which} scrub: ${types(hin)} became ${types(ho)}`, repro(which === 'red-only' ? 'red' : 'all'));
      if (resized.length) finding('medium', label, 'HEIC items', `After the ${which} scrub, items other than XMP changed length: ${resized.map((it) => it.id).join(', ')}`, repro(which === 'red-only' ? 'red' : 'all'));
    }
    // A removed image must not turn into a picture of its own that a viewer offers (review of
    // 4 October 2026): libheif counts no more top-level images than in the input.
    const outFiles = [['red-only', rec.redFile], ['every-detail', rec.allFile]].filter(([, f]) => f);
    const heif = heifInfo([file, ...outFiles.map(([, f]) => f)]);
    if (heif && heif[file] && !heif[file].error) {
      for (const [which, f] of outFiles) {
        const h = heif[f];
        if (h && !h.error && h.top > heif[file].top) finding('high', label, 'HEIC top-level images', `After the ${which} scrub libheif sees ${h.top} top-level images, the input ${heif[file].top}: a removed image is offered as a picture of its own.`, `python3 ${join(OUT, 'heif-info.py')} ${file} ${f}`);
      }
    }
  }
  return rec;
}

// ======================================================================================
// Section 1: registry fixtures

function loadRegistry() {
  const p = join(FIXTURES, 'canaries.tsv');
  if (!existsSync(p)) {
    log(`Fixtures missing; running tests/fixtures/make-fixtures.sh`);
    sh('bash', [join(ROOT, 'tests', 'fixtures', 'make-fixtures.sh')]);
  }
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const head = lines.shift().split('\t');
  return lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v])));
}

async function sectionRegistry(records) {
  const reg = loadRegistry();
  const byFile = new Map();
  for (const r of reg) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r); }
  for (const name of readdirSync(FIXTURES).filter((n) => /\.(jpe?g|png|webp|heic|pdf)$/i.test(n)).sort()) {
    const file = join(FIXTURES, name);
    const bytes = readFileSync(file);
    const rows = (byFile.get(name) || []).map((r) => ({ string: r.string, tier: r.tier, basis: r.basis, location: r.location, group: r.group }));
    log(`[registry] ${name} (${rows.length} planted)`);
    if (core.detectFormat(u8(bytes)) === null) {
      if (/\.pdf$/.test(name)) pass(`${name}: detectFormat() returns null, as it must for a PDF`);
      else finding('medium', name, 'detectFormat', 'detectFormat() returns null for a picture fixture', `node: detectFormat(readFileSync('${file}'))`);
      continue;
    }
    const rec = await evaluate(name, file, bytes, rows, { section: 'registry' });
    records.push(rec);
  }
}

// ======================================================================================
// Section 2: pictures generated by the engine tests

async function sectionCore(records) {
  if (!existsSync(CORE_FIX) || !readdirSync(CORE_FIX).length) {
    log(`[core] ${CORE_FIX} is empty; run the engine tests first (MS_FIXTURE_DIR=${CORE_FIX} node --test tests/)`);
    return;
  }
  const prev = process.env.MS_FIXTURE_DIR;
  process.env.MS_FIXTURE_DIR = CORE_FIX;
  const { PLANT } = await import(pathToFileURL(join(HERE, 'core-fixtures.mjs')).href);
  if (prev === undefined) delete process.env.MS_FIXTURE_DIR;
  // Copyright is red: it names the photographer (decision of 2026-10-01, see README).
  // The computer name is red: it often names the owner (decision of 2026-10-02).
  // Anything hidden in or around a kept HDR gain map is red: it is not part of the gain map.
  // Free text in a colour profile or a technical field is red since 0.0.3 (hdrAmber keeps
  // its old name), and so is the rest of Apple's MakerNote next to the HDR numbers.
  // Descriptions and comments are free text, red since 0.0.3 (decision of 2026-10-04).
  const redKeys = ['description', 'comment', 'artist', 'owner', 'serial', 'lensSerial', 'uniqueId', 'xmpCreator', 'xmpCity', 'xmpDocId', 'xmpAuxSerial', 'iptcByline', 'iptcCity', 'iptcContact', 'unknownApp', 'trailing', 'copyright', 'computer', 'hdr', 'hdr2', 'hdrAmber', 'green', 'appleNote'];
  const canaries = [
    ...Object.entries(PLANT).map(([k, v]) => ({ string: v, tier: redKeys.includes(k) ? 'red' : 'amber', basis: 'core PLANT', location: `PLANT.${k}` })),
    { string: 'GPS-AREA-PLANT', tier: 'red', basis: 'core', location: 'GPSAreaInformation' },
    { string: 'MAKERNOTE-OWNER-PLANT', tier: 'red', basis: 'core', location: 'MakerNote owner' },
    { string: 'VIDEO-PLANT-SECRET', tier: 'red', basis: 'core', location: 'Motion Photo video' },
    // Content Credentials are red since the review of 4 October 2026.
    { string: 'FakeCam C2PA PLANT', tier: 'red', basis: 'core', location: 'C2PA claim generator' },
  ];
  const files = readdirSync(CORE_FIX).filter((n) => /\.(jpe?g|png|webp|heic)$/i.test(n) && !/\.out|\.gone|\.keep|^fresh/.test(n)).sort();
  for (const name of files) {
    const file = join(CORE_FIX, name);
    const bytes = readFileSync(file);
    if (!core.detectFormat(u8(bytes))) continue;
    log(`[core] ${name}`);
    const rec = await evaluate(`core/${name}`, file, bytes, canaries, { section: 'core' });
    records.push(rec);
  }
}

// ======================================================================================
// Section 3: adversarial pictures
//
// Each builder returns { name, bytes, canaries, note }. Canary tiers follow the spec: names,
// places, serials, IDs and previews are red.

const ADV = join(OUT, 'adversarial');
const advPath = (n) => join(ADV, n);

function magickTo(file, args) { sh('magick', [...args, file]); return readFileSync(file); }
function baseJpeg(name, w = 96, h = 64, seed = 7, comment) {
  const args = ['-seed', String(seed), '-size', `${w}x${h}`, 'plasma:fractal', '-strip', '-quality', '88'];
  if (comment) args.push('-set', 'comment', comment);
  return magickTo(advPath(name), args);
}
const seg = (marker, payload) => cat(Buffer.from([0xff, marker]), be16(B(payload).length + 2), payload);
// Inserts segments after SOI and any APP0.
function jpegInsert(jpeg, ...segs) {
  let p = 2;
  while (jpeg[p] === 0xff && jpeg[p + 1] === 0xe0) p += 2 + jpeg.readUInt16BE(p + 2);
  return cat(jpeg.subarray(0, p), ...segs, jpeg.subarray(p));
}
const exifSeg = (tiff) => seg(0xe1, cat('Exif\0\0', tiff));

// Little-endian TIFF writer with free layout: dirs is [{ name, entries, next }], each entry
// { tag, type, count?, data?: Buffer|string, ptr?: dirName, blob?: blobName, raw?: number }.
// Directories come first in order, each followed by its out-of-line values, then the blobs.
function tiffLE(dirs, blobs = {}) {
  const unit = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 129: 1 };
  const dataOf = (e) => (e.data === undefined ? null : typeof e.data === 'string' ? Buffer.from(`${e.data}\0`, 'utf8') : B(e.data));
  const at = {};
  let p = 8;
  for (const d of dirs) {
    at[d.name] = p;
    p += 2 + d.entries.length * 12 + 4;
    for (const e of d.entries) { const v = dataOf(e); if (v && v.length > 4) p += v.length + (v.length & 1); }
  }
  for (const [k, v] of Object.entries(blobs)) { at[`blob:${k}`] = p; p += v.length + (v.length & 1); }
  const out = Buffer.alloc(p);
  out.write('II', 0, 'latin1'); out.writeUInt16LE(42, 2); out.writeUInt32LE(8, 4);
  for (const d of dirs) {
    let q = at[d.name];
    let data = q + 2 + d.entries.length * 12 + 4;
    out.writeUInt16LE(d.entries.length, q);
    q += 2;
    for (const e of d.entries) {
      const v = dataOf(e);
      const count = e.count ?? (v ? v.length / (unit[e.type] || 1) : 1);
      out.writeUInt16LE(e.tag, q); out.writeUInt16LE(e.type, q + 2); out.writeUInt32LE(count >>> 0, q + 4);
      if (e.ptr) out.writeUInt32LE(at[e.ptr], q + 8);
      else if (e.blob) out.writeUInt32LE(at[`blob:${e.blob}`], q + 8);
      else if (e.raw !== undefined) out.writeUInt32LE(e.raw >>> 0, q + 8);
      else if (v.length <= 4) v.copy(out, q + 8);
      else { out.writeUInt32LE(data, q + 8); v.copy(out, data); data += v.length + (v.length & 1); }
      q += 12;
    }
    const nx = d.next === undefined ? 0 : typeof d.next === 'number' ? d.next : at[d.next];
    out.writeUInt32LE(nx >>> 0, q);
  }
  for (const [k, v] of Object.entries(blobs)) B(v).copy(out, at[`blob:${k}`]);
  return out;
}
const rational = (...pairs) => cat(...pairs.map((v) => le32(v)));
// GPS 59° 54' 50.08" N, 10° 45' 7.92" E (Oslo, the Opera House area; public landmark)
const GPS_ENTRIES = (area) => [
  { tag: 0x0000, type: 1, count: 4, data: Buffer.from([2, 3, 0, 0]) },
  { tag: 0x0001, type: 2, data: 'N' },
  { tag: 0x0002, type: 5, count: 3, data: rational(59, 1, 54, 1, 5008, 100) },
  { tag: 0x0003, type: 2, data: 'E' },
  { tag: 0x0004, type: 5, count: 3, data: rational(10, 1, 45, 1, 792, 100) },
  ...(area ? [{ tag: 0x001c, type: 7, data: cat('ASCII\0\0\0', area) }] : []),
];
const XMP = (body, ns = '', extra = '') => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">${extra}
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" ${ns}>
${body}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
const xmpSeg = (text) => seg(0xe1, cat('http://ns.adobe.com/xap/1.0/\0', Buffer.from(text, 'utf8')));
const C = (tag) => `CANARY-ADV-${tag}`;
// A message spelt in white space: each bit a space or a tab, each byte ended by a newline.
const WS_SPELL = (text) => [...Buffer.from(text, 'latin1')].map((c) => `${[...c.toString(2).padStart(8, '0')].map((x) => (x === '1' ? '\t' : ' ')).join('')}\n`).join('');
// Apple's MakerNote ("Apple iOS", big-endian, offsets from its own start) with the two HDR
// numbers (tags 33 and 48) and a text tag.
function appleNote(text) {
  const t = Buffer.from(`${text}\0`, 'latin1');
  const entries = [[0x0001, 9, 1, be32(14)], [0x000b, 2, t.length, t], [0x0021, 10, 1, cat(be32(10200), be32(10000))], [0x0030, 10, 1, cat(be32(64), be32(10000))]];
  const head = 14 + 2 + 12 * entries.length + 4;
  const parts = [Buffer.from('Apple iOS\0\0\x01MM', 'latin1'), be16(entries.length)];
  const values = [];
  let at = head;
  for (const [tag, type, count, data] of entries) {
    parts.push(be16(tag), be16(type), be32(count));
    if (data.length <= 4) parts.push(cat(data, Buffer.alloc(4 - data.length)));
    else { parts.push(be32(at)); values.push(data); at += data.length; if (data.length & 1) { values.push(Buffer.alloc(1)); at++; } }
  }
  parts.push(be32(0));
  return cat(...parts, ...values);
}

function buildAdversarial() {
  const list = [];
  const add = (name, bytes, canaries, note, extra = {}) => { writeFileSync(advPath(name), bytes); list.push({ name, bytes, canaries, note, ...extra }); };

  // A1. A second preview in IFD2, chained after the IFD1 thumbnail.
  {
    const t1 = baseJpeg('t1.jpg', 40, 30, 11, C('IFD1-THUMB-COM-11aa'));
    const t2 = baseJpeg('t2.jpg', 64, 48, 12, C('IFD2-PREVIEW-COM-22bb'));
    const tiff = tiffLE([
      { name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Advcam' }, { tag: 0x0132, type: 2, data: '2025:03:04 05:06:07' }, { tag: 0x8769, type: 4, ptr: 'exif' }], next: 'ifd1' },
      { name: 'exif', entries: [{ tag: 0x9003, type: 2, data: '2025:03:04 05:06:07' }] },
      { name: 'ifd1', entries: [{ tag: 0x0103, type: 3, count: 1, data: le16(6) }, { tag: 0x0201, type: 4, blob: 't1' }, { tag: 0x0202, type: 4, count: 1, data: le32(t1.length) }], next: 'ifd2' },
      { name: 'ifd2', entries: [{ tag: 0x0103, type: 3, count: 1, data: le16(6) }, { tag: 0x0201, type: 4, blob: 't2' }, { tag: 0x0202, type: 4, count: 1, data: le32(t2.length) }] },
    ], { t1, t2 });
    add('adv-ifd2-preview.jpg', jpegInsert(baseJpeg('b1.jpg'), exifSeg(tiff)), [
      { string: C('IFD1-THUMB-COM-11aa'), tier: 'red', location: 'EXIF IFD1 thumbnail, COM inside it' },
      { string: C('IFD2-PREVIEW-COM-22bb'), tier: 'red', location: 'EXIF IFD2 preview (chained after IFD1), COM inside it' },
    ], 'IFD1 points to a second preview directory, IFD2.');
  }
  // A2. The GPS directory pointer sits in the Exif IFD instead of IFD0.
  {
    const tiff = tiffLE([
      { name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Advcam' }, { tag: 0x8769, type: 4, ptr: 'exif' }] },
      { name: 'exif', entries: [{ tag: 0x8825, type: 4, ptr: 'gps' }, { tag: 0x9003, type: 2, data: '2025:03:04 05:06:07' }] },
      { name: 'gps', entries: GPS_ENTRIES(C('GPS-IN-EXIFIFD-AREA-33cc')) },
    ]);
    add('adv-gps-in-exif-ifd.jpg', jpegInsert(baseJpeg('b2.jpg'), exifSeg(tiff)), [
      { string: C('GPS-IN-EXIFIFD-AREA-33cc'), tier: 'red', location: 'GPS IFD reached through a GPSInfo pointer in the Exif IFD' },
    ], 'GPSInfo (0x8825) placed in the Exif IFD.');
  }
  // A3. Exif 3.0 UTF-8 type (129) for Artist and Copyright.
  {
    const tiff = tiffLE([
      { name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Advcam' }, { tag: 0x0132, type: 2, data: '2025:03:04 05:06:07' }, { tag: 0x013b, type: 129, data: `Åse Utf8 ${C('UTF8-ARTIST-44dd')}` }] },
    ]);
    add('adv-exif-utf8-type129.jpg', jpegInsert(baseJpeg('b3.jpg'), exifSeg(tiff)), [
      { string: C('UTF8-ARTIST-44dd'), tier: 'red', location: 'EXIF IFD0 Artist stored with the Exif 3.0 UTF-8 type (129)' },
    ], 'Artist written with type 129 (UTF-8, Exif 3.0).');
  }
  // A4. Thumbnail whose declared length runs past the end of the EXIF block.
  {
    const t1 = baseJpeg('t4.jpg', 40, 30, 14, C('THUMB-LEN-OVERFLOW-COM-55ee'));
    const tiff = tiffLE([
      { name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Advcam' }], next: 'ifd1' },
      { name: 'ifd1', entries: [{ tag: 0x0103, type: 3, count: 1, data: le16(6) }, { tag: 0x0201, type: 4, blob: 't' }, { tag: 0x0202, type: 4, count: 1, data: le32(t1.length + 64) }] },
    ], { t: t1 });
    add('adv-thumb-length-overflow.jpg', jpegInsert(baseJpeg('b4.jpg'), exifSeg(tiff)), [
      { string: C('THUMB-LEN-OVERFLOW-COM-55ee'), tier: 'red', location: 'EXIF IFD1 thumbnail whose length field is 64 bytes too large' },
    ], 'JPEGInterchangeFormatLength larger than the bytes available.');
  }
  // A5. IPTC (0x83BB) and XMP (0x02BC) stored as tags inside EXIF IFD0.
  {
    const ds = (rec, n, v) => cat(Buffer.from([0x1c, rec, n]), be16(Buffer.byteLength(v)), v);
    const iptc = cat(ds(1, 90, '\x1b%G'), ds(2, 0, '\0\x04'), ds(2, 80, C('EXIFIPTC-BYLINE-66ff')), ds(2, 90, C('EXIFIPTC-CITY-7701')));
    const xmp = XMP(`   <dc:creator><rdf:Seq><rdf:li>${C('EXIFXMP-CREATOR-8812')}</rdf:li></rdf:Seq></dc:creator>`, 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="59,54.8346N" exif:GPSLongitude="10,45.1320E"');
    const tiff = tiffLE([
      { name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Advcam' }, { tag: 0x02bc, type: 1, data: Buffer.from(xmp, 'utf8') }, { tag: 0x83bb, type: 7, data: iptc }] },
    ]);
    add('adv-iptc-xmp-in-exif.jpg', jpegInsert(baseJpeg('b5.jpg'), exifSeg(tiff)), [
      { string: C('EXIFIPTC-BYLINE-66ff'), tier: 'red', location: 'IPTC By-line inside EXIF IFD0 tag 0x83BB (IPTC-NAA)' },
      { string: C('EXIFIPTC-CITY-7701'), tier: 'red', location: 'IPTC City inside EXIF IFD0 tag 0x83BB' },
      { string: C('EXIFXMP-CREATOR-8812'), tier: 'red', location: 'XMP dc:creator inside EXIF IFD0 tag 0x02BC (ApplicationNotes)' },
      { string: '59,54.8346N', tier: 'red', location: 'XMP exif:GPSLatitude inside EXIF IFD0 tag 0x02BC' },
    ], 'IPTC-NAA and XMP stored as EXIF tags, as TIFF writers and some Windows tools do.');
  }
  // A6. XMP: a comment, an rdf:about UUID and a typed node outside rdf:Description.
  {
    const ns = 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Advedit 1.0"';
    const body = `   <dc:creator><rdf:Seq><rdf:li>${C('XMPCOMMENT-CREATOR-9923')}</rdf:li></rdf:Seq></dc:creator>
   <!-- Previous owner: ${C('XMP-XMLCOMMENT-aa34')} -->`;
    let text = XMP(body, ns).replace('rdf:about=""', `rdf:about="uuid:${C('XMP-ABOUT-UUID-bb45')}"`);
    text = text.replace(' </rdf:RDF>', `  <photoshop:Thing rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:City="${C('XMP-TYPEDNODE-CITY-cc56')}"/>\n </rdf:RDF>`);
    add('adv-xmp-hidden-parts.jpg', jpegInsert(baseJpeg('b6.jpg'), xmpSeg(text)), [
      { string: C('XMPCOMMENT-CREATOR-9923'), tier: 'red', location: 'XMP dc:creator' },
      { string: C('XMP-XMLCOMMENT-aa34'), tier: 'red', location: 'XML comment inside rdf:Description holding a name' },
      { string: C('XMP-ABOUT-UUID-bb45'), tier: 'red', location: 'rdf:about="uuid:..." (unique ID, as old Photoshop wrote)' },
      { string: C('XMP-TYPEDNODE-CITY-cc56'), tier: 'red', location: 'photoshop:City on a typed node (rdf:RDF child that is not rdf:Description)' },
    ], 'XMP parts outside the properties the engine reads.');
    const only = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><!-- ${C('XMP-COMMENT-ONLY-dd67')} -->
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="uuid:${C('XMP-ABOUT-ONLY-ee78')}"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    add('adv-xmp-no-properties.jpg', jpegInsert(baseJpeg('b6b.jpg'), xmpSeg(only)), [
      { string: C('XMP-COMMENT-ONLY-dd67'), tier: 'red', location: 'XML comment in an XMP packet with no properties' },
      { string: C('XMP-ABOUT-ONLY-ee78'), tier: 'red', location: 'rdf:about UUID in an XMP packet with no properties' },
    ], 'An XMP packet with no properties at all.');
  }
  // A6c. XMP the engine parses to zero properties although other readers see them: an RDF
  // namespace URI without its final '#', and an xpacket header that is not closed with '?>'.
  {
    const body = `   <dc:creator><rdf:Seq><rdf:li>${C('XMP-RDFNS-CREATOR-0a1b')}</rdf:li></rdf:Seq></dc:creator>`;
    const t1 = XMP(body, 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:City="' + C('XMP-RDFNS-CITY-1b2c') + '"').replace('22-rdf-syntax-ns#', '22-rdf-syntax-ns');
    add('adv-xmp-rdf-namespace-variant.jpg', jpegInsert(baseJpeg('b6c.jpg'), xmpSeg(t1)), [
      { string: C('XMP-RDFNS-CREATOR-0a1b'), tier: 'red', location: 'XMP dc:creator, packet whose rdf namespace URI lacks the final #' },
      { string: C('XMP-RDFNS-CITY-1b2c'), tier: 'red', location: 'XMP photoshop:City, same packet' },
    ], 'An XMP packet with a slightly wrong RDF namespace URI.');
    const t2 = XMP(`   <dc:creator><rdf:Seq><rdf:li>${C('XMP-OPENPI-CREATOR-2c3d')}</rdf:li></rdf:Seq></dc:creator>`, 'xmlns:dc="http://purl.org/dc/elements/1.1/"').replace('W5M0MpCehiHzreSzNTczkc9d"?>', 'W5M0MpCehiHzreSzNTczkc9d"?}');
    add('adv-xmp-unclosed-xpacket.jpg', jpegInsert(baseJpeg('b6d.jpg'), xmpSeg(t2)), [
      { string: C('XMP-OPENPI-CREATOR-2c3d'), tier: 'red', location: 'XMP dc:creator in a packet whose <?xpacket begin ...?> header is not closed' },
    ], 'One damaged byte in the xpacket header makes the scanner skip the whole packet as a processing instruction.');
  }
  // A7. Drone XMP: GPS and serials in a vendor namespace (as DJI writes them).
  {
    const text = XMP('', 'xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Make="Advdrone" drone-dji:GpsLatitude="+59.913912" drone-dji:GpsLongitude="+10.752211" drone-dji:GpsLongtitude="+10.752211" drone-dji:AbsoluteAltitude="+42.37" drone-dji:RelativeAltitude="+30.10" drone-dji:DroneSerialNumber="' + C('DJI-DRONESERIAL-ff89') + '" drone-dji:CameraSerialNumber="' + C('DJI-CAMSERIAL-019a') + '"');
    add('adv-xmp-drone-namespace.jpg', jpegInsert(baseJpeg('b7.jpg'), xmpSeg(text)), [
      { string: '+59.913912', tier: 'red', location: 'XMP drone-dji:GpsLatitude' },
      { string: '+10.752211', tier: 'red', location: 'XMP drone-dji:GpsLongitude / GpsLongtitude' },
      { string: C('DJI-DRONESERIAL-ff89'), tier: 'red', location: 'XMP drone-dji:DroneSerialNumber' },
      { string: C('DJI-CAMSERIAL-019a'), tier: 'red', location: 'XMP drone-dji:CameraSerialNumber' },
    ], 'GPS position and serial numbers in the drone-dji XMP namespace.');
  }
  // A8. Stray bytes between two segments (libjpeg skips them with a warning).
  {
    const base = baseJpeg('b8.jpg');
    const segs = jpegSegments(base);
    const dqt = segs.find((s) => s.marker === 0xdb);
    const junk = Buffer.from(`\x00\x00 Owner: Astrid Holmvik ${C('JUNK-BETWEEN-SEGMENTS-12ab')} \x00`, 'latin1');
    add('adv-junk-between-segments.jpg', cat(base.subarray(0, dqt.start), junk, base.subarray(dqt.start)), [
      { string: C('JUNK-BETWEEN-SEGMENTS-12ab'), tier: 'red', location: 'stray bytes between APP0 and DQT' },
    ], 'Garbage bytes between segments. libjpeg reports "extraneous bytes" and decodes.');
  }
  // A9. DNL segment before SOF (libjpeg skips DNL whatever its length).
  {
    const base = baseJpeg('b9.jpg');
    const segs = jpegSegments(base);
    const dqt = segs.find((s) => s.marker === 0xdb);
    add('adv-dnl-segment.jpg', cat(base.subarray(0, dqt.start), seg(0xdc, `\0\0 ${C('DNL-SEGMENT-23bc')} `), base.subarray(dqt.start)), [
      { string: C('DNL-SEGMENT-23bc'), tier: 'red', location: 'FF DC (DNL) segment with a long payload, before DQT' },
    ], 'A DNL marker segment carrying text.');
  }
  // A10. JFIF APP0 with extra bytes after the header (no thumbnail declared).
  {
    const base = baseJpeg('b10.jpg');
    const segs = jpegSegments(base);
    const app0 = segs.find((s) => s.marker === 0xe0);
    const payload = cat(base.subarray(app0.data, app0.data + 14), ` ${C('JFIF-TRAILING-34cd')} `);
    payload[12] = 0; payload[13] = 0;
    add('adv-jfif-extra-bytes.jpg', cat(base.subarray(0, app0.start), seg(0xe0, payload), base.subarray(app0.end)), [
      { string: C('JFIF-TRAILING-34cd'), tier: 'red', location: 'extra bytes at the end of the JFIF APP0 segment' },
    ], 'JFIF segment longer than its 14-byte header, with no thumbnail declared.');
  }
  // A11. Photoshop APP13 whose IPTC block starts with a stray byte.
  {
    const ds = (rec, n, v) => cat(Buffer.from([0x1c, rec, n]), be16(Buffer.byteLength(v)), v);
    const iptc = cat(Buffer.from([0x20]), ds(2, 80, C('IRB-IPTC-BYLINE-45de')), ds(2, 90, C('IRB-IPTC-CITY-56ef')));
    const res = cat('8BIM', be16(0x0404), Buffer.from([0, 0]), be32(iptc.length), iptc, iptc.length & 1 ? Buffer.from([0]) : Buffer.alloc(0));
    add('adv-app13-unparsed-iptc.jpg', jpegInsert(baseJpeg('b11.jpg'), seg(0xed, cat('Photoshop 3.0\0', res))), [
      { string: C('IRB-IPTC-BYLINE-45de'), tier: 'red', location: 'IPTC By-line in APP13, after one stray byte' },
      { string: C('IRB-IPTC-CITY-56ef'), tier: 'red', location: 'IPTC City in APP13, after one stray byte' },
    ], 'APP13 Photoshop resource 0x0404 whose IPTC data begins with a stray byte.');
  }
  // A12 and A13. A full-size extra image in MPF (disparity type) and a gain map, each with EXIF.
  const mpfFile = (name, second, type, hints, canaries, note) => {
    const primBase = baseJpeg(`mpfbase-${name}`, 96, 64, 21);
    const mpfPayload = (primLen, secLen, secOff) => {
      const entries = cat(le32(0x20030000), le32(primLen), le32(0), le16(0), le16(0), le32(type), le32(secLen), le32(secOff), le16(0), le16(0));
      return cat('MPF\0', tiffLE([{ name: 'ifd0', entries: [
        { tag: 0xb000, type: 7, count: 4, data: Buffer.from('0100') },
        { tag: 0xb001, type: 4, count: 1, data: le32(2) },
        { tag: 0xb002, type: 7, data: entries },
      ] }]));
    };
    const segs = [];
    if (hints) segs.push(xmpSeg(hints));
    const tiffP = tiffLE([{ name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Advcam' }] }]);
    segs.push(exifSeg(tiffP));
    const build = (primLen, secOff) => jpegInsert(primBase, ...segs, seg(0xe2, mpfPayload(primLen, second.length, secOff)));
    let prim = build(0, 0);
    const mpfBase = (() => { const s = jpegSegments(prim).find((x) => x.marker === 0xe2 && prim.toString('latin1', x.data, x.data + 4) === 'MPF\0'); return s.data + 4; })();
    prim = build(prim.length, prim.length - mpfBase);
    add(name, cat(prim, second), canaries, note);
  };
  {
    const tiffS = tiffLE([
      { name: 'ifd0', entries: [{ tag: 0x013b, type: 2, data: C('MPF-EXTRA-ARTIST-67f0') }, { tag: 0x8825, type: 4, ptr: 'gps' }] },
      { name: 'gps', entries: GPS_ENTRIES(C('MPF-EXTRA-GPSAREA-7801')) },
    ]);
    const second = jpegInsert(baseJpeg('mpf2.jpg', 128, 96, 22), exifSeg(tiffS));
    mpfFile('adv-mpf-extra-image.jpg', second, 0x020002, null, [
      { string: C('MPF-EXTRA-ARTIST-67f0'), tier: 'red', location: 'EXIF Artist inside a second full image listed by MPF (type 0x020002, disparity)' },
      { string: C('MPF-EXTRA-GPSAREA-7801'), tier: 'red', location: 'EXIF GPS inside that second image' },
    ], 'A second, larger picture (could be the uncropped original) listed in MPF, carrying its own EXIF.');
  }
  {
    const tiffG = tiffLE([
      { name: 'ifd0', entries: [{ tag: 0x013b, type: 2, data: C('GAINMAP-EXIF-ARTIST-8912') }, { tag: 0x8825, type: 4, ptr: 'gps' }] },
      { name: 'gps', entries: GPS_ENTRIES(C('GAINMAP-EXIF-GPSAREA-9a23')) },
    ]);
    const gm = jpegInsert(magickTo(advPath('gm.jpg'), ['-seed', '23', '-size', '48x32', 'plasma:fractal', '-colorspace', 'Gray', '-strip', '-quality', '80']),
      seg(0xe2, cat('urn:iso:std:iso:ts:21496:-1\0', Buffer.from([0, 0, 0, 0]))), exifSeg(tiffG));
    const hints = XMP('', 'xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"');
    mpfFile('adv-gainmap-with-exif.jpg', gm, 0x000000, hints, [
      { string: C('GAINMAP-EXIF-ARTIST-8912'), tier: 'red', location: 'EXIF Artist inside the HDR gain map JPEG' },
      { string: C('GAINMAP-EXIF-GPSAREA-9a23'), tier: 'red', location: 'EXIF GPS inside the HDR gain map JPEG' },
    ], 'An Ultra HDR style gain map that carries its own EXIF with GPS and Artist.');
  }
  // A14. A kept (amber) unknown tag whose value covers the GPS directory and its values.
  {
    const gps = GPS_ENTRIES(C('OVERLAP-GPSAREA-ab34'));
    const pre = tiffLE([
      { name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Advcam' }, { tag: 0x8825, type: 4, ptr: 'gps' }, { tag: 0xbeef, type: 7, count: 4, raw: 0 }] },
      { name: 'gps', entries: gps },
    ]);
    // Point 0xBEEF at the GPS directory and make it run to the end of the block.
    const gpsAt = pre.readUInt32LE(8 + 2 + 1 * 12 + 8);
    const t = Buffer.from(pre);
    const e = 8 + 2 + 2 * 12;
    t.writeUInt32LE(t.length - gpsAt, e + 4);
    t.writeUInt32LE(gpsAt, e + 8);
    add('adv-kept-tag-overlaps-gps.jpg', jpegInsert(baseJpeg('b14.jpg'), exifSeg(t)), [
      { string: C('OVERLAP-GPSAREA-ab34'), tier: 'red', location: 'GPSAreaInformation whose bytes are also covered by a kept unknown tag 0xBEEF' },
    ], 'An unknown tag (amber, kept by the red-only scrub) whose value range overlaps the GPS directory.');
  }
  // A15. C2PA manifest with a stds.exif assertion holding a GPS position and a creator.
  {
    const box = (type, ...parts) => { const body = cat(...parts); return cat(be32(8 + body.length), type, body); };
    const jumd = (label, uuidHex = '6332706100110010800000aa00389b71') => box('jumd', Buffer.from(uuidHex, 'hex'), Buffer.from([3]), `${label}\0`);
    const json = JSON.stringify({ '@context': { exif: 'http://ns.adobe.com/exif/1.0/' }, 'exif:GPSLatitude': '59,54.8346N', 'exif:GPSLongitude': '10,45.1320E', 'exif:BodySerialNumber': C('C2PA-STDSEXIF-SERIAL-bc45') });
    const assertion = box('jumb', jumd('stds.exif', '6a736f6e00110010800000aa00389b71'), box('json', json));
    const store = box('jumb', jumd('c2pa.assertions', '63326173001100108000' + '00aa00389b71'), assertion);
    const manifest = box('jumb', jumd('urn:uuid:00000000-0000-4000-8000-000000000001', '63326d61001100108000' + '00aa00389b71'), store);
    const top = box('jumb', jumd('c2pa'), manifest);
    const app11 = seg(0xeb, cat('JP', be16(1), be32(1), top));
    add('adv-c2pa-stds-exif.jpg', jpegInsert(baseJpeg('b15.jpg'), app11), [
      { string: '59,54.8346N', tier: 'red', location: 'C2PA stds.exif assertion: exif:GPSLatitude' },
      { string: C('C2PA-STDSEXIF-SERIAL-bc45'), tier: 'red', location: 'C2PA stds.exif assertion: exif:BodySerialNumber' },
    ], 'Content Credentials whose EXIF assertion repeats the GPS position and serial number.');
  }

  // A16. A maker note whose own directory points at a serial number stored after it.
  {
    const serial = Buffer.from(`${C('MAKERNOTE-OUTSIDE-SERIAL-cd56')}\0`);
    // Layout: header 8, IFD0 (2 entries) 30 bytes at 8, Exif IFD (1 entry) 18 bytes at 38,
    // maker note (an IFD with 1 entry, 18 bytes) at 56, serial at 74.
    const t = Buffer.alloc(74 + serial.length);
    t.write('II', 0, 'latin1'); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
    t.writeUInt16LE(2, 8);
    t.writeUInt16LE(0x010f, 10); t.writeUInt16LE(2, 12); t.writeUInt32LE(4, 14); t.write('Adv\0', 18, 'latin1');
    t.writeUInt16LE(0x8769, 22); t.writeUInt16LE(4, 24); t.writeUInt32LE(1, 26); t.writeUInt32LE(38, 30);
    t.writeUInt32LE(0, 34);
    t.writeUInt16LE(1, 38);
    t.writeUInt16LE(0x927c, 40); t.writeUInt16LE(7, 42); t.writeUInt32LE(18, 44); t.writeUInt32LE(56, 48);
    t.writeUInt32LE(0, 52);
    t.writeUInt16LE(1, 56);
    t.writeUInt16LE(0x000c, 58); t.writeUInt16LE(2, 60); t.writeUInt32LE(serial.length, 62); t.writeUInt32LE(74, 66);
    t.writeUInt32LE(0, 70);
    serial.copy(t, 74);
    add('adv-makernote-points-outside.jpg', jpegInsert(baseJpeg('b16.jpg'), exifSeg(t)), [
      { string: C('MAKERNOTE-OUTSIDE-SERIAL-cd56'), tier: 'red', location: 'serial number referenced by the maker note directory but stored after the maker note block' },
    ], 'Canon-style maker note (offsets from the TIFF header) whose value lies outside its declared size.');
  }
  // A17. Orphan bytes inside the EXIF block (a value an earlier editor unlinked but left).
  {
    const tiff = tiffLE([{ name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Advcam' }, { tag: 0x0132, type: 2, data: '2025:03:04 05:06:07' }] }]);
    const orphan = Buffer.from(`GPS 59.913912 10.752211 Astrid Holmvik ${C('EXIF-ORPHAN-BYTES-de67')}\0`);
    add('adv-exif-orphan-bytes.jpg', jpegInsert(baseJpeg('b17.jpg'), exifSeg(cat(tiff, orphan))), [
      { string: C('EXIF-ORPHAN-BYTES-de67'), tier: 'red', location: 'bytes inside the EXIF block that no tag references (left behind by an earlier editor)' },
    ], 'Unreferenced bytes at the end of the EXIF block.');
  }
  // A18. XMP properties in namespaces the engine does not map, written by real software.
  {
    const ns = 'xmlns:MicrosoftPhoto="http://ns.microsoft.com/photo/1.0/" xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:digiKam="http://www.digikam.org/ns/1.0/"'
      + ` MicrosoftPhoto:CameraSerialNumber="${C('MSPHOTO-CAMSERIAL-ef78')}" xmpDM:artist="${C('XMPDM-ARTIST-f089')}" xmp:Author="${C('XMP-AUTHOR-019a')}" dc:identifier="${C('DC-IDENTIFIER-12ab')}"`;
    const body = `   <digiKam:TagsList><rdf:Seq><rdf:li>People/${C('DIGIKAM-PERSON-23bc')}</rdf:li></rdf:Seq></digiKam:TagsList>`;
    add('adv-xmp-unmapped-namespaces.jpg', jpegInsert(baseJpeg('b18.jpg'), xmpSeg(XMP(body, ns))), [
      { string: C('MSPHOTO-CAMSERIAL-ef78'), tier: 'red', location: 'XMP MicrosoftPhoto:CameraSerialNumber (Windows Photo Gallery)' },
      { string: C('XMPDM-ARTIST-f089'), tier: 'red', location: 'XMP xmpDM:artist' },
      { string: C('XMP-AUTHOR-019a'), tier: 'red', location: 'XMP xmp:Author' },
      { string: C('DC-IDENTIFIER-12ab'), tier: 'red', location: 'XMP dc:identifier (a unique ID)' },
      { string: C('DIGIKAM-PERSON-23bc'), tier: 'red', location: 'XMP digiKam:TagsList People/<name> (digiKam face tags)' },
    ], 'Names, serials and IDs in XMP namespaces the engine files under "Other XMP data".');
  }
  // A19. The computer name, red since 2026-10-02, in EXIF (UTF-8 type) and in XMP, next to
  // editing software, which stays amber.
  {
    const tiff = tiffLE([{ name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Advcam' }, { tag: 0x0131, type: 2, data: 'Advedit 1.0' }, { tag: 0x013c, type: 129, data: `Åse-Laptop ${C('EXIF-HOSTCOMPUTER-UTF8-34cd')}` }] }]);
    const ns = 'xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmp:CreatorTool="Advedit 1.0"'
      + ` tiff:HostComputer="${C('XMP-HOSTCOMPUTER-45de')}" xmp:ComputerName="${C('XMP-COMPUTERNAME-56ef')}"`;
    add('adv-computer-name.jpg', jpegInsert(baseJpeg('b19.jpg'), exifSeg(tiff), xmpSeg(XMP('', ns))), [
      { string: C('EXIF-HOSTCOMPUTER-UTF8-34cd'), tier: 'red', location: 'EXIF IFD0 HostComputer stored with the UTF-8 type (129)' },
      { string: C('XMP-HOSTCOMPUTER-45de'), tier: 'red', location: 'XMP tiff:HostComputer' },
      { string: C('XMP-COMPUTERNAME-56ef'), tier: 'red', location: 'XMP xmp:ComputerName (judged by its name)' },
    ], 'The name of the computer that saved the file, which often names its owner.');
  }

  // A20 to A27. Free text in green details, which are kept by default: a colour profile's
  // text tags (in every form: Latin-1 desc and text, mluc records in other languages, the
  // Unicode part of a desc tag), a private tag, bytes no tag uses, a profile ID that is not
  // its checksum, and technical XMP fields holding names. Each must be offered as red and go
  // with the red-and-amber selection while the colours stay.
  const icc = ({ tags = [], gap = '', id = null, reserved = null } = {}) => {
    const pad = (d) => cat(d, Buffer.alloc((4 - (d.length % 4)) % 4));
    const xyz = cat('XYZ ', Buffer.alloc(4), be32(0xf6d6), be32(0x10000), be32(0xd32d));
    const all = [...tags, ['wtpt', xyz]];
    const body = [];
    const table = [be32(all.length)];
    let at = 128 + 4 + 12 * all.length;
    for (const [sig, d] of all) {
      table.push(Buffer.from(sig, 'latin1'), be32(at), be32(d.length));
      body.push(pad(d));
      at += pad(d).length;
      if (gap && sig === all[0][0]) { body.push(pad(B(gap))); at += pad(B(gap)).length; }
    }
    const head = Buffer.alloc(128);
    head.writeUInt32BE(at, 0); head.writeUInt32BE(0x04200000, 8); head.write('mntrRGB XYZ ', 12, 'latin1'); head.write('acsp', 36, 'latin1');
    head.writeUInt32BE(0xf6d6, 68); head.writeUInt32BE(0x10000, 72); head.writeUInt32BE(0xd32d, 76);
    if (id) B(id).copy(head, 84);
    if (reserved) B(reserved).copy(head, 100);
    return cat(head, ...table, ...body);
  };
  const textTag = (t) => cat('text', Buffer.alloc(4), t, Buffer.from([0]));
  const mlucTag = (records) => {
    const strs = records.map(([, t]) => Buffer.from(t, 'utf16le').swap16());
    let off = 16 + 12 * records.length;
    const head = [Buffer.from('mluc'), Buffer.alloc(4), be32(records.length), be32(12)];
    records.forEach(([lang], i) => { head.push(Buffer.from(lang, 'latin1'), be32(strs[i].length), be32(off)); off += strs[i].length; });
    return cat(...head, ...strs);
  };
  const descTag = (ascii, unicode = '') => {
    const u = Buffer.from(unicode, 'utf16le').swap16();
    return cat('desc', Buffer.alloc(4), be32(ascii.length + 1), ascii, Buffer.from([0]), be32(unicode ? 0x656e5553 : 0), be32(unicode ? unicode.length : 0), u, Buffer.alloc(3 + 67));
  };
  const iccSeg = (profile) => seg(0xe2, cat('ICC_PROFILE\0', Buffer.from([1, 1]), profile));
  {
    add('adv-icc-copyright-name.jpg', jpegInsert(baseJpeg('b20.jpg'), iccSeg(icc({ tags: [['desc', descTag('sRGB IEC61966-2.1')], ['cprt', textTag(`Copyright Astrid Holmvik ${C('ICC-CPRT-67a0')}`)], ['dmnd', textTag(`Astrid Holmvik ${C('ICC-DMND-78b1')}`)]] }))), [
      { string: C('ICC-CPRT-67a0'), tier: 'red', location: "the photo's colour profile, copyright text tag" },
      { string: C('ICC-DMND-78b1'), tier: 'red', location: "the photo's colour profile, device maker text tag" },
    ], "Names in the text tags of the photo's own colour profile, which is green and kept.");
    add('adv-icc-mluc-record.jpg', jpegInsert(baseJpeg('b21.jpg'), iccSeg(icc({ tags: [['desc', mlucTag([['enUS', 'Display P3'], ['nbNO', `Astrid Holmvik ${C('ICC-MLUC-NB-89c2')}`]])], ['cprt', mlucTag([['enUS', 'Copyright Apple Inc., 2017']])]] }))), [
      { string: C('ICC-MLUC-NB-89c2'), tier: 'red', location: 'a second language record of the profile description (mluc, UTF-16)' },
    ], 'A well-known profile name in English, and a name in its Norwegian record.');
    add('adv-icc-desc-unicode.jpg', jpegInsert(baseJpeg('b22.jpg'), iccSeg(icc({ tags: [['desc', descTag('sRGB IEC61966-2.1', `Astrid ${C('ICC-DESC-UNI-9ad3')}`)]] }))), [
      { string: C('ICC-DESC-UNI-9ad3'), tier: 'red', location: 'the Unicode part of a version 2 desc tag whose ASCII part is a known name' },
    ], 'Most readers show only the ASCII part of a desc tag.');
    add('adv-icc-private-tags.jpg', jpegInsert(baseJpeg('b23.jpg'), iccSeg(icc({ tags: [['desc', descTag('sRGB')], ['ZZZZ', cat('curv', Buffer.alloc(4), be32(24), `Astrid Holmvik ${C('ICC-CURV-ab14')}`)], ['CNRY', textTag(C('ICC-PRIVATE-TEXT-bc25'))]] }))), [
      { string: C('ICC-CURV-ab14'), tier: 'red', location: 'a private tag of a colour type (curv) holding a name' },
      { string: C('ICC-PRIVATE-TEXT-bc25'), tier: 'red', location: 'a private text tag' },
    ], 'Tags no colour engine reads.');
    add('adv-icc-gap-and-id.jpg', jpegInsert(baseJpeg('b24.jpg'), iccSeg(icc({ tags: [['desc', descTag('sRGB')]], gap: `Astrid Holmvik ${C('ICC-GAP-cd36')}`, id: 'CANARY-ADV-IDde4', reserved: C('ICC-RESV-ef58') }))), [
      { string: C('ICC-GAP-cd36'), tier: 'red', location: 'bytes between two tags that no tag uses' },
      { string: 'CANARY-ADV-IDde4', tier: 'red', location: 'the 16-byte profile ID, which is not the profile checksum' },
      { string: C('ICC-RESV-ef58'), tier: 'red', location: 'the reserved header bytes 100 to 127' },
    ], 'Places in a colour profile that are neither text nor colour.');
    const ns = 'xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" xmlns:exif="http://ns.adobe.com/exif/1.0/"'
      + ` xmp:Rating="Astrid ${C('XMP-RATING-TEXT-f069')}" photoshop:ICCProfile="Astrid Holmvik ${C('XMP-ICCPROFILE-NAME-017a')}" photoshop:ColorMode="3" GPano:PoseHeadingDegrees="${C('GPANO-HEADING-128b')}" exif:FNumber="19/10"`;
    const body = `   <exif:Flash rdf:parseType="Resource"><exif:Fired>False</exif:Fired><exif:Owner>Astrid Holmvik ${C('EXIF-FLASH-CHILD-239c')}</exif:Owner></exif:Flash>\n   <GPano:Note>${C('GPANO-NOTE-34ad')}</GPano:Note>`;
    add('adv-xmp-technical-text.jpg', jpegInsert(baseJpeg('b25.jpg'), xmpSeg(XMP(body, ns))), [
      { string: C('XMP-RATING-TEXT-f069'), tier: 'red', location: 'XMP xmp:Rating holding text' },
      { string: C('XMP-ICCPROFILE-NAME-017a'), tier: 'red', location: 'XMP photoshop:ICCProfile holding a name, not a known profile name' },
      { string: C('GPANO-HEADING-128b'), tier: 'red', location: 'XMP GPano:PoseHeadingDegrees holding text' },
      { string: C('EXIF-FLASH-CHILD-239c'), tier: 'red', location: 'an unknown field inside the exif:Flash structure' },
      { string: C('GPANO-NOTE-34ad'), tier: 'red', location: 'XMP GPano:Note, a field the photo sphere specification does not define' },
    ], 'Technical XMP fields are green and kept, so they may hold only numbers and fixed words.');
    // Technical EXIF fields: text in a numeric field, the free-text field the specification
    // allows, a block that carries names, and the interop file format text.
    const tiff = tiffLE([
      { name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Advcam' }, { tag: 0x8769, type: 4, ptr: 'exif' }] },
      { name: 'exif', entries: [
        { tag: 0x829d, type: 2, data: `Astrid ${C('EXIF-FNUMBER-TEXT-45be')}` },
        { tag: 0x8824, type: 2, data: `Astrid Holmvik ${C('EXIF-SPECTRAL-56cf')}` },
        { tag: 0x9000, type: 7, count: 4, data: Buffer.from('0232') },
        { tag: 0xa40b, type: 7, data: Buffer.from(`\0\0\0\0Astrid Holmvik ${C('EXIF-DEVICESETTING-67d0')}`) },
        { tag: 0xa005, type: 4, ptr: 'interop' },
      ] },
      { name: 'interop', entries: [{ tag: 0x0001, type: 2, data: 'R98' }, { tag: 0x1000, type: 2, data: `Astrid ${C('EXIF-INTEROP-FORMAT-78e1')}` }] },
    ]);
    add('adv-exif-technical-text.jpg', jpegInsert(baseJpeg('b26.jpg'), exifSeg(tiff)), [
      { string: C('EXIF-FNUMBER-TEXT-45be'), tier: 'red', location: 'EXIF FNumber written as text' },
      { string: C('EXIF-SPECTRAL-56cf'), tier: 'red', location: 'EXIF SpectralSensitivity (free text by the specification)' },
      { string: C('EXIF-DEVICESETTING-67d0'), tier: 'red', location: 'EXIF DeviceSettingDescription (a block of names)' },
      { string: C('EXIF-INTEROP-FORMAT-78e1'), tier: 'red', location: 'EXIF Interop RelatedImageFileFormat (free text)' },
    ], 'Technical EXIF fields are green and kept, so they may hold only numbers and their defined forms.');
  }

  // PNG ---------------------------------------------------------------------------------
  const pngChunk = (type, data) => { const d = B(data); const tc = cat(type, d); return cat(be32(d.length), tc, be32(zlib.crc32(tc))); };
  const pngBase = (name, seed) => { sh('magick', ['-seed', String(seed), '-size', '64x48', 'plasma:fractal', '-strip', `PNG24:${advPath(name)}`]); return readFileSync(advPath(name)); };
  const pngSplit = (png) => { const ch = pngChunks(png); const iend = ch.find((c) => c.type === 'IEND'); return { head: png.subarray(0, iend.start), iend: png.subarray(iend.start, iend.end) }; };
  {
    const { head } = pngSplit(pngBase('p1.png', 31));
    const data = Buffer.from(`Author: ${C('PNG-IEND-DATA-cd56')}`);
    add('adv-png-iend-with-data.png', cat(head, pngChunk('IEND', data)), [
      { string: C('PNG-IEND-DATA-cd56'), tier: 'red', location: 'data inside the IEND chunk (length not zero)' },
    ], 'An IEND chunk that carries data.');
  }
  {
    const { head, iend } = pngSplit(pngBase('p2.png', 32));
    const bad = cat(be32(4), 'tE1t', 'abcd', be32(0));
    add('adv-png-bad-chunk-type.png', cat(head, bad, pngChunk('tEXt', cat('Author\0', `Astrid Holmvik ${C('PNG-AFTER-BADTYPE-AUTHOR-de67')}`)), iend), [
      { string: C('PNG-AFTER-BADTYPE-AUTHOR-de67'), tier: 'red', location: 'tEXt Author after a chunk with an invalid type name' },
    ], 'A chunk with a digit in its type after IDAT; the next chunks are never walked.');
  }
  {
    const { head } = pngSplit(pngBase('p3.png', 33));
    const text = pngChunk('tEXt', cat('Author\0', `Astrid Holmvik ${C('PNG-TRUNC-AUTHOR-ef78')} and a little more text`));
    add('adv-png-truncated-in-text.png', cat(head, text.subarray(0, text.length - 12)), [
      { string: C('PNG-TRUNC-AUTHOR-ef78'), tier: 'red', location: 'tEXt Author after IDAT, file cut short inside that chunk (no IEND)' },
    ], 'An incomplete download: the picture data is whole but the file stops inside a text chunk.');
  }
  {
    const { head, iend } = pngSplit(pngBase('p4.png', 34));
    add('adv-png-location-text.png', cat(head, pngChunk('tEXt', cat('Location\0', `Kirkegata 1, Oslo ${C('PNG-LOCATION-TEXT-f089')}`)), pngChunk('tEXt', cat('GPSLatitude\0', '59.913912')), iend), [
      { string: C('PNG-LOCATION-TEXT-f089'), tier: 'red', location: 'tEXt with keyword "Location" (a street address)' },
      { string: '59.913912', tier: 'red', location: 'tEXt with keyword "GPSLatitude"' },
    ], 'Plain text chunks whose keywords say they hold a place.');
  }
  {
    const { head, iend } = pngSplit(pngBase('p7.png', 39));
    add('adv-png-host-computer-text.png', cat(head, pngChunk('tEXt', cat('Host Computer\0', `Astrid-Laptop ${C('PNG-HOSTCOMPUTER-TEXT-67f0')}`)), pngChunk('tEXt', cat('Software\0', 'Advedit 1.0')), iend), [
      { string: C('PNG-HOSTCOMPUTER-TEXT-67f0'), tier: 'red', location: 'tEXt with keyword "Host Computer"' },
    ], 'A plain text chunk whose keyword says it holds the computer name.');
  }
  {
    // An iCCP chunk before the picture data whose profile name is a name, and whose profile
    // holds one in its copyright (compressed, so only an inflate finds it).
    const png = pngBase('p8.png', 41);
    const ihdr = pngChunks(png).find((c) => c.type === 'IHDR');
    const prof = icc({ tags: [['desc', descTag('sRGB IEC61966-2.1')], ['cprt', textTag(`Copyright Astrid Holmvik ${C('PNG-ICCP-CPRT-45be')}`)]] });
    const iccp = pngChunk('iCCP', cat(`Astrid ${C('PNG-ICCP-NAME-56cf')}`, Buffer.from([0, 0]), zlib.deflateSync(prof)));
    add('adv-png-iccp-name.png', cat(png.subarray(0, ihdr.end), iccp, png.subarray(ihdr.end)), [
      { string: C('PNG-ICCP-NAME-56cf'), tier: 'red', location: 'iCCP profile name' },
      { string: C('PNG-ICCP-CPRT-45be'), tier: 'red', location: 'iCCP profile (compressed), copyright text tag' },
    ], 'A colour profile chunk whose name and copyright are names.');
  }
  {
    // Colour and display chunks are green: one longer than its size with a name after the
    // numbers, a pCAL whose calibration name is a name, and an exif: text copy holding text.
    const png = pngBase('p9.png', 43);
    const ihdr = pngChunks(png).find((c) => c.type === 'IHDR');
    const extra = cat(pngChunk('gAMA', cat(Buffer.from([0, 0, 0xb1, 0x8f]), `Astrid ${C('PNG-GAMA-TAIL-89f2')}`)),
      pngChunk('pCAL', cat(`Astrid ${C('PNG-PCAL-NAME-9a03')}`, Buffer.alloc(13))),
      pngChunk('tEXt', cat('exif:ExposureTime\0', `Holmvik ${C('PNG-EXIFTEXT-EXPOSURE-ab14')}`)));
    add('adv-png-green-chunks.png', cat(png.subarray(0, ihdr.end), extra, png.subarray(ihdr.end)), [
      { string: C('PNG-GAMA-TAIL-89f2'), tier: 'red', location: 'gAMA chunk longer than its four bytes' },
      { string: C('PNG-PCAL-NAME-9a03'), tier: 'red', location: 'pCAL calibration name' },
      { string: C('PNG-EXIFTEXT-EXPOSURE-ab14'), tier: 'red', location: 'tEXt exif:ExposureTime (an ImageMagick copy) holding text' },
    ], 'Green PNG chunks must have the size and form the specification gives.');
  }
  {
    const t1 = baseJpeg('pt1.jpg', 40, 30, 35, C('PNG-EXIF-IFD1-COM-019b'));
    const t2 = baseJpeg('pt2.jpg', 64, 48, 36, C('PNG-EXIF-IFD2-COM-12ac'));
    const tiff = tiffLE([
      { name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Advcam' }], next: 'ifd1' },
      { name: 'ifd1', entries: [{ tag: 0x0201, type: 4, blob: 't1' }, { tag: 0x0202, type: 4, count: 1, data: le32(t1.length) }], next: 'ifd2' },
      { name: 'ifd2', entries: [{ tag: 0x0201, type: 4, blob: 't2' }, { tag: 0x0202, type: 4, count: 1, data: le32(t2.length) }] },
    ], { t1, t2 });
    const png = pngBase('p5.png', 37);
    const ihdr = pngChunks(png)[0];
    add('adv-png-exif-ifd2.png', cat(png.subarray(0, ihdr.end), pngChunk('eXIf', tiff), png.subarray(ihdr.end)), [
      { string: C('PNG-EXIF-IFD1-COM-019b'), tier: 'red', location: 'eXIf IFD1 thumbnail' },
      { string: C('PNG-EXIF-IFD2-COM-12ac'), tier: 'red', location: 'eXIf IFD2 preview chained after IFD1' },
    ], 'eXIf with a second preview directory.');
  }
  {
    const png = pngBase('p6.png', 38);
    const ihdr = pngChunks(png)[0];
    const xmp = XMP(`   <dc:creator><rdf:Seq><rdf:li>${C('PNG-XMP-CREATOR-23bd')}</rdf:li></rdf:Seq></dc:creator>
   <!-- ${C('PNG-XMP-COMMENT-34ce')} -->`, 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Advedit 1.0"');
    add('adv-png-xmp-comment.png', cat(png.subarray(0, ihdr.end), pngChunk('iTXt', cat('XML:com.adobe.xmp\0', Buffer.from([0, 0, 0, 0]), Buffer.from(xmp, 'utf8'))), png.subarray(ihdr.end)), [
      { string: C('PNG-XMP-CREATOR-23bd'), tier: 'red', location: 'iTXt XMP dc:creator' },
      { string: C('PNG-XMP-COMMENT-34ce'), tier: 'red', location: 'iTXt XMP, XML comment' },
    ], 'PNG XMP packet with an XML comment.');
  }

  // WebP --------------------------------------------------------------------------------
  {
    sh('magick', ['-seed', '41', '-size', '64x48', 'plasma:fractal', '-strip', '-define', 'webp:lossless=true', advPath('w1-base.webp')]);
    const w = readFileSync(advPath('w1-base.webp'));
    const vp8l = w.subarray(12);
    const tiff = tiffLE([{ name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Advcam' }, { tag: 0x013b, type: 2, data: C('WEBP-BROKEN-EXIF-ARTIST-45df') }] }]);
    const vp8x = cat('VP8X', le32(10), Buffer.from([0x08, 0, 0, 0]), Buffer.from([63, 0, 0, 47, 0, 0]));
    const exif = cat('EXIF', le32(tiff.length + 50), tiff);
    const body = cat('WEBP', vp8x, vp8l, exif);
    add('adv-webp-truncated-exif.webp', cat('RIFF', le32(body.length), body), [
      { string: C('WEBP-BROKEN-EXIF-ARTIST-45df'), tier: 'red', location: 'EXIF chunk at the end whose size field claims 50 more bytes than exist' },
    ], 'An incomplete download: the last chunk (EXIF) is cut short.');
  }

  // HEIC --------------------------------------------------------------------------------
  {
    sh('magick', ['-seed', '51', '-size', '64x48', 'plasma:fractal', '-strip', '-depth', '8', advPath('h-base.heic')]);
    const prim = extractHeic(readFileSync(advPath('h-base.heic')));
    const box = (type, ...parts) => { const body = cat(...parts); return cat(be32(8 + body.length), type, body); };
    const fullbox = (type, v, flags, ...parts) => box(type, Buffer.from([v, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
    const xmpText = XMP(`   <dc:creator><rdf:Seq><rdf:li>${C('HEIC-UUIDXMP-CREATOR-56e0')}</rdf:li></rdf:Seq></dc:creator>`, 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="59,54.8346N"');
    const xmpUuid = box('uuid', Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex'), Buffer.from(xmpText, 'utf8'));
    const cmt1 = tiffLE([{ name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Canon' }, { tag: 0x013b, type: 2, data: C('HEIC-CANON-CMT1-ARTIST-67f1') }] }]);
    const cmt4 = tiffLE([{ name: 'ifd0', entries: GPS_ENTRIES(C('HEIC-CANON-CMT4-GPSAREA-7802')) }]);
    const canon = box('uuid', Buffer.from('85c0b687820f11e08111f4ce462b6a48', 'hex'), box('CMT1', cmt1), box('CMT4', cmt4));
    const free = box('free', `old metadata: ${C('HEIC-FREEBOX-LEFTOVER-8913')}`);
    const udes = fullbox('udes', 0, 0, 'en-GB\0', `${C('HEIC-UDES-NAME-9a24')}\0`, 'Picnic at Astrid Holmvik house\0', 'family\0');
    const extraJpeg = jpegInsert(baseJpeg('hx.jpg', 64, 48, 52), exifSeg(tiffLE([{ name: 'ifd0', entries: [{ tag: 0x013b, type: 2, data: C('HEIC-EXTRA-JPEG-ARTIST-ab35') }] }])));
    const ispe = fullbox('ispe', 0, 0, be32(64), be32(48));
    const h = heicBuild({ prim, items: [{ id: 2, type: 'jpeg', data: extraJpeg }], extraProps: [{ box: udes, essential: false }, { box: ispe, essential: false, item: 2 }], top: [xmpUuid, canon, free] });
    add('adv-heic-hidden-boxes.heic', h, [
      { string: C('HEIC-UUIDXMP-CREATOR-56e0'), tier: 'red', location: 'top-level uuid box with the XMP UUID (be7acfcb...)' },
      { string: '59,54.8346N', tier: 'red', location: 'GPS latitude in that top-level XMP uuid box' },
      { string: C('HEIC-CANON-CMT1-ARTIST-67f1'), tier: 'red', location: 'Canon-style uuid box (85c0b687...), CMT1 IFD0 Artist' },
      { string: C('HEIC-CANON-CMT4-GPSAREA-7802'), tier: 'red', location: 'Canon-style uuid box, CMT4 GPS' },
      { string: C('HEIC-FREEBOX-LEFTOVER-8913'), tier: 'red', location: 'top-level free box with leftover text' },
      { string: C('HEIC-UDES-NAME-9a24'), tier: 'red', location: 'udes (user description) item property on the primary picture' },
      { string: C('HEIC-EXTRA-JPEG-ARTIST-ab35'), tier: 'red', location: 'an extra jpeg image item that nothing references, with its own EXIF' },
    ], 'HEIC with metadata in places other than Exif and mime items.');

    // A68 to A71 (0.0.3, decisions 4 and 5). An iPhone-style HDR HEIC: a gain map attached
    // with auxl and named by auxC exactly as Apple names it, its own XMP, and Apple's
    // MakerNote with the two HDR numbers and a text plant. The default (red only) and the
    // red-and-amber selection must keep the gain map attached and the HDR numbers readable
    // (checked after evaluate), and remove the rest. Then the same file with a name that is
    // not exactly Apple's, and with bytes after the name: those layers are red and go.
    sh('magick', ['-size', '32x24', 'gradient:gray20-gray90', '-depth', '8', advPath('h-gain.heic')]);
    const gainPic = extractHeic(readFileSync(advPath('h-gain.heic')));
    const APPLE_AUX = 'urn:com:apple:photo:2020:aux:hdrgainmap';
    const appleHeic = (auxName, auxTail = Buffer.alloc(0), gainExtra = '') => {
      const mn = appleNote(C('HEIC-APPLE-NOTE-b6c7'));
      const exifTiff = tiffLE([
        { name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Apple' }, { tag: 0x8769, type: 4, ptr: 'exif' }] },
        { name: 'exif', entries: [{ tag: 0x927c, type: 7, data: mn }, { tag: 0x9003, type: 2, data: '2025:03:04 05:06:07' }] },
      ]);
      const photoXmp = XMP(`   <dc:creator><rdf:Seq><rdf:li>${C('HEIC-PHOTO-CREATOR-c7d8')}</rdf:li></rdf:Seq></dc:creator>\n   <xmp:CreateDate>2025-03-04T05:06:07</xmp:CreateDate>`, 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"') + ' '.repeat(3000);
      const gainXmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 6.0.0">\n   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n      <rdf:Description rdf:about=""\n            xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/">\n         <HDRGainMap:HDRGainMapVersion>65536</HDRGainMap:HDRGainMapVersion>${gainExtra}\n      </rdf:Description>\n   </rdf:RDF>\n</x:xmpmeta>\n`;
      const auxC = fullbox('auxC', 0, 0, `${auxName}\0`, auxTail);
      return heicBuild({
        prim,
        items: [
          { id: 2, type: 'Exif', data: cat(be32(6), 'Exif\0\0', exifTiff), hidden: true },
          { id: 3, type: 'mime', contentType: 'application/rdf+xml', data: Buffer.from(photoXmp, 'utf8'), hidden: true },
          { id: 4, type: 'hvc1', data: gainPic.data, hidden: true },
          { id: 5, type: 'mime', contentType: 'application/rdf+xml', data: Buffer.from(gainXmp, 'utf8'), hidden: true },
        ],
        extraProps: [...gainPic.props.map((x) => ({ box: x.box, essential: x.essential, item: 4 })), { box: auxC, essential: false, item: 4 }],
        refs: [['auxl', 4, 1], ['cdsc', 2, 1], ['cdsc', 3, 1], ['cdsc', 5, 4]],
      });
    };
    const appleRows = [
      { string: C('HEIC-APPLE-NOTE-b6c7'), tier: 'red', location: "text in Apple's MakerNote next to the two HDR numbers (EXIF item)" },
      { string: C('HEIC-PHOTO-CREATOR-c7d8'), tier: 'red', location: "dc:creator in the photo's XMP item" },
    ];
    add('adv-heic-apple-hdr.heic', appleHeic(APPLE_AUX, Buffer.alloc(0), `\n         <HDRGainMap:Note>${C('HEIC-GAIN-XMP-d8e9')}</HDRGainMap:Note>`), [
      ...appleRows,
      { string: C('HEIC-GAIN-XMP-d8e9'), tier: 'red', location: "a field the gain map does not need in the gain map's own XMP item" },
    ], 'An iPhone-style HDR HEIC: the gain map and the HDR numbers must stay, everything else planted must go.', { appleHdr: true });
    add('adv-heic-aux-name.heic', appleHeic(`${APPLE_AUX} ${C('HEIC-AUX-NAME-e9fa')}`), [
      ...appleRows,
      { string: C('HEIC-AUX-NAME-e9fa'), tier: 'red', location: "the auxC name of the auxiliary image: Apple's name with text after it" },
    ], 'An auxiliary image whose name is not exactly a known one.', { auxGone: true });
    add('adv-heic-aux-tail.heic', appleHeic(APPLE_AUX, Buffer.from(C('HEIC-AUX-TAIL-fa0b'), 'latin1')), [
      ...appleRows,
      { string: C('HEIC-AUX-TAIL-fa0b'), tier: 'red', location: "bytes after the NUL that ends Apple's auxC name" },
    ], "Apple's gain map name followed by bytes Apple never writes.", { auxGone: true });
  }
  // A30 to A51. Data hidden in what travels with an HDR gain map, built on the corpus Ultra
  // HDR picture: extra fields in the hdrgm, HDRGainMap and Container XMP namespaces (in the
  // photo and inside the gain map), known names with values of the wrong form, the tail and
  // extra tags of the MPF index, ISO 21496-1 segments longer than their structure, an index
  // and an ISO segment inside the gain map, and bytes (or a whole picture) after the gain
  // map's end marker. The red-and-amber selection keeps the gain map, and all of this must still
  // go with it, while the gain map stays and renders.
  {
    const srcFile = join(FIXTURES, 'jpeg-ultrahdr-like.jpg');
    if (existsSync(srcFile)) {
      const ultra = readFileSync(srcFile);
      const isXmp = (b, s) => s.marker === 0xe1 && b.toString('latin1', s.data, s.data + 29) === 'http://ns.adobe.com/xap/1.0/\0';
      const isMpf = (b, s) => s.marker === 0xe2 && b.toString('latin1', s.data, s.data + 4) === 'MPF\0';
      const mpfOf = (b) => {
        const s = jpegSegments(b).find((x) => isMpf(b, x));
        const t = s.data + 4;
        const le = b.toString('latin1', t, t + 2) === 'II';
        const r16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
        const r32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
        const ifd = t + r32(t + 4);
        for (let i = 0; i < r16(ifd); i++) {
          const e = ifd + 2 + i * 12;
          if (r16(e) === 0xb002) return { base: t, le, table: t + r32(e + 8), r32 };
        }
        throw new Error('no MP entry table');
      };
      // Rewrites one segment's payload.
      const editSeg = (b, pick, fn) => {
        const s = jpegSegments(b).find((x) => pick(b, x));
        return cat(b.subarray(0, s.start), seg(s.marker, fn(b.subarray(s.data, s.end))), b.subarray(s.end));
      };
      const swap = (old, neu) => (payload) => {
        const t = payload.toString('latin1');
        if (!t.includes(old)) throw new Error(`not found: ${old}`);
        return Buffer.from(t.replace(old, neu), 'latin1');
      };
      // Splits at the second MP entry and puts the picture back together with a fresh table.
      const m0 = mpfOf(ultra);
      const gmAt = m0.base + m0.r32(m0.table + 16 + 8);
      const prim0 = ultra.subarray(0, gmAt);
      const gm0 = ultra.subarray(gmAt);
      const join2 = (prim, gm, tail = '') => {
        const out = Buffer.from(prim);
        const m = mpfOf(out);
        const w32 = (o, v) => (m.le ? out.writeUInt32LE(v, o) : out.writeUInt32BE(v, o));
        w32(m.table + 4, out.length);
        w32(m.table + 16 + 4, gm.length + B(tail).length);
        w32(m.table + 16 + 8, out.length - m.base);
        return cat(out, gm, tail);
      };
      const creator = /<dc:creator>[\s\S]*?<\/dc:creator>/;
      const gmBare = editSeg(gm0, isXmp, (p) => Buffer.from(p.toString('latin1').replace(creator, ''), 'latin1'));
      add('adv-gainmap-hdrgm-extra.jpg', join2(editSeg(prim0, isXmp, swap('hdrgm:Version="1.0"', `hdrgm:Version="1.0" hdrgm:CameraSerialNumber="${C('HDRGM-SERIAL-c1d2')}" hdrgm:GPSLatitude="${C('HDRGM-GPS-d2e3')}"`)), gm0), [
        { string: C('HDRGM-SERIAL-c1d2'), tier: 'red', location: 'unknown hdrgm:CameraSerialNumber in the photo XMP' },
        { string: C('HDRGM-GPS-d2e3'), tier: 'red', location: 'unknown hdrgm:GPSLatitude in the photo XMP' },
      ], 'Ultra HDR picture with extra, non-standard fields in the hdrgm namespace.');
      add('adv-gainmap-container-label.jpg', join2(editSeg(prim0, isXmp, swap('Item:Semantic="GainMap"', `Item:Semantic="GainMap" Item:Label="${C('CONTAINER-LABEL-e3f4')}"`)), gm0), [
        { string: C('CONTAINER-LABEL-e3f4'), tier: 'red', location: 'Item:Label inside the Container:Directory of the photo XMP' },
      ], 'Ultra HDR picture whose Container directory carries a label.');
      add('adv-gainmap-apple-owner.jpg', join2(editSeg(prim0, isXmp, swap('xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"', `xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/" HDRGainMap:HDRGainMapVersion="65536" HDRGainMap:OwnerName="${C('APPLE-GAIN-OWNER-f405')}"`)), gm0), [
        { string: C('APPLE-GAIN-OWNER-f405'), tier: 'red', location: 'unknown HDRGainMap:OwnerName in the photo XMP' },
      ], 'Ultra HDR picture with an Apple HDRGainMap field that is not part of the gain map.');
      add('adv-gainmap-after-eoi.jpg', join2(prim0, editSeg(gmBare, isXmp, swap(' x:xmptk="Fjord XMP Core 1.0"', '')), C('AFTER-GAINMAP-EOI-0516')), [
        { string: C('AFTER-GAINMAP-EOI-0516'), tier: 'red', location: 'bytes after the gain map end marker, inside its MPF size' },
      ], 'A gain map with no metadata of its own and hidden bytes after its end marker.');
      add('adv-gainmap-mpf-tail.jpg', join2(editSeg(prim0, isMpf, (p) => cat(p, C('MPF-TAIL-1627'))), gm0), [
        { string: C('MPF-TAIL-1627'), tier: 'red', location: 'bytes after the MP entry table, at the end of the MPF segment' },
      ], 'MPF segment longer than its index.');
      add('adv-gainmap-inner-hdrgm.jpg', join2(prim0, editSeg(gmBare, isXmp, swap('hdrgm:Version="1.0"', `hdrgm:Version="1.0" hdrgm:CameraSerialNumber="${C('INNER-HDRGM-SERIAL-2738')}"`))), [
        { string: C('INNER-HDRGM-SERIAL-2738'), tier: 'red', location: 'unknown hdrgm:CameraSerialNumber in the gain map XMP' },
      ], 'A gain map whose own XMP has an extra, non-standard hdrgm field.');
      {
        const mpfSeg = jpegSegments(prim0).find((x) => isMpf(prim0, x));
        const iso = seg(0xe2, cat('urn:iso:std:iso:ts:21496:-1\0', Buffer.from([0, 0, 0, 0]), C('ISO-GAIN-SEG-3849')));
        add('adv-gainmap-iso-segment.jpg', join2(cat(prim0.subarray(0, mpfSeg.start), iso, prim0.subarray(mpfSeg.start)), gm0), [
          { string: C('ISO-GAIN-SEG-3849'), tier: 'red', location: 'surplus bytes in an ISO 21496-1 APP2 segment of the photo' },
        ], 'An ISO 21496-1 gain map segment longer than its version field.');
        const iso2 = seg(0xe2, cat('urn:iso:std:iso:ts:21496:-1\0', Buffer.from([0, 0, 0, 0]), C('ISO-SECOND-SEG-a1b2')));
        const isoOk = seg(0xe2, cat('urn:iso:std:iso:ts:21496:-1\0', Buffer.from([0, 0, 0, 0])));
        add('adv-gainmap-iso-second.jpg', join2(cat(prim0.subarray(0, mpfSeg.start), isoOk, iso2, prim0.subarray(mpfSeg.start)), gm0), [
          { string: C('ISO-SECOND-SEG-a1b2'), tier: 'red', location: 'a second ISO 21496-1 APP2 segment in the photo' },
        ], 'A valid version-only ISO 21496-1 segment followed by a second one.');
      }
      const gmPlain = editSeg(gmBare, isXmp, swap(' x:xmptk="Fjord XMP Core 1.0"', ''));
      add('adv-gainmap-inner-mpf.jpg', join2(prim0, jpegInsert(gmPlain, seg(0xe2, cat('MPF\0', 'MM', be16(42), be32(8), be16(0), be32(0), C('INNER-MPF-TAIL-b2c3'))))), [
        { string: C('INNER-MPF-TAIL-b2c3'), tier: 'red', location: 'an MPF APP2 segment inside the gain map, with a tail' },
      ], 'A gain map that carries a multi-picture index of its own.');
      add('adv-gainmap-inner-iso.jpg', join2(prim0, jpegInsert(gmPlain, seg(0xe2, cat('urn:iso:std:iso:ts:21496:-1\0', Buffer.from([0, 0, 0, 0]), C('INNER-ISO-TAIL-c3d4'))))), [
        { string: C('INNER-ISO-TAIL-c3d4'), tier: 'red', location: 'surplus bytes in the ISO 21496-1 APP2 segment of the gain map' },
      ], 'An ISO 21496-1 segment in the gain map longer than its version field.');
      add('adv-gainmap-version-text.jpg', join2(editSeg(prim0, isXmp, swap('hdrgm:Version="1.0"', `hdrgm:Version="1.0 ${C('VERSION-TEXT-d4e5')}"`)), gm0), [
        { string: C('VERSION-TEXT-d4e5'), tier: 'red', location: 'text inside the value of hdrgm:Version in the photo XMP' },
      ], 'A gain map field with an allowed name and a value of the wrong form.');
      add('adv-gainmap-item-uri.jpg', join2(editSeg(prim0, isXmp, swap('Item:Semantic="GainMap"', `Item:Semantic="GainMap" Item:URI="${C('ITEM-URI-e5f6')}"`)), gm0), [
        { string: C('ITEM-URI-e5f6'), tier: 'red', location: 'Item:URI on the GainMap entry of the Container directory' },
      ], 'A Container directory entry with a URI field Ultra HDR does not use.');
      add('adv-gainmap-dir-child.jpg', join2(editSeg(prim0, isXmp, swap('</Container:Directory>', `<Container:Note>${C('DIR-CHILD-f607')}</Container:Note></Container:Directory>`)), gm0), [
        { string: C('DIR-CHILD-f607'), tier: 'red', location: 'a child element with text inside Container:Directory' },
      ], 'A Container directory with an extra element after its list.');
      add('adv-gainmap-seq-text.jpg', join2(prim0, editSeg(gmPlain, isXmp, (p) => swap(' hdrgm:OffsetHDR="0.015625"', '')(swap('</rdf:Description>', `<hdrgm:OffsetHDR><rdf:Seq><rdf:li>0.015625</rdf:li><rdf:li>${C('SEQ-TEXT-0718')}</rdf:li><rdf:li>0.015625</rdf:li></rdf:Seq></hdrgm:OffsetHDR></rdf:Description>`)(p)))), [
        { string: C('SEQ-TEXT-0718'), tier: 'red', location: 'text in one rdf:li of an rdf:Seq hdrgm:OffsetHDR in the gain map XMP' },
      ], 'A per-channel gain map value with text in one channel.');
      add('adv-gainmap-hidden-jpeg.jpg', join2(prim0, gmPlain, baseJpeg('hidden-after-gm.jpg', 24, 16, 31, C('HIDDEN-JPEG-COM-1829'))), [
        { string: C('HIDDEN-JPEG-COM-1829'), tier: 'red', location: 'a JPEG (with a comment) after the gain map end marker, inside its MPF size' },
      ], 'A whole picture hidden after the gain map, inside the size the MPF index gives it.');
      {
        // Little-endian MPF index with image IDs, a frame count, an unknown tag and an MP
        // Attribute IFD holding an unknown ASCII tag. join2 fills in the sizes and offsets.
        const uid = cat(C('MPF-UID-293a').padEnd(32, '0'), Buffer.from([0]), '0'.repeat(32), Buffer.from([0]));
        const table = cat(le32(0x20030000), le32(0), le32(0), le16(0), le16(0), le32(0), le32(0), le32(0), le16(0), le16(0));
        const mpfLE = cat('MPF\0', tiffLE([
          { name: 'ifd0', next: 'attr', entries: [
            { tag: 0xb000, type: 7, count: 4, data: Buffer.from('0100') },
            { tag: 0xb001, type: 4, count: 1, data: le32(2) },
            { tag: 0xb002, type: 7, data: table },
            { tag: 0xb003, type: 7, data: uid },
            { tag: 0xb004, type: 4, count: 1, data: le32(2) },
            { tag: 0xb0ff, type: 2, data: C('MPF-UNKNOWN-TAG-3a4b') },
          ] },
          { name: 'attr', entries: [
            { tag: 0xb101, type: 4, count: 1, data: le32(1) },
            { tag: 0xb2ee, type: 2, data: C('MPF-ATTR-ASCII-4b5c') },
          ] },
        ]));
        add('adv-gainmap-mpf-extras.jpg', join2(editSeg(prim0, isMpf, () => mpfLE), gm0), [
          { string: C('MPF-UID-293a'), tier: 'red', location: 'MPF B003 ImageUIDList (little-endian index)' },
          { string: C('MPF-UNKNOWN-TAG-3a4b'), tier: 'red', location: 'unknown ASCII tag B0FF in the MP Index IFD' },
          { string: C('MPF-ATTR-ASCII-4b5c'), tier: 'red', location: 'unknown ASCII tag B2EE in the MP Attribute IFD' },
        ], 'An MPF index with image IDs, layout details and two unknown tags.');
      }
      // A47 to A51. Free text in the Container directory's own fields, technical fields
      // with free text inside the gain map, and text in the gain map's colour profile.
      add('adv-gainmap-dir-semantic.jpg', join2(editSeg(prim0, isXmp, swap('</rdf:Seq>', `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="AstridHolmvik${C('DIR-SEMANTIC-5a6b')}" Item:Mime="image/astrid.holmvik" Item:Length="0"/></rdf:li></rdf:Seq>`)), gm0), [
        { string: C('DIR-SEMANTIC-5a6b'), tier: 'red', location: 'Item:Semantic of a third Container directory entry that stands for no part' },
      ], 'A directory entry whose role names a person and stands for nothing after the image.');
      add('adv-gainmap-dir-mime.jpg', join2(editSeg(prim0, isXmp, swap('Item:Semantic="GainMap" Item:Mime="image/jpeg"', `Item:Semantic="GainMap" Item:Mime="image/${C('DIR-MIME-6b7c')}"`)), gm0), [
        { string: C('DIR-MIME-6b7c'), tier: 'red', location: 'Item:Mime of the GainMap entry of the Container directory' },
      ], 'A gain map entry whose file type is free text.');
      add('adv-gainmap-inner-gpano.jpg', join2(prim0, editSeg(gmPlain, isXmp, swap('hdrgm:Version="1.0"', `hdrgm:Version="1.0" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:Note="Astrid Holmvik ${C('INNER-GPANO-7c8d')}"`))), [
        { string: C('INNER-GPANO-7c8d'), tier: 'red', location: 'GPano:Note (a technical namespace) with a name, in the gain map XMP' },
      ], 'A name in a field of the gain map XMP whose namespace is technical.');
      add('adv-gainmap-inner-rating.jpg', join2(prim0, editSeg(gmPlain, isXmp, swap('hdrgm:Version="1.0"', `hdrgm:Version="1.0" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="${C('INNER-RATING-8d9e')}"`))), [
        { string: C('INNER-RATING-8d9e'), tier: 'red', location: 'xmp:Rating with text, in the gain map XMP' },
      ], 'Text in a field of the gain map XMP that is normally a number.');
      {
        const text = (t) => { const d = cat('text', Buffer.alloc(4), t, Buffer.from([0])); return cat(d, Buffer.alloc((4 - (d.length % 4)) % 4)); };
        const desc = (() => { const t = 'sRGB gain'; const d = cat('desc', Buffer.alloc(4), be32(t.length + 1), t, Buffer.alloc(1 + 8 + 3 + 67)); return cat(d, Buffer.alloc((4 - (d.length % 4)) % 4)); })();
        const tags = [['desc', desc], ['cprt', text(`Copyright Astrid Holmvik ${C('GAINMAP-ICC-CPRT-9eaf')}`)]];
        let at = 128 + 4 + 12 * tags.length;
        const table = [be32(tags.length)];
        for (const [sig, d] of tags) { table.push(Buffer.from(sig, 'latin1'), be32(at), be32(d.length)); at += d.length; }
        const head = Buffer.alloc(128);
        head.writeUInt32BE(at, 0); head.writeUInt32BE(0x02100000, 8); head.write('mntrRGB XYZ ', 12, 'latin1'); head.write('acsp', 36, 'latin1');
        const profile = cat(head, ...table, ...tags.map((x) => x[1]));
        add('adv-gainmap-icc-text.jpg', join2(prim0, jpegInsert(gmPlain, seg(0xe2, cat('ICC_PROFILE\0', Buffer.from([1, 1]), profile)))), [
          { string: C('GAINMAP-ICC-CPRT-9eaf'), tier: 'red', location: "copyright text tag in the gain map's own colour profile" },
        ], "A gain map with a colour profile of its own whose copyright names a person.");
      }
      // A61 to A63 (review 4). A prefix chosen to carry text on the photo's hdrgm:Version, an
      // xml attribute on the gain map's own description, and a decoder table inside the gain
      // map that no scan uses.
      add('adv-gainmap-prefix.jpg', join2(editSeg(prim0, isXmp, (p) => swap('hdrgm:Version', `${C('HDR-PREFIX-c5d6')}:Version`)(swap('xmlns:hdrgm=', `xmlns:${C('HDR-PREFIX-c5d6')}=`)(p))), gm0), [
        { string: C('HDR-PREFIX-c5d6'), tier: 'red', location: 'the namespace prefix of hdrgm:Version in the photo XMP' },
      ], 'The photo XMP writes the hdrgm namespace under a prefix that is a name.');
      add('adv-gainmap-xml-attr.jpg', join2(prim0, editSeg(gmPlain, isXmp, swap('hdrgm:Version="1.0"', `hdrgm:Version="1.0" xml:note="Astrid Holmvik ${C('GAIN-XML-ATTR-d6e7')}"`))), [
        { string: C('GAIN-XML-ATTR-d6e7'), tier: 'red', location: 'an xml:note attribute on the gain map XMP description' },
      ], 'An xml attribute carries a name on the gain map description.');
      {
        const table = Buffer.alloc(64, 0x20);
        Buffer.from(C('GAIN-DQT-e7f8'), 'latin1').copy(table);
        add('adv-gainmap-unused-dqt.jpg', join2(prim0, jpegInsert(gmPlain, seg(0xdb, cat(Buffer.from([0x03]), table)))), [
          { string: C('GAIN-DQT-e7f8'), tier: 'red', location: 'a quantisation table (id 3) inside the gain map that no scan uses' },
        ], 'A decoder table no scan reads, inside the gain map.');
      }
      // A65 (0.0.3, decision 4). A message spelt in white space between the nodes of both
      // packets (the photo's and the gain map's own) and in padding after them. Nothing is
      // planted as text: the XMP layout check must find both packets in the canonical form
      // after every scrub, while the gain map stays and renders.
      {
        const ws = WS_SPELL('Astrid Holmvik');
        const spread = (p) => Buffer.from(p.toString('latin1').replace(/></g, `>${ws}<`).replace(/(<\/x:xmpmeta>)/, `$1${' '.repeat(4000)}`), 'latin1');
        add('adv-ws-gainmap.jpg', join2(editSeg(prim0, isXmp, spread), editSeg(gmPlain, isXmp, spread)), [], 'An Ultra HDR picture whose two XMP packets carry a message in white space and padding.');
      }
    }
  }
  // A52 to A60 (review 4). Free channels in details kept by default: inside colour tags and
  // the profile header, in the count of an EXIF number, in XMP prefixes, declarations, the
  // packet wrapper and xml attributes, and in a decoder table no scan uses.
  {
    const iccWith = ({ extra = [], rTRC = null, header = {} }) => {
      const text = (t) => cat('text', Buffer.alloc(4), t, Buffer.from([0]));
      const desc = cat('desc', Buffer.alloc(4), be32(5), 'sRGB', Buffer.alloc(1 + 8 + 3 + 67));
      const xyz = cat('XYZ ', Buffer.alloc(4), be32(0xf6d6), be32(0x10000), be32(0xd32d));
      const tags = [['desc', desc], ['cprt', text('No copyright, use freely')], ['wtpt', xyz], ...(rTRC ? [['rTRC', rTRC]] : []), ...extra];
      let at = 128 + 4 + 12 * tags.length;
      const table = [be32(tags.length)];
      const data = [];
      for (const [sig, d] of tags) { const pd = cat(d, Buffer.alloc((4 - (d.length % 4)) % 4)); table.push(Buffer.from(sig, 'latin1'), be32(at), be32(d.length)); data.push(pd); at += pd.length; }
      const head = Buffer.alloc(128);
      head.writeUInt32BE(at, 0); head.writeUInt32BE(0x02100000, 8); head.write('mntrRGB XYZ ', 12, 'latin1'); head.write('acsp', 36, 'latin1');
      head.writeUInt32BE(0xf6d6, 68); head.writeUInt32BE(0x10000, 72); head.writeUInt32BE(0xd32d, 76);
      for (const [o, v] of Object.entries(header)) Buffer.from(v, 'latin1').copy(head, Number(o));
      return cat(head, ...table, ...data);
    };
    const iccSegOf = (p) => seg(0xe2, cat('ICC_PROFILE\0', Buffer.from([1, 1]), p));
    add('adv-icc-curv-tail.jpg', jpegInsert(baseJpeg('b52.jpg', 96, 64, 52), iccSegOf(iccWith({ rTRC: cat('curv', Buffer.alloc(4), be32(1), Buffer.from([2, 0x33]), C('ICC-CURV-TAIL-f809')) }))), [
      { string: C('ICC-CURV-TAIL-f809'), tier: 'red', location: 'bytes after the one value of an rTRC curve in the colour profile' },
    ], 'A colour curve with text after its values.');
    add('adv-icc-targ-ui08.jpg', jpegInsert(baseJpeg('b53.jpg', 96, 64, 53), iccSegOf(iccWith({ extra: [['targ', cat('ui08', Buffer.alloc(4), C('ICC-TARG-091a'))]] }))), [
      { string: C('ICC-TARG-091a'), tier: 'red', location: 'a characterisation target tag typed as numbers (ui08) in the colour profile' },
    ], 'A registered tag signature with a numeric type that holds text.');
    add('adv-icc-header.jpg', jpegInsert(baseJpeg('b54.jpg', 96, 64, 54), iccSegOf(iccWith({ header: { 48: 'AstridHolmvik-1a' } }))), [
      { string: 'AstridHolmvik-1a', tier: 'red', location: 'device maker, model and attributes in the colour profile header (16 bytes)' },
    ], 'A name in the free fields of the colour profile header.');
    {
      const t = Buffer.alloc(40, 0x20);
      Buffer.from(C('EXIF-XRES-COUNT-1a2b'), 'latin1').copy(t);
      const tiff = tiffLE([{ name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Advcam' }, { tag: 0x011a, type: 5, count: 5, data: t }] }]);
      add('adv-exif-rational-count.jpg', jpegInsert(baseJpeg('b55.jpg', 96, 64, 55), exifSeg(tiff)), [
        { string: C('EXIF-XRES-COUNT-1a2b'), tier: 'red', location: 'XResolution written as five fractions, the bytes spelling text' },
      ], 'A technical EXIF number with more values than its field has.');
    }
    add('adv-xmp-prefix.jpg', jpegInsert(baseJpeg('b56.jpg', 96, 64, 56), xmpSeg(XMP('', `xmlns:${C('XMP-PREFIX-2b3c')}="http://ns.adobe.com/xap/1.0/" ${C('XMP-PREFIX-2b3c')}:Rating="3"`))), [
      { string: C('XMP-PREFIX-2b3c'), tier: 'red', location: 'the namespace prefix of xmp:Rating' },
    ], 'A technical XMP field under a prefix that is a name.');
    add('adv-xmp-outside.jpg', jpegInsert(baseJpeg('b57.jpg', 96, 64, 57), xmpSeg(XMP('', `xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="3" xmlns:n="urn:${C('XMP-UNUSED-NS-3c4d')}" xml:note="${C('XMP-XML-ATTR-4d5e')}"`).replace('id="W5M0MpCehiHzreSzNTczkc9d"', `id="${C('XMP-XPACKET-ID-5e6f')}"`))), [
      { string: C('XMP-UNUSED-NS-3c4d'), tier: 'red', location: 'a namespace declaration no name uses' },
      { string: C('XMP-XML-ATTR-4d5e'), tier: 'red', location: 'an xml:note attribute on rdf:Description' },
      { string: C('XMP-XPACKET-ID-5e6f'), tier: 'red', location: 'the id of the xpacket wrapper' },
    ], 'Text outside the XMP property model, around a technical field.');
    {
      const table = Buffer.alloc(64, 0x20);
      Buffer.from(C('PHOTO-DQT-6f70'), 'latin1').copy(table);
      add('adv-unused-dqt.jpg', jpegInsert(baseJpeg('b58.jpg', 96, 64, 58), seg(0xdb, cat(Buffer.from([0x03]), table))), [
        { string: C('PHOTO-DQT-6f70'), tier: 'red', location: 'a quantisation table (id 3) no scan uses' },
      ], 'A decoder table no scan reads.');
    }
  }
  // A64, A66, A67 (0.0.3, decision 4). A message spelt in white space between the nodes of
  // a packet, inside its start tags and in 4,000 bytes of padding, around a date (amber,
  // kept by the page's starting selection, which ticks red only) and a technical rating (green, kept), in JPEG, PNG and
  // WebP. The XMP layout check must find every packet in the canonical form after every
  // scrub; the planted creator goes as usual.
  {
    const ws = WS_SPELL('Fjordveien 12, Bergen');
    const packet = (tag) => XMP(`${ws}<xmp:CreateDate>${ws}2025-03-04T05:06:07${ws}</xmp:CreateDate>${ws}<dc:creator>${ws}<rdf:Seq><rdf:li>${C(tag)}</rdf:li></rdf:Seq>${ws}</dc:creator>${ws}`,
      `${ws}xmlns:xmp="http://ns.adobe.com/xap/1.0/"${ws}xmlns:dc="http://purl.org/dc/elements/1.1/"${ws}xmp:Rating="3"${ws}`).replace('</x:xmpmeta>', `</x:xmpmeta>${' '.repeat(4000)}`);
    add('adv-ws-photo.jpg', jpegInsert(baseJpeg('b64.jpg', 96, 64, 64), xmpSeg(packet('WS-JPEG-CREATOR-0b1c'))), [
      { string: C('WS-JPEG-CREATOR-0b1c'), tier: 'red', location: 'dc:creator in an XMP packet laid out with a message in white space' },
    ], 'An XMP packet whose white space and padding spell a message.');
    const png = magickTo(advPath('b66.png'), ['-seed', '66', '-size', '96x64', 'plasma:fractal', '-strip']);
    const iend = png.length - 12;
    const itxt = (kw, text) => { const body = cat(kw, Buffer.from([0, 0, 0, 0, 0]), Buffer.from(text, 'utf8')); const d = cat('iTXt', body); return cat(be32(body.length), d, be32(zlib.crc32(d))); };
    add('adv-ws.png', cat(png.subarray(0, iend), itxt('XML:com.adobe.xmp', packet('WS-PNG-CREATOR-1c2d')), png.subarray(iend)), [
      { string: C('WS-PNG-CREATOR-1c2d'), tier: 'red', location: 'dc:creator in an iTXt XMP packet laid out with a message in white space' },
    ], 'A PNG XMP packet whose white space and padding spell a message.');
    sh('magick', ['-seed', '67', '-size', '96x64', 'plasma:fractal', '-quality', '80', advPath('b67.webp')]);
    tryRun('exiftool', ['-q', '-overwrite_original', '-XMP-xmp:Rating=1', advPath('b67.webp')]);
    const wb = readFileSync(advPath('b67.webp'));
    const chunks = [];
    for (let q = 12; q + 8 <= wb.length;) {
      const n = wb.readUInt32LE(q + 4);
      if (wb.toString('latin1', q, q + 4) === 'XMP ') { const x = Buffer.from(packet('WS-WEBP-CREATOR-2d3e'), 'utf8'); chunks.push(cat('XMP ', le32(x.length), x, x.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0))); }
      else chunks.push(wb.subarray(q, q + 8 + n + (n & 1)));
      q += 8 + n + (n & 1);
    }
    const body = cat(...chunks);
    add('adv-ws.webp', cat('RIFF', le32(body.length + 4), 'WEBP', body), [
      { string: C('WS-WEBP-CREATOR-2d3e'), tier: 'red', location: 'dc:creator in a WebP XMP chunk laid out with a message in white space' },
    ], 'A WebP XMP packet whose white space and padding spell a message.');
  }
  return list;
}

// Pulls the coded picture and its properties out of a simple single-item HEIC from magick.
function extractHeic(b) {
  const top = isoBoxes(b, 0, b.length, 9);
  const meta = top.find((x) => x.path === 'meta');
  const kids = isoBoxes(b, meta.start + 12, meta.start + meta.size, 9);
  const iloc = kids.find((x) => x.path === 'iloc');
  const d = iloc.start + 8;
  const ver = b[d];
  const offSize = b[d + 4] >> 4;
  const lenSize = b[d + 4] & 15;
  const baseSize = b[d + 5] >> 4;
  let p = d + 8 + 2 + (ver === 1 ? 2 : 0) + 2;
  const readN = (n) => { const v = n === 4 ? b.readUInt32BE(p) : n === 8 ? Number(b.readBigUInt64BE(p)) : 0; p += n; return v; };
  const base = readN(baseSize);
  const n = b.readUInt16BE(p); p += 2;
  const parts = [];
  for (let i = 0; i < n; i++) { const off = readN(offSize); const len = readN(lenSize); parts.push(b.subarray(base + off, base + off + len)); }
  const iprp = kids.find((x) => x.path === 'iprp');
  const ik = isoBoxes(b, iprp.start + 8, iprp.start + iprp.size, 9);
  const ipco = ik.find((x) => x.path === 'ipco');
  const ipma = ik.find((x) => x.path === 'ipma');
  const props = isoBoxes(b, ipco.start + 8, ipco.start + ipco.size, 9).map((x) => b.subarray(x.start, x.start + x.size));
  const flags = b[ipma.start + 11];
  let q = ipma.start + 12 + 4 + 2;
  const k = b[q++];
  const assoc = [];
  for (let i = 0; i < k; i++) { if (flags & 1) { assoc.push(b.readUInt16BE(q)); q += 2; } else assoc.push(b[q++]); }
  return { data: Buffer.concat(parts), props: assoc.map((a) => ({ box: props[(a & 0x7fff & (flags & 1 ? 0x7fff : 0x7f)) - 1], essential: !!(a & (flags & 1 ? 0x8000 : 0x80)) })) };
}
function heicBuild({ prim, items = [], extraProps = [], top = [], refs = [] }) {
  const box = (type, ...parts) => { const body = cat(...parts); return cat(be32(8 + body.length), type, body); };
  const fullbox = (type, v, flags, ...parts) => box(type, Buffer.from([v, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
  const all = [{ id: 1, type: 'hvc1', data: prim.data }, ...items];
  const ftyp = box('ftyp', 'heic', be32(0), 'mif1', 'heic', 'miaf');
  const metaFor = (offsets) => {
    const hdlr = fullbox('hdlr', 0, 0, be32(0), 'pict', Buffer.alloc(12), Buffer.from([0]));
    const pitm = fullbox('pitm', 0, 0, be16(1));
    const infe = (it) => fullbox('infe', 2, it.hidden ? 1 : 0, be16(it.id), be16(0), it.type, Buffer.from([0]), ...(it.type === 'mime' ? [`${it.contentType}\0`] : []));
    const iinf = fullbox('iinf', 0, 0, be16(all.length), ...all.map(infe));
    const iref = refs.length ? [fullbox('iref', 0, 0, ...refs.map(([type, from, to]) => box(type, be16(from), be16(1), be16(to))))] : [];
    const ipco = box('ipco', ...prim.props.map((x) => x.box), ...extraProps.map((x) => x.box));
    const assocOf = new Map([[1, prim.props.map((x, i) => (x.essential ? 0x80 : 0) | (i + 1))]]);
    extraProps.forEach((x, i) => { const id = x.item || 1; if (!assocOf.has(id)) assocOf.set(id, []); assocOf.get(id).push((x.essential ? 0x80 : 0) | (prim.props.length + 1 + i)); });
    const ipma = fullbox('ipma', 0, 0, be32(assocOf.size), ...[...assocOf].map(([id, a]) => cat(be16(id), Buffer.from([a.length]), Buffer.from(a))));
    const iprp = box('iprp', ipco, ipma);
    const iloc = fullbox('iloc', 1, 0, Buffer.from([0x44, 0x00]), be16(all.length), ...all.map((it) => cat(be16(it.id), be16(0), be16(0), be16(1), be32(offsets[it.id] || 0), be32(it.data.length))));
    return fullbox('meta', 0, 0, hdlr, pitm, iinf, ...iref, iprp, iloc);
  };
  const layout = (metaLen) => { const o = {}; let p = ftyp.length + metaLen + 8; for (const it of all) { o[it.id] = p; p += it.data.length; } return o; };
  const meta = metaFor(layout(metaFor({}).length));
  return cat(ftyp, meta, box('mdat', ...all.map((it) => it.data)), ...top);
}

// libheif's view of HEIC files (python3 ctypes over libheif.so.1): the primary picture's
// pixels and the auxiliary images attached to it, with their names and pixels.
function heifInfo(files) {
  const script = join(OUT, 'heif-info.py');
  if (!existsSync(script)) {
    writeFileSync(script, `import ctypes, sys, hashlib, json
L = ctypes.CDLL('libheif.so.1')
class Err(ctypes.Structure):
    _fields_ = [('code', ctypes.c_int), ('subcode', ctypes.c_int), ('message', ctypes.c_char_p)]
V = ctypes.c_void_p
L.heif_context_alloc.restype = V
L.heif_context_read_from_file.argtypes = [V, ctypes.c_char_p, V]
L.heif_context_read_from_file.restype = Err
L.heif_context_get_primary_image_handle.argtypes = [V, ctypes.POINTER(V)]
L.heif_context_get_primary_image_handle.restype = Err
L.heif_image_handle_get_number_of_auxiliary_images.argtypes = [V, ctypes.c_int]
L.heif_image_handle_get_list_of_auxiliary_image_IDs.argtypes = [V, ctypes.c_int, ctypes.POINTER(ctypes.c_uint32), ctypes.c_int]
L.heif_image_handle_get_auxiliary_image_handle.argtypes = [V, ctypes.c_uint32, ctypes.POINTER(V)]
L.heif_image_handle_get_auxiliary_image_handle.restype = Err
L.heif_image_handle_get_auxiliary_type.argtypes = [V, ctypes.POINTER(ctypes.c_char_p)]
L.heif_image_handle_get_auxiliary_type.restype = Err
L.heif_decode_image.argtypes = [V, ctypes.POINTER(V), ctypes.c_int, ctypes.c_int, V]
L.heif_decode_image.restype = Err
L.heif_image_get_plane_readonly.argtypes = [V, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
L.heif_image_get_plane_readonly.restype = ctypes.POINTER(ctypes.c_uint8)
L.heif_image_get_height.argtypes = [V, ctypes.c_int]
L.heif_context_get_number_of_top_level_images.argtypes = [V]
def pixels(h):
    img = V()
    if L.heif_decode_image(h, ctypes.byref(img), 99, 99, None).code: return None
    hs = hashlib.sha256()
    for ch in (0, 1, 2):
        stride = ctypes.c_int()
        p = L.heif_image_get_plane_readonly(img, ch, ctypes.byref(stride))
        if p: hs.update(ctypes.string_at(p, stride.value * L.heif_image_get_height(img, ch)))
    return hs.hexdigest()
out = {}
for f in sys.argv[1:]:
    ctx = L.heif_context_alloc()
    e = L.heif_context_read_from_file(ctx, f.encode(), None)
    if e.code:
        out[f] = {'error': e.message.decode()}
        continue
    h = V()
    L.heif_context_get_primary_image_handle(ctx, ctypes.byref(h))
    n = L.heif_image_handle_get_number_of_auxiliary_images(h, 0)
    ids = (ctypes.c_uint32 * max(n, 1))()
    L.heif_image_handle_get_list_of_auxiliary_image_IDs(h, 0, ids, n)
    aux = []
    for i in range(n):
        a = V()
        L.heif_image_handle_get_auxiliary_image_handle(h, ids[i], ctypes.byref(a))
        t = ctypes.c_char_p()
        L.heif_image_handle_get_auxiliary_type(a, ctypes.byref(t))
        aux.append({'type': t.value.decode('latin1') if t.value else '', 'pixels': pixels(a)})
    out[f] = {'primary': pixels(h), 'aux': aux, 'top': L.heif_context_get_number_of_top_level_images(ctx)}
print(json.dumps(out))
`);
  }
  const r = tryRun('python3', [script, ...files]);
  return r.ok ? JSON.parse(r.out) : null;
}

// 0.0.3, decision 5. An iPhone HDR HEIC prepared with the default (red only) and with the
// red-and-amber selection keeps its gain map attached under Apple's exact name, decoding to the
// same pixels, and the photo keeps Apple's two HDR numbers (exiftool HDRHeadroom and
// HDRGain read the same). A layer whose name is not exactly a known one must be gone.
function heicHdrCheck(label, inFile, rec, keep) {
  const APPLE_AUX = 'urn:com:apple:photo:2020:aux:hdrgainmap';
  const repro = `python3 ${join(OUT, 'heif-info.py')} ${inFile} ${rec.redFile}; exiftool -s -n -AuxiliaryImageType -Apple:HDRHeadroom -Apple:HDRGain ${rec.redFile}`;
  // The red-and-amber selection is checked too when it keeps the gain map (it ticks amber
  // details unless they belong to an HDR gain map).
  const outs = [['red-only', rec.redFile], ...(keep && (rec.startIds || []).includes('heic:gain-map') ? [] : [['red-and-amber', rec.startFile]])];
  const heif = heifInfo([inFile, ...outs.map((x) => x[1])]);
  if (!heif) { finding('medium', label, 'libheif', 'libheif could not be run through python3 ctypes, so the HDR gain map was not checked.', repro); return null; }
  const rows = (f) => Object.fromEntries(tryRun('exiftool', ['-s', '-n', '-AuxiliaryImageType', '-Apple:HDRHeadroom', '-Apple:HDRGain', f]).out.split('\n').filter(Boolean).map((l) => l.split(/\s+:\s?/)));
  const rin = rows(inFile);
  const hin = heif[inFile];
  const notes = [];
  for (const [which, f] of outs) {
    const h = heif[f];
    if (!h || h.error) { finding('high', label, 'libheif', `libheif cannot read the ${which} output: ${h && h.error}`, repro); continue; }
    if (h.primary !== hin.primary) finding('high', label, 'libheif', `The ${which} output decodes to different pixels than the input.`, repro);
    if (!keep) {
      if (h.aux.length) finding('critical', label, 'auxiliary image', `After the ${which} scrub an auxiliary image is still attached: ${h.aux.map((a) => a.type).join(', ')}.`, repro);
      else notes.push(`${which}: no layer attached`);
      continue;
    }
    const r = rows(f);
    const aux = h.aux.find((a) => a.type === APPLE_AUX);
    if (!aux) finding('high', label, 'HDR gain map', `After the ${which} scrub the HDR gain map is no longer attached under Apple's name (libheif sees ${h.aux.map((a) => a.type).join(', ') || 'no auxiliary image'}).`, repro);
    else if (aux.pixels !== hin.aux[0].pixels) finding('high', label, 'HDR gain map', `After the ${which} scrub the HDR gain map decodes to different pixels.`, repro);
    if (r.AuxiliaryImageType !== APPLE_AUX) finding('high', label, 'HDR gain map', `exiftool reads the ${which} output's AuxiliaryImageType as ${JSON.stringify(r.AuxiliaryImageType)}.`, repro);
    if (r.HDRHeadroom !== rin.HDRHeadroom || r.HDRGain !== rin.HDRGain) finding('high', label, 'Apple HDR brightness', `After the ${which} scrub HDRHeadroom and HDRGain read ${r.HDRHeadroom} and ${r.HDRGain}, the input ${rin.HDRHeadroom} and ${rin.HDRGain}.`, repro);
    if (aux && r.HDRHeadroom === rin.HDRHeadroom && r.HDRGain === rin.HDRGain) notes.push(`${which}: gain map attached as ${APPLE_AUX}, same pixels, HDRHeadroom ${r.HDRHeadroom}, HDRGain ${r.HDRGain}`);
  }
  const text = notes.join('; ');
  if (notes.length === outs.length) pass(`${label}: ${text}`);
  return text;
}

async function sectionAdversarial(records) {
  const list = buildAdversarial();
  // A72 onwards (review of 4 October 2026): the hidden-channel probes the engine tests use
  // (tests/probes.mjs), built into the core fixture folder.
  {
    const prev = process.env.MS_FIXTURE_DIR;
    process.env.MS_FIXTURE_DIR = CORE_FIX;
    const F = await import(pathToFileURL(join(HERE, 'core-fixtures.mjs')).href);
    const { privacyProbes } = await import(pathToFileURL(join(HERE, 'probes.mjs')).href);
    if (prev === undefined) delete process.env.MS_FIXTURE_DIR; else process.env.MS_FIXTURE_DIR = prev;
    for (const p of privacyProbes(F)) {
      writeFileSync(advPath(p.name), p.bytes);
      list.push({ name: p.name, bytes: Buffer.from(p.bytes), canaries: p.canaries, note: p.note });
    }
  }
  for (const a of list) {
    const file = advPath(a.name);
    log(`[adversarial] ${a.name}`);
    // Can ordinary tools read the input, and do they show the planted strings?
    const decodes = { magick: magickIdentify(file).ok, pil: a.name.endsWith('.heic') ? null : pilHashes([file])[file]?.ok };
    const et = USE_EXIFTOOL ? tryRun('exiftool', ['-a', '-u', '-U', '-G1', '-ee3', '-s', '-m', file]).out : '';
    const shownBy = a.canaries.filter((c) => et.includes(c.string)).map((c) => c.string);
    const rec = await evaluate(`adv/${a.name}`, file, a.bytes, a.canaries.map((c) => ({ ...c, basis: 'spec' })), { section: 'adversarial' });
    rec.note = a.note;
    if (a.appleHdr || a.auxGone) rec.heicHdr = heicHdrCheck(`adv/${a.name}`, file, rec, !!a.appleHdr);
    rec.inputDecodes = decodes;
    rec.exiftoolShows = shownBy;
    records.push(rec);
  }
}

// ======================================================================================
// Section 3b: the re-encode path (crop, resize, rotation baked in). buildExif() with every
// non-red detail kept (red only, as the page's starting selection since 0.0.3), inserted into
// freshly encoded pictures; no red string may follow.

async function sectionReencode(records) {
  const reg = loadRegistry();
  const fresh = {};
  for (const [fmt, ext, extra] of [['jpeg', 'jpg', ['-quality', '85']], ['png', 'png', []], ['webp', 'webp', ['-quality', '80']]]) {
    const f = join(ADV, `fresh.${ext}`);
    sh('magick', ['-seed', '61', '-size', '64x48', 'plasma:fractal', '-strip', ...extra, f]);
    fresh[fmt] = readFileSync(f);
  }
  const files = [...new Set(reg.map((r) => r.file))].filter((n) => /\.(jpe?g|png|webp|heic)$/.test(n));
  const adv = existsSync(ADV) ? readdirSync(ADV).filter((n) => /^adv-.*\.(jpe?g|png|webp|heic)$/.test(n)).map((n) => join(ADV, n)) : [];
  const out = [];
  for (const file of [...files.map((n) => join(FIXTURES, n)), ...adv]) {
    const b = u8(readFileSync(file));
    if (!core.detectFormat(b)) continue;
    let ins;
    try { ins = await core.inspect(b); } catch { continue; }
    const keep = ins.items.filter((i) => i.tier !== 'red').map((i) => i.id);
    let payload;
    try { payload = core.buildExif(b, keep); } catch (e) { finding('medium', basename(file), 'buildExif', `buildExif() throws ${e.name}: ${e.message}`, `buildExif(readFileSync('${file}'), keptIds)`); continue; }
    if (!payload) continue;
    const red = reg.filter((r) => r.file === basename(file) && r.tier === 'red').map((r) => r.string);
    for (const fmt of ['jpeg', 'png', 'webp']) {
      let res;
      try { res = core.insertExif(u8(fresh[fmt]), fmt, payload); } catch (e) { finding('medium', basename(file), `insertExif ${fmt}`, `insertExif() throws ${e.name}: ${e.message}`, `insertExif(fresh ${fmt}, '${fmt}', buildExif(...))`); continue; }
      const f = join(OUT, 'outputs', `reencode-${basename(file)}.${extOf(fmt)}`);
      writeFileSync(f, res);
      const hay = haystacks(res);
      const left = red.filter((s) => locate(hay, s).length);
      if (left.length) finding('critical', basename(file), `re-encode to ${fmt}`, `buildExif() with every non-red detail kept carries red strings into the re-encoded picture: ${left.join(', ')}`, `keep = non-red ids; insertExif(fresh, '${fmt}', buildExif(src, keep)); grep ${f}`);
      const rb = await core.inspect(res);
      const o = rb.items.find((i) => i.id === 'exif:orientation');
      if (o && o.value !== 'Normal') finding('high', basename(file), `re-encode to ${fmt}`, `Orientation in the rebuilt EXIF is "${o.value}", not Normal.`, f);
      const redLeft = rb.items.filter((i) => i.tier === 'red');
      if (redLeft.length) finding('critical', basename(file), `re-encode to ${fmt}`, `Read-back of the re-encoded picture lists red details: ${redLeft.map((i) => `${i.id} (${i.value})`).join('; ')}`, f);
      const dec = fmt === 'jpeg' || fmt === 'png' || fmt === 'webp' ? pilHashes([f])[f] : null;
      if (dec && !dec.ok) finding('medium', basename(file), `re-encode to ${fmt}`, `Pillow cannot decode the picture after insertExif(): ${dec.error}`, f);
      if (USE_EXIFTOOL) {
        const v = exiftoolValidate(f);
        if (v.length) finding('low', basename(file), `re-encode to ${fmt}`, `exiftool -validate warns about the rebuilt EXIF: ${v.slice(0, 3).join(' / ')}`, `exiftool -validate -warning ${f}`, `reval|${fmt}|${v.join('/')}`);
      }
      out.push({ file: basename(file), fmt, items: rb.items.map((i) => `${i.tier}:${i.id}`) });
    }
  }
  records.push({ section: 'reencode', results: out });
  log(`[reencode] ${out.length} rebuilt pictures checked`);
}

// ======================================================================================
// Section 4: hostile inputs, run in a worker with a time limit

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
let core;
parentPort.on('message', async (m) => {
  if (!core) core = await import(workerData.coreUrl);
  const b = new Uint8Array(m.buf);
  const res = { id: m.id };
  const t0 = performance.now();
  try {
    res.format = core.detectFormat(b);
    if (res.format) {
      const ins = await core.inspect(b);
      res.items = ins.items.map((i) => i.tier + ':' + i.id);
      res.warnings = ins.warnings;
      const all = await core.scrub(b, ins.items.map((i) => i.id));
      const red = await core.scrub(b, ins.items.filter((i) => i.tier === 'red').map((i) => i.id));
      res.allWarnings = all.warnings;
      res.redWarnings = red.warnings;
      res.all = all.bytes;
      res.red = red.bytes;
      try { await core.inspect(all.bytes); } catch (e) { res.readbackError = e.name + ': ' + e.message; }
    }
  } catch (e) {
    res.error = e.name + ': ' + e.message;
    res.stack = String(e.stack || '').split('\\n').slice(0, 4).join(' | ');
  }
  res.ms = performance.now() - t0;
  parentPort.postMessage(res);
});`;

class Runner {
  constructor() { this.spawn(); }
  spawn() { this.w = new Worker(WORKER, { eval: true, workerData: { coreUrl: CORE_URL }, resourceLimits: { maxOldGenerationSizeMb: 2048 } }); this.w.unref(); }
  run(buf, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const id = Math.random();
      let done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); this.w.off('message', onMsg); this.w.off('error', onErr); this.w.off('exit', onExit); resolve(r); };
      const onMsg = (r) => { if (r.id === id) finish(r); };
      const onErr = (e) => { finish({ crash: `${e.name}: ${e.message}` }); this.spawn(); };
      const onExit = (code) => { finish({ crash: `worker exited with code ${code}` }); this.spawn(); };
      const timer = setTimeout(() => { finish({ hang: true }); this.w.terminate(); this.spawn(); }, timeoutMs);
      this.w.on('message', onMsg); this.w.on('error', onErr); this.w.on('exit', onExit);
      this.w.postMessage({ id, buf: Uint8Array.from(buf) });
    });
  }
  close() { this.w.terminate(); }
}

function hostileCases(reg) {
  const cases = [];
  const addCase = (name, bytes, canaries = []) => cases.push({ name, bytes: Buffer.from(bytes), canaries });
  addCase('empty file (0 bytes)', Buffer.alloc(0));
  for (const sig of [[0xff, 0xd8], [0xff, 0xd8, 0xff], [0xff, 0xd8, 0xff, 0xe1], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], Buffer.from('RIFF\0\0\0\0WEBPVP8X'), cat(be32(16), 'ftypheic', be32(0))]) addCase(`signature only (${Buffer.from(sig).toString('hex')})`, Buffer.from(sig));
  const tiny = (name) => readFileSync(join(FIXTURES, name));
  const regFor = (name) => reg.filter((r) => r.file === name).map((r) => r.string);
  // Truncations of every small fixture.
  for (const name of ['jpeg-everything.jpg', 'jpeg-ultrahdr-like.jpg', 'jpeg-motion-photo.jpg', 'jpeg-samsung-trailer.jpg', 'jpeg-extended-xmp.jpg', 'png-everything.png', 'webp-everything.webp', 'heic-everything.heic', 'jpeg-double-exif.jpg']) {
    const b = tiny(name);
    const cuts = new Set();
    for (let i = 1; i < 48; i++) cuts.add(Math.floor((b.length * i) / 48));
    for (const c of [3, 10, 20, 40, 100, 300, 1000]) if (c < b.length) cuts.add(c);
    for (const c of cuts) addCase(`${name} cut at ${c}`, b.subarray(0, c), regFor(name));
  }
  // Specific structures.
  const base = readFileSync(advPath('b1.jpg'));
  const self = (() => { const t = tiffLE([{ name: 'ifd0', entries: [{ tag: 0x013b, type: 2, data: C('HOSTILE-SELFLOOP-ARTIST-bc46') }, { tag: 0x8769, type: 4, raw: 8 }, { tag: 0x8825, type: 4, raw: 8 }], next: 8 }]); return t; })();
  addCase('IFD0 next, Exif and GPS pointers all point at IFD0 itself', jpegInsert(base, exifSeg(self)), [C('HOSTILE-SELFLOOP-ARTIST-bc46')]);
  const subloop = tiffLE([
    { name: 'ifd0', entries: [{ tag: 0x013b, type: 2, data: C('HOSTILE-SUBLOOP-ARTIST-cd57') }, { tag: 0x8769, type: 4, ptr: 'exif' }] },
    { name: 'exif', entries: [{ tag: 0x8769, type: 4, ptr: 'exif' }, { tag: 0xa005, type: 4, ptr: 'exif' }], next: 'exif' },
  ]);
  addCase('Exif IFD points at itself through ExifOffset, Interop and next', jpegInsert(base, exifSeg(subloop)), [C('HOSTILE-SUBLOOP-ARTIST-cd57')]);
  const beyond = tiffLE([{ name: 'ifd0', entries: [{ tag: 0x013b, type: 2, count: 40, raw: 0xfffffff0 }, { tag: 0x010f, type: 2, count: 0xffffffff, raw: 0x10 }, { tag: 0x0110, type: 5, count: 0x20000000, raw: 8 }, { tag: 0x0131, type: 2, data: C('HOSTILE-BEYOND-SOFTWARE-de68') }], next: 0xffffff00 }]);
  addCase('offsets beyond the end and huge counts', jpegInsert(base, exifSeg(beyond)), [C('HOSTILE-BEYOND-SOFTWARE-de68')]);
  const many = Buffer.alloc(2 + 1001 * 12 + 4);
  many.writeUInt16LE(1001, 0);
  for (let i = 0; i < 1001; i++) { many.writeUInt16LE(0xc000 + i, 2 + i * 12); many.writeUInt16LE(3, 4 + i * 12); many.writeUInt32LE(1, 6 + i * 12); }
  const art = Buffer.from(`${C('HOSTILE-1001ENTRIES-ARTIST-ef79')}\0`);
  const bigIfd = cat('II', le16(42), le32(8), many, art);
  bigIfd.writeUInt16LE(0x013b, 8 + 2 + 1000 * 12); bigIfd.writeUInt16LE(2, 8 + 4 + 1000 * 12); bigIfd.writeUInt32LE(art.length, 8 + 6 + 1000 * 12); bigIfd.writeUInt32LE(8 + many.length, 8 + 10 + 1000 * 12);
  addCase('IFD0 with 1,001 entries, the last one Artist', jpegInsert(base, exifSeg(bigIfd)), [C('HOSTILE-1001ENTRIES-ARTIST-ef79')]);
  const badHeader = cat('Exif\0\0', 'II', le16(43), le32(8), Buffer.from(`${C('HOSTILE-BADTIFFMAGIC-f08a')}\0`));
  addCase('EXIF with a wrong TIFF magic number', jpegInsert(base, seg(0xe1, badHeader)), [C('HOSTILE-BADTIFFMAGIC-f08a')]);
  const ifd0Off = cat('Exif\0\0', 'II', le16(42), le32(0x7fff0000), Buffer.from(`${C('HOSTILE-IFD0-OFFSET-019b')}\0`));
  addCase('EXIF whose IFD0 offset points past the end', jpegInsert(base, seg(0xe1, ifd0Off)), [C('HOSTILE-IFD0-OFFSET-019b')]);
  for (const [n, x] of [['unclosed element', '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>' + C('HOSTILE-XMP-UNCLOSED-12ac') + '</dc:creator>'],
    ['doctype with entities', '<!DOCTYPE x [<!ENTITY a "' + C('HOSTILE-XMP-ENTITY-23bd') + '"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="&b;"/></rdf:RDF></x:xmpmeta>'],
    ['mismatched tags', '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>' + C('HOSTILE-XMP-MISMATCH-34ce') + '</dc:title></rdf:Description></rdf:RDF></x:xmpmeta>'],
    ['deep nesting (9,000 levels)', '<x:xmpmeta xmlns:x="adobe:ns:meta/">' + '<a>'.repeat(9000) + C('HOSTILE-XMP-DEEP-45df') + '</a>'.repeat(9000) + '</x:xmpmeta>'],
    ['binary garbage', '\u0000\u0001\u0002<<<' + C('HOSTILE-XMP-GARBAGE-56e0') + '>>>￿'],
    ['attribute with < inside', '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="<' + C('HOSTILE-XMP-LT-67f1') + '"/></rdf:RDF></x:xmpmeta>'],
  ]) {
    const xs = xmpSeg(x);
    addCase(`malformed XMP: ${n}`, xs.length < 65535 ? jpegInsert(base, xs) : base, [x.match(/CANARY-[A-Z0-9-]+/)[0]]);
  }
  {
    const deep = '<x:xmpmeta xmlns:x="adobe:ns:meta/">' + '<a>'.repeat(200000) + C('HOSTILE-XMP-DEEPER-7802') + '</a>'.repeat(200000) + '</x:xmpmeta>';
    const png = readFileSync(join(FIXTURES, 'png-transparent.png'));
    const ihdr = pngChunks(png)[0];
    const chunk = (type, data) => { const tc = cat(type, data); return cat(be32(B(data).length), tc, be32(zlib.crc32(tc))); };
    addCase('PNG XMP with 200,000 nested elements', cat(png.subarray(0, ihdr.end), chunk('iTXt', cat('XML:com.adobe.xmp\0', Buffer.from([0, 0, 0, 0]), deep)), png.subarray(ihdr.end)), [C('HOSTILE-XMP-DEEPER-7802')]);
    const bad = Buffer.from(png);
    const t = pngChunks(bad).find((c) => c.type === 'tEXt');
    bad.writeUInt32BE((bad.readUInt32BE(t.end - 4) ^ 0xdeadbeef) >>> 0, t.end - 4);
    addCase('PNG text chunk with a bad CRC', bad, regFor('png-transparent.png'));
    const badIdat = Buffer.from(png);
    const idat = pngChunks(badIdat).find((c) => c.type === 'IDAT');
    badIdat.writeUInt32BE((badIdat.readUInt32BE(idat.end - 4) ^ 1) >>> 0, idat.end - 4);
    addCase('PNG IDAT chunk with a bad CRC', badIdat, regFor('png-transparent.png'));
    // Many chunks with distinct types and bad CRCs (warning list grows with each one).
    const r = rng(7);
    const parts = [png.subarray(0, ihdr.end)];
    for (let i = 0; i < 30000; i++) { let ty = ''; for (let k = 0; k < 4; k++) ty += String.fromCharCode(97 + Math.floor(r() * 26)); parts.push(cat(be32(1), ty, 'x', be32(0))); }
    parts.push(png.subarray(ihdr.end));
    addCase('PNG with 30,000 private chunks with distinct types and bad CRCs', cat(...parts));
  }
  {
    const segs = [];
    for (let i = 0; i < 12000; i++) segs.push(exifSeg(tiffLE([{ name: 'ifd0', entries: [{ tag: 0x013b, type: 2, data: 'Dup' }] }])));
    addCase('JPEG with 12,000 EXIF segments', jpegInsert(base, ...segs));
  }
  {
    const w = readFileSync(join(FIXTURES, 'webp-everything.webp'));
    const b1 = Buffer.from(w); b1.writeUInt32LE(0xffffffff, 4);
    addCase('WebP with RIFF size 0xFFFFFFFF', b1, regFor('webp-everything.webp'));
    const b2 = Buffer.from(w); b2.writeUInt32LE(4, 4);
    addCase('WebP with RIFF size 4 (everything after the header is trailing)', b2, regFor('webp-everything.webp'));
  }
  {
    const h = readFileSync(join(FIXTURES, 'heic-everything.heic'));
    const boxes = isoBoxes(h, 0, h.length, 0);
    const meta = boxes.find((x) => x.path === 'meta');
    const kids = isoBoxes(h, meta.start + 12, meta.start + meta.size, 9);
    const iloc = kids.find((x) => x.path === 'iloc');
    const b1 = Buffer.from(h); b1.writeUInt32BE(0xffffffff, iloc.start + 8 + 4 + 2);
    addCase('HEIC iloc with a huge item count', b1, regFor('heic-everything.heic'));
    const b2 = Buffer.from(h); b2.writeUInt32BE(0, meta.start);
    addCase('HEIC meta box size 0 (to end of file)', b2, regFor('heic-everything.heic'));
    const iref = kids.find((x) => x.path === 'iref');
    if (iref) {
      const b3 = Buffer.from(h);
      // Make every reference point back to its own item.
      const rs = isoBoxes(b3, iref.start + 12, iref.start + iref.size, 9);
      for (const r of rs) { const from = b3.readUInt16BE(r.start + 8); const n = b3.readUInt16BE(r.start + 10); for (let i = 0; i < n; i++) b3.writeUInt16BE(from, r.start + 12 + i * 2); }
      addCase('HEIC item references that point at themselves', b3, regFor('heic-everything.heic'));
    }
  }
  {
    // Motion Photo XMP that claims a video longer than the file, and an MPF entry pointing backwards.
    const m = readFileSync(join(FIXTURES, 'jpeg-motion-photo.jpg'));
    const s = m.toString('latin1');
    const i = s.search(/Item:Length="\d+"/);
    if (i >= 0) { const b = Buffer.from(m); const j = s.indexOf('"', i + 13); b.write('9'.repeat(j - i - 13), i + 13, 'latin1'); addCase('Motion Photo XMP video length larger than the file', b, regFor('jpeg-motion-photo.jpg')); }
  }
  return cases;
}

function mutations(reg, perFile) {
  const out = [];
  const names = ['jpeg-everything.jpg', 'jpeg-ultrahdr-like.jpg', 'jpeg-motion-photo.jpg', 'png-everything.png', 'webp-everything.webp', 'heic-everything.heic', 'jpeg-extended-xmp.jpg', 'jpeg-orientation-6.jpg'];
  for (const name of names) {
    const b = readFileSync(join(FIXTURES, name));
    const strings = reg.filter((r) => r.file === name).map((r) => r.string);
    // Mutate only the metadata region: before the first SOS / IDAT / VP8 / mdat payload.
    let limit = b.length;
    if (name.endsWith('.jpg')) { const sos = jpegSegments(b).find((x) => x.marker === 0xda); if (sos) limit = sos.start; }
    if (name.endsWith('.png')) { const idat = pngChunks(b).find((x) => x.type === 'IDAT'); if (idat) limit = idat.start; }
    if (name.endsWith('.heic')) { const mdat = isoBoxes(b).find((x) => x.path === 'mdat'); if (mdat) limit = mdat.start + 64; }
    const r = rng(0x5eed + name.length * 977);
    for (let k = 0; k < perFile; k++) {
      const m = Buffer.from(b);
      const n = 1 + Math.floor(r() * 6);
      const edits = [];
      for (let j = 0; j < n; j++) {
        const pos = Math.floor(r() * limit);
        const kind = r();
        const v = kind < 0.4 ? Math.floor(r() * 256) : kind < 0.7 ? 0xff : kind < 0.85 ? 0x00 : m[pos] ^ (1 << Math.floor(r() * 8));
        m[pos] = v;
        edits.push(`${hexAt(pos)}=${v.toString(16)}`);
      }
      out.push({ name: `${name} mutation ${k} (${edits.join(',')})`, bytes: m, canaries: strings, mutated: true, file: name, edits });
    }
  }
  return out;
}

async function sectionHostile(records) {
  const reg = loadRegistry();
  if (!existsSync(advPath('b1.jpg'))) baseJpeg('b1.jpg');
  const cases = [...hostileCases(reg), ...mutations(reg, FUZZ)];
  const runner = new Runner();
  const stats = { cases: cases.length, errors: 0, hangs: 0, crashes: 0, slow: 0, silentKeeps: 0 };
  const silent = new Map();
  let i = 0;
  for (const c of cases) {
    i++;
    if (i % 100 === 0) log(`[hostile] ${i}/${cases.length}`);
    const r = await runner.run(c.bytes, /12,000|30,000|200,000/.test(c.name) ? 60000 : 20000);
    const file = join(OUT, 'hostile', `case-${i}.bin`);
    const save = () => { writeFileSync(file, c.bytes); return file; };
    const rep = (f) => `node --input-type=module -e "import * as c from '${CORE_URL}'; import fs from 'node:fs'; const b=new Uint8Array(fs.readFileSync('${f}')); const i=await c.inspect(b); console.log(i.warnings, i.items.map(x=>x.id)); const r=await c.scrub(b, i.items.map(x=>x.id)); console.log(r.warnings, r.bytes.length)"`;
    if (r.hang) { stats.hangs++; finding('high', c.name, 'hostile input', 'inspect() or scrub() did not finish within the time limit (hang or extreme slowness).', rep(save())); continue; }
    if (r.crash) { stats.crashes++; finding('high', c.name, 'hostile input', `The worker running the engine died: ${r.crash}.`, rep(save())); continue; }
    if (r.ms > 3000) { stats.slow++; finding('medium', c.name, 'hostile input', `inspect plus two scrubs took ${Math.round(r.ms)} ms; a crafted file can freeze the page.`, rep(save())); }
    if (r.error) {
      stats.errors++;
      const expected = /not supported/.test(r.error);
      if (!expected) {
        const key = `err|${r.error.replace(/\d+/g, 'N')}`;
        finding('low', c.name.replace(/ mutation \d+ \(.*\)$/, ' (mutated)'), 'hostile input', `The engine throws ${r.error}${r.stack ? ` (${r.stack})` : ''}. The file can then not be scrubbed at all; the interface must catch this.`, rep(save()), key);
      }
      continue;
    }
    if (r.readbackError) finding('medium', c.name, 'hostile input', `Reading back the every-detail output throws ${r.readbackError}.`, rep(save()), `rb|${r.readbackError.replace(/\d+/g, 'N')}`);
    if (!r.format || !c.canaries.length || !r.all) continue;
    // Silent keep: planted strings intact in the input that survive the every-detail scrub.
    const hayIn = haystacks(c.bytes);
    const hayAll = haystacks(Buffer.from(r.all));
    const left = c.canaries.filter((s) => locate(hayIn, s).length && locate(hayAll, s).length);
    const warned = (r.warnings || []).length + (r.allWarnings || []).filter((w) => !/Content Credentials/.test(w)).length > 0;
    if (left.length) {
      const key = `${c.mutated ? c.file : c.name}|${left.join(',')}|${warned}`;
      if (!silent.has(key)) silent.set(key, { c, left, warned, file: save(), r });
      if (!warned) stats.silentKeeps++;
    }
  }
  runner.close();
  for (const { c, left, warned, file, r } of silent.values()) {
    if (c.mutated) continue;
    finding(warned ? 'medium' : 'high', c.name, 'hostile input', `${left.length} planted string(s) survive the every-detail scrub${warned ? ` (with warnings: ${[...(r.warnings || []), ...(r.allWarnings || [])].slice(0, 2).join(' / ')})` : ' with NO warning at all'}: ${left.slice(0, 4).join(', ')}${left.length > 4 ? ', ...' : ''}.`, `${file}: inspect, scrub with every id, grep the output.`);
  }
  // Mutations: summarise per fixture rather than one finding per mutation.
  const mut = [...silent.values()].filter((x) => x.c.mutated);
  const byFile = new Map();
  for (const x of mut) { const k = x.c.file; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(x); }
  for (const [f, xs] of byFile) {
    const silentOnes = xs.filter((x) => !x.warned);
    const sample = (silentOnes[0] || xs[0]);
    finding(silentOnes.length ? 'high' : 'medium', f, 'mutated input', `${xs.length} distinct survivals after the every-detail scrub across ${FUZZ} random mutations of the metadata region; ${silentOnes.length} of them with no warning. Example: ${sample.left.slice(0, 3).join(', ')} survive after edits ${sample.c.edits.join(', ')}.`, `${sample.file}: inspect, scrub with every id, grep the output.`);
  }
  records.push({ section: 'hostile', stats, survivals: [...silent.values()].map((x) => ({ name: x.c.name, left: x.left, warned: x.warned, file: x.file })) });
  log(`[hostile] ${JSON.stringify(stats)}`);
}

// ======================================================================================
// Tool checks over every output (4 and 5)

function toolChecks(records) {
  if (!outputsForTools.length) return;
  log(`[tools] decoding, pixel hashes${USE_EXIFTOOL ? ', exiftool listing and validation' : ''} for ${outputsForTools.length} pictures`);
  const nonHeic = outputsForTools.filter((o) => o.format !== 'heic');
  const pil = pilHashes(nonHeic.flatMap((o) => [o.inFile, o.redFile, o.allFile]));
  const exiftoolReport = [];
  for (const o of outputsForTools) {
    const rec = records.find((r) => r.label === o.fixture);
    const integ = {};
    for (const [which, f] of [['red-only', o.redFile], ['every-detail', o.allFile]]) {
      const inOk = magickIdentify(o.inFile).ok;
      const id = magickIdentify(f);
      if (inOk && !id.ok) finding('medium', o.fixture, `${which} output`, `magick identify rejects the ${which} output (the input is accepted): ${id.error}`, `magick identify -regard-warnings ${f}`);
      if (o.format === 'heic') {
        const a = magickHash(o.inFile);
        const b = magickHash(f);
        if (a.ok && !b.ok) finding('medium', o.fixture, `${which} output`, `The ${which} output no longer decodes with magick: ${b.error}`, `magick ${f} rgba:- | sha256sum`);
        else if (a.ok && b.ok && a.hash !== b.hash) finding('medium', o.fixture, `${which} output`, `Decoded pixels differ after the ${which} scrub (magick RGBA hash).`, `compare magick ${o.inFile} and ${f} as rgba:-`);
        integ[which] = a.ok ? (b.ok && a.hash === b.hash ? 'pixels identical' : 'DIFFERENT') : 'input does not decode';
      } else {
        const a = pil[o.inFile];
        const b = pil[f];
        if (a && a.ok && b && !b.ok) finding('medium', o.fixture, `${which} output`, `Pillow cannot decode the ${which} output: ${b.error}`, `python3 -c "from PIL import Image; Image.open('${f}').load()"`);
        else if (a && a.ok && b && b.ok && a.hash !== b.hash) finding('medium', o.fixture, `${which} output`, `Decoded pixels differ after the ${which} scrub (Pillow hash ${a.hash.slice(0, 30)} vs ${b.hash.slice(0, 30)}).`, `python3 Pillow tobytes() hash of ${o.inFile} and ${f}`);
        integ[which] = a && a.ok ? (b && b.ok && a.hash === b.hash ? 'pixels identical' : 'DIFFERENT') : 'input does not decode';
      }
    }
    if (USE_EXIFTOOL) {
      const vin = new Set(exiftoolValidate(o.inFile));
      for (const [which, f] of [['red-only', o.redFile], ['every-detail', o.allFile]]) {
        const vout = exiftoolValidate(f);
        const added = vout.filter((w) => !vin.has(w));
        if (added.length) finding('medium', o.fixture, `${which} output`, `exiftool -validate reports new warnings after the ${which} scrub: ${added.slice(0, 4).join(' / ')}`, `exiftool -validate -warning -a ${o.inFile} ${f}`, `val|${o.fixture}|${which}|${added.join('/')}`);
        integ[`validate ${which}`] = added.length ? added : 'no new warnings';
        const rows = nonStructural(exiftoolList(f));
        const list = rows.map((r) => `[${r.group}] ${r.tag}: ${r.value.slice(0, 80)}`);
        writeFileSync(join(OUT, 'exiftool', `${basename(f)}.txt`), list.join('\n') + '\n');
        exiftoolReport.push({ fixture: o.fixture, which, count: rows.length, redLooking: rows.filter((r) => RED_TAG.test(r.tag)).map((r) => `[${r.group}] ${r.tag}: ${r.value.slice(0, 60)}`), all: list });
        if (which === 'every-detail' && rows.length) {
          finding('low', o.fixture, 'every-detail output', `exiftool still shows ${rows.length} non-structural tag(s) after the every-detail scrub: ${list.slice(0, 6).join(' ; ')}${rows.length > 6 ? ' ; ...' : ''}`, `exiftool -a -u -U -G1 -ee3 -s ${f}`, `etall|${o.fixture}`);
        }
        if (which === 'red-only') {
          const gps = rows.filter((r) => r.group !== 'PNG' && (/GPS(Latitude|Longitude|Position|Coordinates)/i.test(r.tag) || /^(GPSCoordinates|Location)$/.test(r.tag)));
          const detail = `exiftool still reads a position from the red-only output: ${gps.map((r) => `[${r.group}] ${r.tag}: ${r.value}`).slice(0, 4).join(' ; ')}`;
          const reproduce = `exiftool -a -G1 -ee3 -U -gps:all -xmp:all ${f}`;
          if (gps.length) finding('critical', o.fixture, 'red-only output', detail, reproduce, `etgps|${o.fixture}`);
        }
      }
    }
    if (o.hdrKept && o.format === 'jpeg' && USE_EXIFTOOL && !o.rec.hdrFellBack) integ.gainMap = gainMapCheck(o);
    if (rec) rec.integrity = integ;
  }
  writeFileSync(join(OUT, 'exiftool-leftovers.json'), JSON.stringify(exiftoolReport, null, 1));
}

// The HDR gain map the red-and-amber selection keeps: a whole JPEG found through MPF, with the
// input gain map's pixels, the length the Container directory gives, and the input's
// hdrgm values (no more, no other).
const HDRGM_TAGS = new Set(['Version', 'GainMapMin', 'GainMapMax', 'Gamma', 'OffsetSDR', 'OffsetHDR', 'HDRCapacityMin', 'HDRCapacityMax', 'BaseRenditionIsHDR']);
function gainMapCheck(o) {
  const repro = `exiftool -b -MPImage2 ${o.startFile} > gm.jpg; compare with exiftool -b -MPImage2 ${o.inFile}`;
  const bad = (detail) => { finding('high', o.fixture, 'kept HDR gain map', detail, repro); return detail; };
  const extract = (f, tag) => spawnSync('exiftool', ['-b', `-${tag}`, f], { maxBuffer: 256 << 20 }).stdout;
  const gIn = extract(o.inFile, 'MPImage2');
  const gOut = extract(o.startFile, 'MPImage2');
  if (!gOut || !gOut.length) return bad('The red-and-amber selection keeps the HDR gain map, but exiftool finds no second image through MPF.');
  if (gOut[0] !== 0xff || gOut[1] !== 0xd8 || gOut[2] !== 0xff || gOut.indexOf(Buffer.from([0xff, 0xd9])) < 0) return bad('The image MPF points at is not a whole JPEG.');
  const safe = o.fixture.replace(/[^A-Za-z0-9._-]+/g, '_');
  const fIn = join(OUT, 'outputs', `${safe}.gainmap-in.jpg`);
  const fOut = join(OUT, 'outputs', `${safe}.gainmap-start.jpg`);
  writeFileSync(fIn, gIn);
  writeFileSync(fOut, gOut);
  const px = pilHashes([fIn, fOut]);
  if (!px[fOut] || !px[fOut].ok) return bad(`Pillow cannot decode the kept gain map: ${px[fOut] && px[fOut].error}`);
  if (px[fIn] && px[fIn].ok && px[fIn].hash !== px[fOut].hash) return bad('The kept gain map decodes to different pixels than the input gain map.');
  const text = readFileSync(o.startFile).toString('utf8');
  const item = /<Container:Item\b[^>]*Item:Semantic="GainMap"[^>]*>/.exec(text);
  const len = item && /Item:Length="(\d+)"/.exec(item[0]);
  if (len && Number(len[1]) !== gOut.length) return bad(`The Container directory gives the gain map ${len[1]} bytes, the MPF index ${gOut.length}.`);
  const hdrgm = (f) => tryRun('exiftool', ['-s', '-n', '-XMP-hdrgm:all', f]).out.split('\n').filter(Boolean).map((l) => l.replace(/\s+:\s?/, '=').trim());
  // A number written with more digits than a single-precision value has is written again
  // rounded to nine significant digits, so that rounded form counts as the input's value.
  const rounded = (x) => { const [k, v] = x.split('='); const n = Number(v); return v && Number.isFinite(n) && /\d/.test(v) ? `${k}=${String(Number(n.toPrecision(9)))}` : x; };
  const before = new Set(hdrgm(fIn).flatMap((x) => [x, rounded(x)]));
  const after = hdrgm(fOut);
  const odd = after.filter((x) => !before.has(x) || !HDRGM_TAGS.has(x.split('=')[0]));
  if (odd.length) return bad(`The kept gain map holds hdrgm values the input did not, or fields a gain map does not need: ${odd.join(', ')}.`);
  if ([...before].some((x) => x.startsWith('Version=')) && !after.some((x) => x.startsWith('Version='))) return bad('The kept gain map lost its hdrgm:Version.');
  // An Apple gain map keeps HDRGainMapVersion, the exact apdi:AuxiliaryImageType Chrome
  // requires, and the photo keeps the HDR numbers of its MakerNote (Apple tags 33 and 48).
  const APPLE_TYPE = 'urn:com:apple:photo:2020:aux:hdrgainmap';
  const appleXmp = (f) => tryRun('exiftool', ['-s', '-n', '-XMP-HDRGainMap:all', '-XMP-apdi:all', f]).out.split('\n').filter(Boolean).map((l) => l.replace(/\s+:\s?/, '=').trim());
  const aIn = appleXmp(fIn);
  const aOut = appleXmp(fOut);
  let apple = '';
  if (aIn.length) {
    const oddA = aOut.filter((x) => !aIn.includes(x) || !['HDRGainMapVersion', 'HDRGainMapHeadroom', 'AuxiliaryImageType'].includes(x.split('=')[0]) || (x.startsWith('AuxiliaryImageType=') && x !== `AuxiliaryImageType=${APPLE_TYPE}`));
    if (oddA.length) return bad(`The kept Apple gain map holds fields a gain map does not need: ${oddA.join(', ')}.`);
    if (aIn.includes(`AuxiliaryImageType=${APPLE_TYPE}`) && !aOut.includes(`AuxiliaryImageType=${APPLE_TYPE}`)) return bad('The kept Apple gain map lost its apdi:AuxiliaryImageType.');
    const head = (f) => tryRun('exiftool', ['-s', '-n', '-Apple:HDRHeadroom', '-Apple:HDRGain', f]).out.split('\n').filter(Boolean).map((l) => l.replace(/\s+:\s?/, '=').trim());
    const hIn = head(o.inFile);
    const hOut = head(o.startFile);
    // Only a number counts: a zero denominator (exiftool prints "undef") gives readers no headroom.
    const num = (x) => /^HDRHeadroom=-?\d/.test(x);
    if (hIn.some(num) && !hOut.some(num)) return bad('The photo lost the Apple HDR headroom the gain map needs.');
    apple = `, Apple: ${[...aOut, ...hOut].join(', ')}`;
  }
  return `whole JPEG, ${gOut.length} bytes, same pixels, directory length ${len ? len[1] : 'not given'}, ${after.length} hdrgm values${apple}`;
}

// ======================================================================================
// Main

const records = [];
const t0 = Date.now();
if (SECTIONS.has('registry')) await sectionRegistry(records);
if (SECTIONS.has('core')) await sectionCore(records);
if (SECTIONS.has('adversarial')) await sectionAdversarial(records);
toolChecks(records);
if (SECTIONS.has('reencode') || SECTIONS.has('adversarial')) await sectionReencode(records);
if (SECTIONS.has('hostile')) await sectionHostile(records);

// Things that held up, for the record.
for (const r of records.filter((x) => x.canaries)) {
  const leaksDefault = r.canaries.filter((c) => c.expected === 'red' && c.leftAfterDefault).length;
  const leaksStart = r.canaries.filter((c) => (c.expected === 'red' || c.expected === 'amber') && c.leftAfterStart).length;
  const leaksAll = r.canaries.filter((c) => c.leftAfterAll).length;
  const leaksMin = r.canaries.filter((c) => (c.expected === 'red' || c.expected === 'amber') && c.leftAfterMin).length;
  if (!leaksDefault && !leaksStart && !leaksMin && !leaksAll && r.canaries.length) pass(`${r.label}: all ${r.canaries.length} planted strings behave (no red left after the red-only scrub, no red or amber left after the red-and-amber selection${r.hdrKept ? ', which keeps the HDR gain map, or with the gain map ticked too' : ''}, nothing left with every detail ticked)`);
  if (r.hdrKept && r.integrity && typeof r.integrity.gainMap === 'string') pass(`${r.label}: the kept HDR gain map renders (${r.integrity.gainMap})`);
}
const order = { critical: 0, high: 1, medium: 2, low: 3 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.fixture.localeCompare(b.fixture));
const summary = Object.fromEntries(Object.keys(order).map((k) => [k, findings.filter((f) => f.severity === k).length]));
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ summary, findings, passed, records: records.map((r) => ({ ...r, items: r.items && r.items.map((i) => `${i.tier}:${i.id} ${i.label} = ${i.value}`) })) }, null, 1));
const txt = [
  `MetadataScrubber engine audit, ${new Date().toISOString()}`,
  `Findings: ${JSON.stringify(summary)}`,
  '',
  ...findings.map((f) => `[${f.severity.toUpperCase()}] ${f.fixture} | ${f.location}\n  ${f.detail}\n  Reproduce: ${f.reproduce}`),
  '',
  'Passed:',
  ...passed.map((p) => `  ${p}`),
].join('\n');
writeFileSync(join(OUT, 'report.txt'), txt + '\n');
log(`\nDone in ${Math.round((Date.now() - t0) / 1000)} s. Findings: ${JSON.stringify(summary)}. Report: ${join(OUT, 'report.txt')}`);
process.exitCode = summary.critical || summary.high ? 1 : 0;
