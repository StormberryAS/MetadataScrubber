// HEIC (ISO base media file format).
//
// Reads ftyp and meta (hdlr, pitm, iinf with infe v2 and v3, iloc versions 0 to 2 with all
// field sizes and construction methods 0 and 1, idat, iref, iprp with ipco and ipma, grpl).
// Every change but one is made IN PLACE: EXIF is edited by the TIFF engine inside its item,
// previews and extra pictures are zeroed, and whole boxes that must go (a colour profile,
// Content Credentials, vendor boxes, descriptive properties) become 'free' boxes filled
// with zeros. XMP is the exception: it is only kept in the canonical form (see rewriteXmp
// in xmp.js), with no padding, so a packet that changes changes length; spliceHeif moves
// what follows and writes the box sizes and the item location table again, then checks
// every item still reads exactly as before. Where it cannot, the packet is blanked instead.
//
// Apple's HDR gain map (an auxiliary image named exactly urn:com:apple:photo:2020:aux:
// hdrgainmap) is an amber detail kept to start with, with the fields of its own XMP a gain
// map defines and, when the MakerNote goes, a minimal MakerNote holding only Apple's two
// HDR numbers (as in a JPEG); the gain map and those numbers go together. An auxiliary
// image whose name is not on a fixed list is red.
//
// Everything outside the picture itself is accounted for: top-level boxes, meta children,
// item properties, image items the picture does not use, and bytes inside the media data
// that no item points at. What is not needed to show the picture is offered as an item.

import { concat, encodeLatin1, encodeUtf8, formatBytes, indexOfAscii, latin1, startsWith, subtractRanges, u16be, u32be, u64be, w16be, w32be, w64be, zeroRanges } from './bytes.js?v=4d7df4d3';
import { describeC2pa } from './c2pa.js?v=fcdff418';
import { ICC_TEXT_ITEM, ICC_UNREADABLE_ITEM, cleanIcc, iccDescription, iccFreeText, inspectIcc } from './icc.js?v=15403b52';
import { UNREADABLE, cappedId } from './taxonomy.js?v=93d7f069';
import { appleHdr, appleHdrAny, appleHdrValue, blankTiff, findTiffStart, isTiffHeader, parseTiff, removeTiffKeys, shrinkAppleNote, tiffItems } from './tiff.js?v=1288a27c';
import { APPLE_GAIN_MAP_TYPE, addXmpItems, canonicalXmp, gainAllowed, gainFields, gainFixes, keepOnlyXmp, parseXmp, planXmp } from './xmp.js?v=d8284a86';

// What a packet that goes becomes: the item stays, holding an empty packet.
const EMPTY_XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>';
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';
const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';
const IMAGE_TYPES = new Set(['hvc1', 'hev1', 'av01', 'grid', 'iden', 'iovl', 'jpeg', 'unci', 'tmap', 'hvt1', 'lhv1', 'avc1', 'j2k1', 'vvc1', 'mski']);
const TOP_STRUCTURAL = new Set(['ftyp', 'meta', 'mdat', 'moov', 'moof', 'mfra', 'styp', 'sidx', 'ssix', 'prft', 'pdin', 'meco', 'etyp']);
const META_STRUCTURAL = new Set(['hdlr', 'pitm', 'iinf', 'iloc', 'idat', 'iref', 'iprp', 'dinf', 'grpl', 'ipro', 'fiin', 'ipmc', 'mdat']);
// Item properties a decoder or viewer uses to show the picture.
const TECH_PROPS = new Set(['hvcC', 'av1C', 'vvcC', 'avcC', 'lhvC', 'ispe', 'pixi', 'colr', 'irot', 'imir', 'clap', 'auxC', 'rloc',
  'lsel', 'pasp', 'clli', 'mdcv', 'cclv', 'amve', 'reve', 'ndwt', 'a1op', 'a1lx', 'oinf', 'tols', 'iscl', 'j2kH', 'jpgC', 'uncC',
  'cmpd', 'cpat', 'cloc', 'splz', 'sbpm', 'snuc', 'cdef', 'mskC', 'cmin', 'cmex', 'ienc', 'iaux', 'free', 'skip', 'tmap', 'dpsc']);

export function isHeic(b) {
  if (b.length < 16 || !startsWith(b, 4, 'ftyp')) return false;
  const size = u32be(b, 0);
  if (size < 16 || size > b.length) return false;
  const brands = [latin1(b, 8, 12)];
  for (let p = 16; p + 4 <= size; p += 4) brands.push(latin1(b, p, p + 4));
  return brands.some((x) => HEIC_BRANDS.has(x));
}

// Lists the boxes in [start, end). A box that runs past `end` is reported as `damaged`
// (with its type and start) rather than listed; `rest` is where the walk stopped.
function boxes(b, start, end, warnings) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32be(b, p);
    const type = latin1(b, p + 4, p + 8);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) { out.damaged = { type, start: p }; break; }
      size = u64be(b, p + 8);
      hdr = 16;
    } else if (size === 0) size = end - p;
    let uuid = null;
    if (type === 'uuid' && p + hdr + 16 <= end) {
      uuid = Array.from(b.subarray(p + hdr, p + hdr + 16), (x) => x.toString(16).padStart(2, '0')).join('');
      hdr += 16;
    }
    if (size < hdr || p + size > end) {
      if (warnings) warnings.push(`The ${type.replace(/[^\x20-\x7e]/g, '?')} box is damaged or cut short.`);
      out.damaged = { type, start: p };
      break;
    }
    // ftyp only lists four-letter brands. A size that runs on past them would swallow the
    // boxes after it, so it ends where the brands stop and a box header follows.
    if (type === 'ftyp') {
      const after = p + size;
      const next = after + 8 <= end ? u32be(b, after) : 0;
      const fine = after === end || ((next === 0 || (next >= 8 && after + next <= end)) && after + 8 <= end && /^[\x20-\x7e]{4}$/.test(latin1(b, after + 4, after + 8)));
      for (let q = p + 16; !fine && q + 4 <= after; q += 4) {
        if (/^[\x20-\x7e]{4}$/.test(latin1(b, q, q + 4))) continue;
        if (warnings) warnings.push('The ftyp box has a wrong size.');
        size = q - p;
        break;
      }
    }
    out.push({ type, start: p, dataStart: p + hdr, end: p + size, uuid, large: hdr >= 16 && size !== 0 && u32be(b, p) === 1 });
    p += size;
  }
  out.rest = p;
  return out;
}

function readN(b, p, n) {
  if (n === 0) return 0;
  if (p + n > b.length) throw new Error('Field past the end');
  if (n === 4) return u32be(b, p);
  if (n === 8) return u64be(b, p);
  if (n === 2) return u16be(b, p);
  throw new Error('Unsupported field size');
}

function cstr(b, p, end) {
  let q = p;
  while (q < end && b[q] !== 0) q++;
  return [latin1(b, p, q), q + 1];
}

export function parseHeif(b) {
  const warnings = [];
  let top = boxes(b, 0, b.length, warnings);
  let meta = top.find((x) => x.type === 'meta');
  const model = { top, warnings, items: new Map(), refs: [], props: [], assoc: new Map(), essential: new Map(), groups: [], primary: -1, idat: null, metaKids: [], complete: true };
  if (!meta) { warnings.push('The HEIC file has no metadata box.'); model.complete = false; return model; }
  let kids = boxes(b, meta.dataStart + 4, meta.end, warnings);
  // A media data box inside meta means meta's size is wrong: meta ends where it starts, and
  // the boxes from there on are read at the top level again.
  let inner = kids.find((x) => x.type === 'mdat') || (kids.damaged && kids.damaged.type === 'mdat' ? kids.damaged : null);
  // Look for the media data box header itself inside meta, in case a damaged size made a
  // child of meta swallow it. Only a header that runs exactly to the end of the file, or to
  // another box header, counts, which a well-formed meta box never contains.
  if (!inner) {
    const boxAt = (q) => q + 8 <= b.length && u32be(b, q) >= 8 && q + u32be(b, q) <= b.length && /^[\x20-\x7e]{4}$/.test(latin1(b, q + 4, q + 8));
    const from = kids.damaged ? kids.damaged.start : meta.dataStart + 4;
    for (let q = indexOfAscii(b, 'mdat', from, meta.end); q >= 0; q = indexOfAscii(b, 'mdat', q + 1, meta.end)) {
      const at = q - 4;
      const size = u32be(b, at);
      if (at <= meta.dataStart) continue;
      if ((kids.damaged && (size === 0 || size === 1)) || (size >= 8 && (at + size === b.length || (at + size < b.length && boxAt(at + size))))) { inner = { start: at }; break; }
    }
  }
  if (inner) {
    warnings.push('The meta box has a wrong size.');
    meta = { ...meta, end: inner.start };
    const rest = boxes(b, inner.start, b.length, warnings);
    top = [...top.filter((x) => x.end <= meta.start), meta, ...rest];
    top.damaged = rest.damaged;
    top.rest = rest.rest;
    model.top = top;
    kids = boxes(b, meta.dataStart + 4, meta.end, warnings);
  }
  model.metaKids = kids;
  if (kids.damaged) model.complete = false;
  const get = (t) => kids.find((x) => x.type === t);

  const pitm = get('pitm');
  if (pitm && pitm.dataStart + (b[pitm.dataStart] === 0 ? 6 : 8) <= pitm.end) model.primary = b[pitm.dataStart] === 0 ? u16be(b, pitm.dataStart + 4) : u32be(b, pitm.dataStart + 4);

  const iinf = get('iinf');
  if (iinf) {
    const v = b[iinf.dataStart];
    const first = iinf.dataStart + 4 + (v === 0 ? 2 : 4);
    for (const e of boxes(b, first, iinf.end, warnings)) {
      if (e.type !== 'infe' || e.dataStart + 8 > e.end) continue;
      const ver = b[e.dataStart];
      let p = e.dataStart + 4;
      let id;
      let type = '';
      let contentType = '';
      let name;
      if (ver >= 2) {
        id = ver === 2 ? u16be(b, p) : u32be(b, p);
        p += ver === 2 ? 2 : 4;
        p += 2;
        type = latin1(b, p, Math.min(e.end, p + 4));
        p += 4;
        const [, after] = cstr(b, p, e.end);
        name = [p, Math.min(after - 1, e.end)];
        p = after;
        if (type === 'mime' || type === 'uri ') [contentType] = cstr(b, p, e.end);
      } else {
        id = u16be(b, p);
        p += 4;
        const [, after] = cstr(b, p, e.end);
        name = [p, Math.min(after - 1, e.end)];
        [contentType] = cstr(b, after, e.end);
        type = 'mime';
      }
      // infe: the box, so a removed image can be marked hidden; name: where the item's name
      // lies, a free string no reader needs (see structureFixes).
      model.items.set(id, { id, type, contentType, extents: [], method: 0, hidden: !!(b[e.dataStart + 3] & 1), infe: e, name });
    }
  }

  const idat = get('idat');
  if (idat) model.idat = { start: idat.dataStart, end: idat.end };

  const iloc = get('iloc');
  if (iloc) {
    const d = iloc.dataStart;
    const ver = b[d];
    let p = d + 4;
    try {
      const offSize = b[p] >> 4;
      const lenSize = b[p] & 15;
      const baseSize = b[p + 1] >> 4;
      const idxSize = ver === 1 || ver === 2 ? b[p + 1] & 15 : 0;
      p += 2;
      const count = ver < 2 ? readN(b, p, 2) : readN(b, p, 4);
      p += ver < 2 ? 2 : 4;
      // The table as written, so a rewrite (see spliceHeif) can write it again.
      const table = { box: iloc, version: ver, offSize, lenSize, baseSize, idxSize, entries: [] };
      let totalExtents = 0;
      for (let i = 0; i < count && p < iloc.end; i++) {
        const id = ver < 2 ? readN(b, p, 2) : readN(b, p, 4);
        p += ver < 2 ? 2 : 4;
        let method = 0;
        let methodField = 0;
        if (ver === 1 || ver === 2) { methodField = readN(b, p, 2); method = methodField & 15; p += 2; }
        const dataRef = readN(b, p, 2);
        p += 2;
        const base = readN(b, p, baseSize);
        p += baseSize;
        const n = readN(b, p, 2);
        p += 2;
        const extents = [];
        const raw = [];
        // A crafted table can claim up to 65,535 extents per item; far beyond any real file.
        if (n > 4096 || totalExtents + n > 65536) throw new Error('Too many extents');
        totalExtents += n;
        for (let k = 0; k < n; k++) {
          const idx = idxSize ? readN(b, p, idxSize) : 0;
          if (idxSize) p += idxSize;
          const off = readN(b, p, offSize);
          p += offSize;
          const len = readN(b, p, lenSize);
          p += lenSize;
          extents.push({ off: base + off, len });
          raw.push({ idx, off, len });
        }
        if (p > iloc.end) throw new Error('Location table past its box');
        table.entries.push({ id, methodField, method, dataRef, base, extents: raw });
        const item = model.items.get(id) || { id, type: '', contentType: '', extents: [] };
        item.method = method;
        item.ranges = [];
        for (const x of extents) {
          let s;
          let e;
          let limit;
          if (method === 0) { s = x.off; e = x.len ? s + x.len : b.length; limit = b.length; }
          else if (method === 1 && model.idat) { s = model.idat.start + x.off; e = x.len ? s + x.len : model.idat.end; limit = model.idat.end; }
          else { item.unsupported = true; continue; }
          if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e < s || s >= limit) {
            warnings.push(`Item ${id} points outside the file.`);
            item.broken = true;
            continue;
          }
          if (e > limit) {
            warnings.push(`Item ${id} runs past the end of the file.`);
            e = limit;
            item.truncated = true;
          }
          item.ranges.push([s, e]);
        }
        model.items.set(id, item);
      }
      if (table.entries.length === count && p === iloc.end) model.iloc = table;
    } catch {
      warnings.push('The item location table could not be read in full.');
      model.complete = false;
    }
  } else if (model.items.size) model.complete = false;

  const iref = get('iref');
  if (iref) {
    const v = b[iref.dataStart];
    for (const r of boxes(b, iref.dataStart + 4, iref.end, warnings)) {
      let p = r.dataStart;
      const w = v === 0 ? 2 : 4;
      if (p + w + 2 > r.end) continue;
      const from = v === 0 ? u16be(b, p) : u32be(b, p);
      p += w;
      const n = u16be(b, p);
      p += 2;
      const to = [];
      for (let i = 0; i < n && p + w <= r.end; i++) { to.push(v === 0 ? u16be(b, p) : u32be(b, p)); p += w; }
      model.refs.push({ type: r.type, from, to, box: r });
    }
  }

  // Item data never lies inside ftyp or the meta box (apart from idat). A location that
  // says otherwise is damaged: the item is marked, and its ranges lose those parts so that
  // removing it can never touch the file's own structure.
  const forbidden = [];
  const ftyp = top.find((x) => x.type === 'ftyp');
  if (ftyp) forbidden.push([ftyp.start, ftyp.end]);
  forbidden.push(...(model.idat ? subtract([[meta.start, meta.end]], [[model.idat.start, model.idat.end]]) : [[meta.start, meta.end]]));
  for (const it of model.items.values()) {
    if (!it.ranges || !it.ranges.some(([rs, re]) => forbidden.some(([fs, fe]) => rs < fe && re > fs))) continue;
    it.misplaced = true;
    it.ranges = subtract(it.ranges, forbidden);
    warnings.push(`Item ${it.id} points into the structure of the file.`);
  }

  const grpl = get('grpl');
  if (grpl) {
    for (const g of boxes(b, grpl.dataStart, grpl.end, warnings)) {
      let p = g.dataStart + 4;
      if (p + 8 > g.end) continue;
      p += 4;
      const n = u32be(b, p);
      p += 4;
      const ids = [];
      for (let i = 0; i < n && p + 4 <= g.end; i++) { ids.push(u32be(b, p)); p += 4; }
      model.groups.push({ type: g.type, ids });
    }
  }

  const iprp = get('iprp');
  if (iprp) {
    const ik = boxes(b, iprp.dataStart, iprp.end, warnings);
    const ipco = ik.find((x) => x.type === 'ipco');
    if (ipco) model.props = boxes(b, ipco.dataStart, ipco.end, warnings);
    for (const ipma of ik.filter((x) => x.type === 'ipma')) {
      const ver = b[ipma.dataStart];
      const flags = b[ipma.dataStart + 3];
      let p = ipma.dataStart + 4;
      if (p + 4 > ipma.end) continue;
      const n = u32be(b, p);
      p += 4;
      for (let i = 0; i < n && p < ipma.end; i++) {
        const id = ver < 1 ? u16be(b, p) : u32be(b, p);
        p += ver < 1 ? 2 : 4;
        const k = b[p++];
        const list = model.assoc.get(id) || [];
        const ess = model.essential.get(id) || new Set();
        for (let j = 0; j < k && p < ipma.end; j++) {
          const big = flags & 1;
          const raw = big ? u16be(b, p) : b[p];
          const idx = big ? raw & 0x7fff : raw & 0x7f;
          p += big ? 2 : 1;
          if (idx) { list.push(idx); if (raw & (big ? 0x8000 : 0x80)) ess.add(idx); }
        }
        model.assoc.set(id, list);
        model.essential.set(id, ess);
      }
    }
  }
  return model;
}

function propsOf(model, id, type) {
  return (model.assoc.get(id) || []).map((i) => model.props[i - 1]).filter((x) => x && (!type || x.type === type));
}

// Picture size after the clean aperture and any quarter-turn rotation.
function displaySize(b, model) {
  const id = model.primary;
  const ispe = propsOf(model, id, 'ispe')[0];
  let w = ispe && ispe.dataStart + 12 <= ispe.end ? u32be(b, ispe.dataStart + 4) : 0;
  let h = ispe && ispe.dataStart + 12 <= ispe.end ? u32be(b, ispe.dataStart + 8) : 0;
  const clap = propsOf(model, id, 'clap')[0];
  if (clap && clap.dataStart + 16 <= clap.end) {
    const wn = u32be(b, clap.dataStart);
    const wd = u32be(b, clap.dataStart + 4);
    const hn = u32be(b, clap.dataStart + 8);
    const hd = u32be(b, clap.dataStart + 12);
    if (wd && hd) { w = Math.round(wn / wd); h = Math.round(hn / hd); }
  }
  const irot = propsOf(model, id, 'irot')[0];
  if (irot && (b[irot.dataStart] & 3) % 2 === 1) [w, h] = [h, w];
  return { width: w, height: h };
}

function readItem(b, item) {
  const ranges = (item.ranges || []).filter(([s, e]) => s >= 0 && e >= s && e <= b.length);
  const total = ranges.reduce((n, [s, e]) => n + e - s, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const [s, e] of ranges) { out.set(b.subarray(s, e), o); o += e - s; }
  return out;
}

function writeItem(b, item, data) {
  let o = 0;
  for (const [s, e] of item.ranges) { b.set(data.subarray(o, o + e - s), s); o += e - s; }
}

// Items the primary picture is made from: its tiles or layers, and any auxiliary image
// (alpha, depth, gain map) attached to it, plus alternative codings grouped with it.
// HEVC item data is a run of NAL units, each after a length field whose size the hvcC
// property gives. Data whose first length cannot fit is not HEVC: the item's location is
// damaged and points at something else (for example the XMP), so it is not protected.
function notPictureData(b, model, it) {
  if (!['hvc1', 'hev1'].includes(it.type) || !it.ranges || !it.ranges.length) return false;
  const hvcC = propsOf(model, it.id, 'hvcC')[0];
  if (!hvcC || hvcC.dataStart + 22 > hvcC.end) return false;
  const size = (b[hvcC.dataStart + 21] & 3) + 1;
  if (size !== 4 && size !== 2 && size !== 1) return false;
  const total = it.ranges.reduce((n, [s, e]) => n + e - s, 0);
  const [s0, e0] = it.ranges[0];
  if (e0 - s0 < size) return true;
  let len = 0;
  for (let i = 0; i < size; i++) len = len * 256 + b[s0 + i];
  return len === 0 || len > total - size;
}

// skip: auxiliary images to leave out (ones being removed).
function pictureItems(model, skip = new Set()) {
  const seen = new Set();
  // Without a primary picture that is an image, nothing in the file is a picture to keep.
  const primary = model.items.get(model.primary);
  if (!primary || !IMAGE_TYPES.has(primary.type)) return seen;
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const r of model.refs) if (r.from === id && (r.type === 'dimg' || r.type === 'base')) r.to.forEach(visit);
  };
  visit(model.primary);
  for (const g of model.groups) if (g.type === 'altr' && g.ids.includes(model.primary)) g.ids.forEach(visit);
  for (let changed = true; changed;) {
    changed = false;
    for (const r of model.refs) {
      if (r.type === 'auxl' && !skip.has(r.from) && !seen.has(r.from) && r.to.some((t) => seen.has(t))) { const n = seen.size; visit(r.from); changed = changed || seen.size > n; }
    }
  }
  return seen;
}

// The primary picture's own data. Never zeroed. Picture data lives in the media data or
// idat boxes and never overlaps another item, so a damaged location that claims more than
// that protects only the part that can really be picture data.
function protectedRanges(model, length, skip = new Set()) {
  const picture = pictureItems(model, skip);
  let out = [];
  for (const id of picture) {
    const it = model.items.get(id);
    if (it && it.ranges && !it.misplaced) out.push(...it.ranges);
  }
  const homes = [...model.top, ...model.metaKids].filter((x) => x.type === 'mdat').map((x) => [x.dataStart, x.end]);
  const d = model.top.damaged;
  if (d && d.type === 'mdat') homes.push([d.start + 8, length]);
  if (model.idat) homes.push([model.idat.start, model.idat.end]);
  out = out.flatMap(([s, e]) => homes.map(([hs, he]) => [Math.max(s, hs), Math.min(e, he)]).filter(([a, c]) => c > a));
  const others = [];
  for (const it of model.items.values()) if (!picture.has(it.id) && it.ranges) others.push(...it.ranges);
  return subtract(out, others);
}

function allZero(b, ranges) {
  for (const [s, e] of ranges) for (let i = s; i < e; i++) if (b[i]) return false;
  return true;
}

function thumbnailItems(model) {
  const ids = new Set();
  for (const r of model.refs) if (r.type === 'thmb') ids.add(r.from);
  ids.delete(model.primary);
  return [...ids];
}

function itemTree(model, id, acc = new Set()) {
  if (acc.has(id)) return acc;
  acc.add(id);
  for (const r of model.refs) if (r.from === id && r.type === 'dimg') r.to.forEach((t) => itemTree(model, t, acc));
  return acc;
}

const rangesSize = (ranges) => ranges.reduce((n, [s, e]) => n + e - s, 0);

const subtract = subtractRanges;

function udesText(b, box) {
  const parts = [];
  let p = box.dataStart + 4;
  while (p < box.end && parts.length < 4) { const [s, after] = cstr(b, p, box.end); parts.push(s); p = after; }
  return parts.slice(1).filter(Boolean).join(', ');
}

// ======================================================================================
// Writing item data of a new length.
//
// XMP is only kept in the canonical form (see rewriteXmp in xmp.js), which has no padding,
// so a packet that changes changes length. spliceHeif replaces the data of whole items
// (and of top-level boxes such as the XMP uuid box) with new bytes, moves everything after
// them, and writes the box sizes and the item location table again so every item still
// points at its own data. An item spread over several extents gets one extent, where its
// first was. Returns the new file, or null when that cannot be done safely: a damaged or
// incomplete structure, a picture sequence (whose own tables would point at moved data),
// a field too small for the new value, or a result that does not read back exactly. The
// caller then falls back to editing in place.

function fits(v, size) {
  if (!Number.isSafeInteger(v) || v < 0) return false;
  if (size === 0) return v === 0;
  if (size === 4) return v <= 0xffffffff;
  return size === 8;
}

function putN(out, p, size, v) {
  if (size === 4) w32be(out, p, v);
  else if (size === 8) w64be(out, p, v);
}

// edits: [{ item, data }] for items in the location table, or [{ box, data }] for a
// top-level box whose content (after its header) becomes data.
export function spliceHeif(b, model, edits) {
  if (!edits.length) return b;
  // The structure as read: any warning about boxes or locations means it is not safe to move
  // anything. (Warnings about what an item holds, such as a zeroed picture, do not count.)
  const base0 = parseHeif(b);
  if (base0.warnings.length || !model.complete || model.top.damaged || model.metaKids.damaged) return null;
  if (model.top.some((x) => x.type === 'moov' || x.type === 'moof')) return null;
  const table = model.iloc;
  const itemEdits = new Map();
  const splices = [];
  for (const e of edits) {
    if (e.box) {
      if (!model.top.includes(e.box) && !model.metaKids.includes(e.box)) return null;
      splices.push({ start: e.box.dataStart, end: e.box.end, bytes: e.data });
      continue;
    }
    if (!table) return null;
    const it = e.item;
    const entry = table.entries.find((x) => x.id === it.id);
    if (!entry || itemEdits.has(it.id) || it.misplaced || it.broken || it.truncated || it.unsupported) return null;
    if (entry.method > 1 || !entry.extents.length || !table.lenSize || entry.extents.some((x) => !x.len)) return null;
    if (!it.ranges || it.ranges.length !== entry.extents.length) return null;
    itemEdits.set(it.id, e.data);
    it.ranges.forEach(([s, end], k) => splices.push({ start: s, end, bytes: k === 0 ? e.data : new Uint8Array(0), item: it.id }));
  }
  // The location table itself is written again when any item moves.
  if (table) splices.push({ start: table.box.start, end: table.box.end, bytes: null, iloc: true });
  splices.sort((x, y) => x.start - y.start);
  for (let i = 1; i < splices.length; i++) if (splices[i].start < splices[i - 1].end) return null;
  // No other item may share bytes with what is replaced.
  for (const it of model.items.values()) {
    if (itemEdits.has(it.id) || !it.ranges) continue;
    for (const [s, e] of it.ranges) if (splices.some((sp) => !sp.iloc && s < sp.end && e > sp.start)) return null;
  }
  // The size of the new location table: the same field sizes, one extent for each
  // replaced item.
  let ilocBytes = null;
  if (table) {
    const v = table.version;
    const idw = v < 2 ? 2 : 4;
    let size = 12 + 2 + idw;
    for (const en of table.entries) {
      const n = itemEdits.has(en.id) ? 1 : en.extents.length;
      size += idw + (v >= 1 ? 2 : 0) + 2 + table.baseSize + 2 + n * (table.idxSize + table.offSize + table.lenSize);
    }
    ilocBytes = new Uint8Array(size);
    splices.find((sp) => sp.iloc).bytes = ilocBytes;
  }
  const delta = (sp) => sp.bytes.length - (sp.end - sp.start);
  // Where a position that is not inside a replaced range lands.
  const map = (pos) => {
    let d = 0;
    for (const sp of splices) if (sp.end <= pos && sp.start < pos) d += delta(sp); else if (sp.start >= pos) break;
    return pos + d;
  };
  const inside = (box) => splices.filter((sp) => sp.start >= box.dataStart && sp.end <= box.end && !(sp.start === box.start));
  // Box sizes: every box that holds a replaced range grows or shrinks by its change.
  const sizeFix = [];
  for (const box of [...model.top, ...model.metaKids]) {
    if (table && box === table.box) continue;
    const within = inside(box);
    if (!within.length) continue;
    const size0 = box.end - box.start;
    const size = size0 + within.reduce((n, sp) => n + delta(sp), 0);
    const raw = u32be(b, box.start);
    if (raw === 0) continue;
    if (raw === 1) sizeFix.push({ at: box.start + 8, size, large: true });
    else if (size > 0xffffffff) return null;
    else sizeFix.push({ at: box.start, size, large: false });
  }

  // The new location table.
  if (table) {
    const v = table.version;
    const o = ilocBytes;
    let p = 0;
    const size = o.length;
    w32be(o, 0, size);
    o.set([0x69, 0x6c, 0x6f, 0x63], 4);
    o.set(b.subarray(table.box.dataStart, table.box.dataStart + 4), 8);
    o[12] = (table.offSize << 4) | table.lenSize;
    o[13] = (table.baseSize << 4) | (v >= 1 ? table.idxSize : 0);
    p = 14;
    if (v < 2) { w16be(o, p, table.entries.length); p += 2; } else { w32be(o, p, table.entries.length); p += 4; }
    const idat = model.idat;
    for (const en of table.entries) {
      const it = model.items.get(en.id);
      const data = itemEdits.get(en.id);
      // New absolute starts (file offsets; for idat, offsets from the start of its data).
      const rel = (abs) => (en.method === 1 ? map(abs) - map(idat.start) : map(abs));
      let ext;
      if (data) ext = [{ idx: en.extents[0].idx, at: rel(it.ranges[0][0]), len: data.length }];
      else {
        ext = en.extents.map((x) => {
          const absOld = en.method === 1 ? (idat ? idat.start + en.base + x.off : -1) : en.base + x.off;
          return { idx: x.idx, at: absOld < 0 ? -1 : rel(absOld), len: x.len };
        });
      }
      if (ext.some((x) => x.at < 0)) return null;
      let base = en.base;
      if (ext.some((x) => !fits(x.at - base, table.offSize) || x.at < base)) {
        if (!table.baseSize) return null;
        base = Math.min(...ext.map((x) => x.at));
      }
      if (!fits(base, table.baseSize)) return null;
      if (v < 2) { if (en.id > 0xffff) return null; w16be(o, p, en.id); p += 2; } else { w32be(o, p, en.id); p += 4; }
      if (v >= 1) { w16be(o, p, en.method); p += 2; }
      w16be(o, p, en.dataRef); p += 2;
      putN(o, p, table.baseSize, base); p += table.baseSize;
      w16be(o, p, ext.length); p += 2;
      for (const x of ext) {
        if (table.idxSize) { if (!fits(x.idx, table.idxSize)) return null; putN(o, p, table.idxSize, x.idx); p += table.idxSize; }
        const off = x.at - base;
        if (!fits(off, table.offSize) || !fits(x.len, table.lenSize)) return null;
        putN(o, p, table.offSize, off); p += table.offSize;
        putN(o, p, table.lenSize, x.len); p += table.lenSize;
      }
    }
    if (p !== size) return null;
  }

  // Assemble, then write the box sizes where the boxes now start.
  const parts = [];
  let at = 0;
  for (const sp of splices) {
    parts.push(b.subarray(at, sp.start), sp.bytes);
    at = sp.end;
  }
  parts.push(b.subarray(at));
  const out = concat(parts);
  for (const f of sizeFix) {
    const pos = map(f.at);
    if (f.large) w64be(out, pos, f.size); else w32be(out, pos, f.size);
  }

  // Read back: the same boxes, and every item holds exactly what it held, or its new data.
  const m2 = parseHeif(out);
  if (m2.warnings.length || !m2.complete) return null;
  const types = (list) => list.map((x) => x.type).join(',');
  if (types(m2.top) !== types(model.top) || types(m2.metaKids) !== types(model.metaKids)) return null;
  for (const it of model.items.values()) {
    const it2 = m2.items.get(it.id);
    if (!it.ranges) continue;
    if (!it2 || !it2.ranges) return null;
    const want = itemEdits.get(it.id) || readItem(b, it);
    const got = readItem(out, it2);
    if (want.length !== got.length || want.some((x, i) => x !== got[i])) return null;
  }
  for (const e of edits) {
    if (!e.box) continue;
    const box2 = model.top.includes(e.box) ? m2.top[model.top.indexOf(e.box)] : m2.metaKids[model.metaKids.indexOf(e.box)];
    const got = out.subarray(box2.dataStart, box2.end);
    if (got.length !== e.data.length || e.data.some((x, i) => x !== got[i])) return null;
  }
  // Every item keeps its kind, content type and hidden flag (an item list written again
  // changes names only).
  for (const it of base0.items.values()) {
    const it2 = m2.items.get(it.id);
    if (!it2 || it2.type !== it.type || it2.contentType !== it.contentType || it2.hidden !== it.hidden) return null;
  }
  return out;
}

// ======================================================================================
// Auxiliary images (alpha, depth, Apple's mattes and HDR gain map). Each names its kind in
// an auxC property with a string: only the fixed names below are kept as they are, so no
// free text rides along. Apple's names are followed by nothing; the MPEG ones may carry
// the coding's own description of the layer (SEI messages) after the name.
const AUX_NAMES = new Map([
  [APPLE_GAIN_MAP_TYPE, 'apple'],
  ['urn:com:apple:photo:2018:aux:portraiteffectsmatte', 'apple'],
  ['urn:com:apple:photo:2019:aux:semanticskinmatte', 'apple'],
  ['urn:com:apple:photo:2019:aux:semantichairmatte', 'apple'],
  ['urn:com:apple:photo:2019:aux:semanticteethmatte', 'apple'],
  ['urn:com:apple:photo:2020:aux:semanticskymatte', 'apple'],
  ['urn:com:apple:photo:2023:aux:semanticglassesmatte', 'apple'],
  ['urn:mpeg:hevc:2015:auxid:1', 'mpeg'],
  ['urn:mpeg:hevc:2015:auxid:2', 'mpeg'],
  ['urn:mpeg:mpegB:cicp:systems:auxiliary:alpha', 'mpeg'],
  ['urn:mpeg:mpegB:cicp:systems:auxiliary:depth', 'mpeg'],
]);

// What an auxC property says: { name, ok }. ok is true only for a listed name in its exact
// form: version and flags zero, and nothing after the name, except, for the MPEG names, the
// HEVC description of the layer (seiTailOk).
function auxName(b, p) {
  const s = p.dataStart + 4;
  if (s > p.end) return { name: '', ok: false };
  let z = s;
  while (z < p.end && b[z] !== 0) z++;
  const name = latin1(b, s, z);
  const kind = AUX_NAMES.get(name);
  const zeroHead = b[p.dataStart] === 0 && b[p.dataStart + 1] === 0 && b[p.dataStart + 2] === 0 && b[p.dataStart + 3] === 0;
  const ok = !!kind && zeroHead && z < p.end && (z + 1 === p.end || (kind === 'mpeg' && seiTailOk(b.subarray(z + 1, p.end))));
  return { name, ok };
}

// The bytes after an MPEG layer name (aux_subtype, ISO/IEC 23008-12): as Apple and others
// write it, a 32-bit length and then that many bytes of HEVC SEI NAL units, each after its
// own 32-bit length. Kept only when every byte is accounted for and each unit holds only
// alpha_channel_info (165) or depth_representation_info (177) messages, which are numbers.
function seiTailOk(t) {
  if (t.length < 4 || u32be(t, 0) !== t.length - 4) return false;
  let p = 4;
  let units = 0;
  while (p < t.length) {
    if (p + 4 > t.length) return false;
    const n = u32be(t, p);
    p += 4;
    if (n < 3 || p + n > t.length) return false;
    if (!seiNalOk(t.subarray(p, p + n))) return false;
    p += n;
    units++;
  }
  return units > 0 && units <= 4;
}

function seiNalOk(nal) {
  const type = (nal[0] >> 1) & 0x3f;
  if (nal[0] & 0x80 || (type !== 39 && type !== 40) || (nal[0] & 1) || (nal[1] >> 3) || !(nal[1] & 7)) return false;
  // The message bytes without emulation prevention (00 00 03 becomes 00 00).
  const r = [];
  for (let i = 2; i < nal.length; i++) {
    if (i >= 4 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    r.push(nal[i]);
  }
  let p = 0;
  let msgs = 0;
  while (p < r.length) {
    if (r[p] === 0x80 && p === r.length - 1) break;
    let type2 = 0;
    while (r[p] === 0xff) { type2 += 255; p++; }
    if (p >= r.length) return false;
    type2 += r[p++];
    let size = 0;
    while (r[p] === 0xff) { size += 255; p++; }
    if (p >= r.length) return false;
    size += r[p++];
    if ((type2 !== 165 && type2 !== 177) || p + size > r.length) return false;
    p += size;
    msgs++;
  }
  return msgs > 0;
}

// The data of an auxiliary image and of the images it is made of (a grid's layout and its
// tiles), which is zeroed when the image goes.
function codedRanges(model, id) {
  const out = [];
  for (const t of itemTree(model, id)) {
    const it = model.items.get(t);
    if (it && it.ranges && !it.misplaced && IMAGE_TYPES.has(it.type)) out.push(...it.ranges);
  }
  return out;
}

// ======================================================================================
// The file's own structure, written in one fixed form. Some fields no reader needs can hold
// free text or free numbers: the minor version and unknown brands in ftyp, the reserved
// fields and handler name in hdlr, the flags of each item entry beyond "hidden", each item's
// name, and the bytes between the start of the EXIF item and its TIFF header. They are set
// to fixed values whenever the file is written (so a file holding anything there changes
// even with nothing ticked), in place where the size stays and by writing the item list
// again for the names.

const KNOWN_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'mif2', 'mif3', 'msf1',
  'miaf', 'MiHE', 'MiHB', 'MiHA', 'MiHP', 'MiPr', 'MiAn', 'MiCm', 'MiCo', 'tmap', 'avif', 'avis', 'avio', 'jpeg', 'jpgs',
  'iso8', 'isom', 'mp41', 'mp42', 'unif', 'vvic', 'vvi1', 'j2ki', 'j2is']);

function structureFixes(b, model) {
  const patches = [];
  const put = (pos, bytes) => { if (bytes.some((x, i) => b[pos + i] !== x)) patches.push([pos, bytes]); };
  const ftyp = model.top.find((x) => x.type === 'ftyp');
  if (ftyp && ftyp.dataStart + 8 <= ftyp.end) {
    if (!KNOWN_BRANDS.has(latin1(b, ftyp.dataStart, ftyp.dataStart + 4))) put(ftyp.dataStart, encodeLatin1('mif1'));
    put(ftyp.dataStart + 4, new Uint8Array(4));
    for (let p = ftyp.dataStart + 8; p + 4 <= ftyp.end; p += 4) if (!KNOWN_BRANDS.has(latin1(b, p, p + 4))) put(p, encodeLatin1('mif1'));
  }
  const hdlr = model.metaKids.find((x) => x.type === 'hdlr');
  if (hdlr && hdlr.dataStart + 24 <= hdlr.end) {
    put(hdlr.dataStart, new Uint8Array(4));
    put(hdlr.dataStart + 4, new Uint8Array(4));
    put(hdlr.dataStart + 12, new Uint8Array(hdlr.end - hdlr.dataStart - 12));
  }
  for (const it of model.items.values()) {
    if (!it.infe || it.infe.large) continue;
    const f = it.infe.dataStart;
    put(f + 1, new Uint8Array([0, 0, b[f + 3] & 1]));
  }
  const names = [...model.items.values()].filter((it) => it.infe && !it.infe.large && it.name && it.name[1] > it.name[0] && it.name[1] < it.infe.end && b[it.name[1]] === 0);
  return { patches, names };
}

// The EXIF item's bytes before its TIFF header as written by Apple and the specification:
// their count, then "Exif\0\0" when there are six, otherwise zeros.
function exifPrefix(off) {
  if (off < 4) return null;
  const out = new Uint8Array(off);
  w32be(out, 0, off - 4);
  if (off - 4 === 6) out.set(encodeLatin1('Exif\0\0'), 4);
  return out;
}

// The item list with every item's name empty (the zero that ends it stays), or null.
function iinfWithoutNames(b, model, names) {
  const iinf = model.metaKids.find((x) => x.type === 'iinf');
  if (!iinf || iinf.large) return null;
  const first = iinf.dataStart + 4 + (b[iinf.dataStart] === 0 ? 2 : 4);
  const kids = boxes(b, first, iinf.end);
  if (kids.damaged || kids.rest !== iinf.end) return null;
  const byStart = new Map(names.map((it) => [it.infe.start, it]));
  const parts = [b.subarray(iinf.dataStart, first)];
  for (const k of kids) {
    const it = byStart.get(k.start);
    if (!it) { parts.push(b.subarray(k.start, k.end)); continue; }
    const body = concat([b.subarray(k.dataStart, it.name[0]), b.subarray(it.name[1], k.end)]);
    const head = new Uint8Array(8);
    w32be(head, 0, body.length + 8);
    head.set(encodeLatin1('infe'), 4);
    parts.push(head, body);
  }
  return { box: iinf, data: concat(parts) };
}

export function analyseHeic(b, set) {
  const model = parseHeif(b);
  for (const it of model.items.values()) {
    // An item this tool zeroed earlier (a removed layer) holds no data, not damaged data.
    if (!it.misplaced && it.ranges && !allZero(b, it.ranges) && notPictureData(b, model, it)) {
      it.misplaced = true;
      model.warnings.push(`Item ${it.id} does not hold the picture data it claims.`);
    }
  }
  for (const x of model.warnings) set.warn(x);
  const size = displaySize(b, model);
  model.width = size.width;
  model.height = size.height;
  // HEIC viewers turn the picture with the irot and imir properties and ignore the EXIF
  // rotation flag, so removing that flag never changes how the picture looks.
  model.orientation = 1;
  model.exif = [];
  model.xmp = [];
  const seenUnknown = new Set();
  const unknownBox = (box, what) => {
    const id = cappedId(seenUnknown, `heic:box:${what.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'data'}`, 'heic:box:other');
    set.add({ id, ...UNREADABLE.unknown, value: `${id === 'heic:box:other' ? 'Several kinds' : what}, ${formatBytes(box.end - box.start)}`, source: 'HEIC' }, { kind: 'boxes', boxes: [box] });
  };

  // Auxiliary images and the names their auxC properties give. Apple's HDR gain map is the
  // one attached to the primary picture with exactly Apple's name; it is kept to start with
  // (amber), with the fields of its own XMP a gain map defines. Any auxiliary image whose
  // name is not one of the fixed names is a red detail of its own.
  const auxes = [];
  for (const r of model.refs) {
    if (r.type !== 'auxl' || auxes.some((a) => a.id === r.from)) continue;
    const props = propsOf(model, r.from, 'auxC');
    const names = props.map((p) => auxName(b, p));
    auxes.push({ id: r.from, props, names, refs: model.refs.filter((x) => x.type === 'auxl' && x.from === r.from), ok: names.length > 0 && names.every((n) => n.ok) });
  }
  const gain = auxes.find((a) => a.ok && a.names.length === 1 && a.names[0].name === APPLE_GAIN_MAP_TYPE
    && a.refs.length === 1 && a.refs[0].to.length === 1 && a.refs[0].to[0] === model.primary) || null;
  for (const a of auxes) if (a !== gain && a.names.some((n) => n.name === APPLE_GAIN_MAP_TYPE)) a.ok = false;
  model.gain = gain;
  model.gainXmp = [];
  const describes = (from, to) => model.refs.some((r) => r.type === 'cdsc' && r.from === from && r.to.includes(to));

  const picture = pictureItems(model);
  const thumbs = thumbnailItems(model);
  const thumbTree = new Set();
  for (const id of thumbs) for (const t of itemTree(model, id)) thumbTree.add(t);

  for (const item of model.items.values()) {
    if (!item.ranges || item.unsupported || !item.ranges.length) {
      if (item.type === 'Exif' || item.contentType === 'application/rdf+xml' || item.unsupported) set.warn('Some metadata is stored in a way this tool cannot edit; it was left as it is.');
      continue;
    }
    // Items this tool blanked earlier keep their place in the structure but hold only zeros.
    if (allZero(b, item.ranges)) continue;
    if (item.type === 'Exif') {
      const data = readItem(b, item);
      let off = data.length >= 4 ? 4 + u32be(data, 0) : -1;
      if (off < 0 || !isTiffHeader(data, off)) off = findTiffStart(data, 64);
      const m = off >= 0 ? parseTiff(data.subarray(off)) : null;
      if (!m || m.damaged) {
        if (m) for (const x of m.warnings) set.warn(x);
        set.add({ id: 'exif:unreadable', group: 'hidden', tier: 'red', label: 'EXIF data that could not be read', value: formatBytes(data.length), source: 'EXIF', note: 'It may hold anything, so removing it is the safe choice.' }, { kind: 'zero', ranges: item.ranges });
        continue;
      }
      for (const x of m.warnings) set.warn(x);
      const entry = { item, off };
      const want = exifPrefix(off);
      if (want && want.some((x, i) => data[i] !== x)) { entry.prefix = want; set.normalise = true; }
      model.exif.push(entry);
      for (const it of tiffItems(m)) {
        const pub = { id: `exif:${it.key}`, group: it.group, tier: it.tier, label: it.label, value: it.value, source: 'EXIF' };
        if (it.note) pub.note = it.note;
        if (it.key === 'orientation') pub.note = 'HEIC viewers use their own rotation setting, so removing this does not turn the picture.';
        set.add(pub, { kind: 'exif', entry, key: it.key });
      }
      continue;
    }
    if (item.type === 'mime' && /rdf\+xml|xmp/i.test(item.contentType)) {
      const data = readItem(b, item);
      // A packet this tool emptied earlier holds nothing.
      if (latin1(data) === EMPTY_XMP) continue;
      const parsed = parseXmp(new TextDecoder('utf-8').decode(data));
      // about: the items this packet describes, so it can go with an auxiliary image.
      const entry = { item, parsed, length: data.length, items: [], about: model.refs.filter((r) => r.type === 'cdsc' && r.from === item.id).flatMap((r) => r.to) };
      // The HDR gain map's own description: the fields a gain map defines stay with it;
      // anything else in it is a red detail of its own.
      if (gain && describes(item.id, gain.id)) {
        entry.gain = true;
        model.gainXmp.push(entry);
        const canon = canonicalXmp(parsed, true);
        const allowed = canon === null ? new Set() : gainAllowed(parsed, 'gainmap');
        const extra = parsed.props.filter((p, i) => !allowed.has(i));
        if (canon === null || canon !== parsed.text) set.normalise = true;
        if (canon === null || extra.length) {
          const names = canon === null ? ['XMP data that could not be read'] : [...new Set(extra.map((p) => p.key))];
          entry.extra = set.add({ id: 'heic:gain-map:metadata', group: 'hidden', tier: 'red', label: 'Metadata inside the HDR gain map', value: names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '), source: 'XMP', note: 'Fields in the HDR gain map\'s own description that the gain map does not need. They may hold anything. Removing them keeps the gain map.' }, { kind: 'gainxmp', entry });
        }
        continue;
      }
      model.xmp.push(entry);
      // Written without the packet wrapper, as Apple writes the XMP of a HEIC photo, so the
      // wrapper is not a choice the file can make.
      entry.items = addXmpItems(set, parsed, { compact: true }, { kind: 'xmp', entry }, data.length);
      continue;
    }
    if (!IMAGE_TYPES.has(item.type)) {
      const what = item.type === 'mime' || item.type === 'uri ' ? item.contentType || item.type.trim() : item.type.trim();
      set.add({ id: `heic:item:${item.id}`, ...UNREADABLE.unknown, value: `${what || 'data'}, ${formatBytes(rangesSize(item.ranges))}`, source: 'HEIC' }, { kind: 'zero', ranges: item.ranges });
      continue;
    }
    // An image the picture does not use and that is not its preview: a second picture.
    if (!picture.has(item.id) && !thumbTree.has(item.id)) {
      const ispe = propsOf(model, item.id, 'ispe')[0];
      const dims = ispe && ispe.dataStart + 12 <= ispe.end ? `${u32be(b, ispe.dataStart + 4)} × ${u32be(b, ispe.dataStart + 8)} pixels, ` : '';
      set.add({ id: 'heic:extra-image', group: 'hidden', tier: 'red', label: 'Extra picture inside the file', value: `${dims}${formatBytes(rangesSize(item.ranges))}`, source: 'HEIC', note: 'A picture the main image does not use. It could be an earlier or uncropped version, with its own metadata.' }, { kind: 'zero', ranges: item.ranges, hide: [item.id] });
    }
  }

  // A preview this tool blanked earlier stays in the structure but holds only zeros.
  const liveThumbs = thumbs.filter((id) => {
    const it = model.items.get(id);
    return it && it.ranges && it.ranges.length && !allZero(b, it.ranges);
  });
  if (liveThumbs.length) {
    const ranges = [];
    let dims = '';
    for (const id of liveThumbs) {
      for (const t of itemTree(model, id)) {
        const it = model.items.get(t);
        if (it && it.ranges) ranges.push(...it.ranges);
      }
      const ispe = propsOf(model, id, 'ispe')[0];
      if (ispe && !dims && ispe.dataStart + 12 <= ispe.end) dims = `${u32be(b, ispe.dataStart + 4)} × ${u32be(b, ispe.dataStart + 8)} pixels, `;
    }
    set.add({ id: 'heic:thumbnail', group: 'hidden', tier: 'red', label: 'Built-in preview image', value: `${dims}${formatBytes(rangesSize(ranges))}`, source: 'HEIC', note: 'Can still show the original, uncropped photo after cropping.' }, { kind: 'thumbnail', ranges });
  }

  // Item properties: colour profiles stored as ICC data (not the nclx kind, which the
  // decoder needs), descriptive text, and anything this tool does not know.
  const colr = model.props.filter((p) => p.type === 'colr' && (startsWith(b, p.dataStart, 'prof') || startsWith(b, p.dataStart, 'rICC')));
  if (colr.length) {
    // Each profile is checked: an unreadable one is offered whole, as red; text that is not
    // a known name is a red detail, rewritten in place (the box keeps its size).
    const infos = colr.map((p) => ({ p, info: inspectIcc(b.subarray(p.dataStart + 4, p.end)) }));
    const bad = infos.filter((x) => !x.info.ok).map((x) => x.p);
    const good = infos.filter((x) => x.info.ok);
    if (bad.length) set.add({ ...ICC_UNREADABLE_ITEM, value: formatBytes(rangesSize(bad.map((p) => [p.start, p.end]))) }, { kind: 'boxes', boxes: bad });
    if (good.length) {
      const desc = iccDescription(b.subarray(good[0].p.dataStart + 4, good[0].p.end));
      set.add({ id: 'icc:profile', group: 'technical', tier: 'green', label: 'Colour profile', value: desc, source: 'ICC profile', note: 'Keeps colours accurate on different screens.' }, { kind: 'boxes', boxes: good.map((x) => x.p) });
      const dirty = good.filter((x) => !x.info.clean);
      if (dirty.length) set.add({ ...ICC_TEXT_ITEM, value: iccFreeText(dirty[0].info) }, { kind: 'icctext', boxes: dirty.map((x) => x.p) });
    }
  }
  const essentialIdx = new Set();
  for (const ess of model.essential.values()) for (const i of ess) essentialIdx.add(i);
  const describe = { udes: [], altt: [], times: [] };
  model.props.forEach((p, i) => {
    if (TECH_PROPS.has(p.type) || p.type === 'colr') return;
    if (essentialIdx.has(i + 1)) { set.warn(`The picture needs a property this tool does not know (${p.type.replace(/[^\x20-\x7e]/g, '?')}); it was kept.`); return; }
    if (allZero(b, [[p.dataStart, p.end]])) return;
    if (p.type === 'udes') describe.udes.push(p);
    else if (p.type === 'altt') describe.altt.push(p);
    // A creation or modification time is a version 0 property holding one 64-bit number
    // (ISO/IEC 23008-12); any other size or header holds data a time does not have.
    else if (p.type === 'crtt' || p.type === 'mdft') {
      if (p.end - p.dataStart === 12 && b[p.dataStart] === 0 && !b[p.dataStart + 1] && !b[p.dataStart + 2] && !b[p.dataStart + 3]) describe.times.push(p);
      else unknownBox(p, `${p.type} property`);
    }
    else unknownBox(p, `${p.type.replace(/[^\x20-\x7e]/g, '?')} property`);
  });
  if (describe.udes.length) {
    set.add({ id: 'heic:description', group: 'who', tier: 'red', label: 'Name and description stored with the picture', value: udesText(b, describe.udes[0]) || formatBytes(rangesSize(describe.udes.map((p) => [p.start, p.end]))), source: 'HEIC', note: 'Free text written by a person or an app. It can hold names, places or notes.' }, { kind: 'boxes', boxes: describe.udes });
  }
  if (describe.altt.length) {
    set.add({ id: 'heic:alt-text', group: 'hidden', tier: 'red', label: 'Text description of the picture', value: udesText(b, describe.altt[0]) || formatBytes(describe.altt[0].end - describe.altt[0].start), source: 'HEIC', note: 'Free text written by a person or an app. It can hold names, places or notes.' }, { kind: 'boxes', boxes: describe.altt });
  }
  if (describe.times.length) {
    set.add({ id: 'heic:times', group: 'when', tier: 'amber', label: 'Creation and modification time', value: `${describe.times.length} time field${describe.times.length === 1 ? '' : 's'}`, source: 'HEIC' }, { kind: 'boxes', boxes: describe.times });
  }

  // Top-level boxes and the children of meta.
  const c2pa = [];
  const leftovers = [];
  for (const box of model.top) {
    if (TOP_STRUCTURAL.has(box.type)) continue;
    if (box.type === 'free' || box.type === 'skip') { if (!allZero(b, [[box.dataStart, box.end]])) leftovers.push(box); continue; }
    if (box.type === 'uuid' && box.uuid === C2PA_UUID) { c2pa.push(box); continue; }
    if (box.type === 'uuid' && box.uuid === XMP_UUID) {
      if (allZero(b, [[box.dataStart, box.end]]) || latin1(b, box.dataStart, box.end) === EMPTY_XMP) continue;
      const item = { ranges: [[box.dataStart, box.end]] };
      const data = b.subarray(box.dataStart, box.end);
      const parsed = parseXmp(new TextDecoder('utf-8').decode(data));
      const entry = { item, parsed, length: data.length, items: [], box };
      model.xmp.push(entry);
      entry.items = addXmpItems(set, parsed, { compact: true }, { kind: 'xmp', entry }, data.length);
      continue;
    }
    unknownBox(box, box.type === 'uuid' ? `uuid ${(box.uuid || '').slice(0, 8)} box` : `${box.type.replace(/[^\x20-\x7e]/g, '?')} box`);
  }
  for (const box of model.metaKids) {
    if (META_STRUCTURAL.has(box.type)) continue;
    if (box.type === 'free' || box.type === 'skip') { if (!allZero(b, [[box.dataStart, box.end]])) leftovers.push(box); continue; }
    unknownBox(box, `${box.type.replace(/[^\x20-\x7e]/g, '?')} box`);
  }
  if (c2pa.length) {
    const d = describeC2pa(c2pa.map((x) => b.subarray(x.dataStart, x.end)));
    set.add({ id: 'heic:c2pa', group: 'hidden', tier: d.tier, label: 'Content Credentials (C2PA)', value: d.value, source: 'C2PA', note: d.note }, { kind: 'boxes', boxes: c2pa });
    model.c2pa = true;
  }

  // Bytes in the media data (or in idat) that no item points at. When the list of parts
  // is damaged, that includes metadata this tool could not place, so it is offered too.
  const gaps = [];
  if (model.top.some((x) => x.type === 'moov' || x.type === 'moof')) {
    set.warn('This file also holds a picture sequence or a video. It was left as it is.');
  } else {
    const used = [];
    for (const it of model.items.values()) if (it.ranges && !it.misplaced) used.push(...it.ranges);
    for (const box of [...model.top, ...model.metaKids].filter((x) => x.type === 'mdat')) gaps.push(...subtract([[box.dataStart, box.end]], used));
    // A media data box whose size is wrong still holds the data up to the end of the file.
    const d = model.top.damaged;
    if (d && d.type === 'mdat') gaps.push(...subtract([[Math.min(b.length, d.start + (u32be(b, d.start) === 1 ? 16 : 8)), b.length]], used));
    if (model.idat) gaps.push(...subtract([[model.idat.start, model.idat.end]], used));
  }
  const dirty = gaps.filter((r) => !allZero(b, [r]));
  if (dirty.length || leftovers.length) {
    const ranges = [...dirty, ...leftovers.map((x) => [x.dataStart, x.end])];
    const sure = model.complete && ![...model.items.values()].some((i) => i.unsupported || i.broken || i.misplaced);
    set.add(sure
      ? { id: 'heic:leftover', group: 'hidden', tier: 'red', label: 'Leftover data that nothing uses', value: formatBytes(rangesSize(ranges)), source: 'HEIC', note: 'Bytes no part of the picture points at, often left behind by an earlier edit. They can still hold old values.' }
      : { id: 'heic:leftover', group: 'hidden', tier: 'red', label: 'Data this tool cannot place', value: formatBytes(rangesSize(ranges)), source: 'HEIC', note: "The file's list of parts is damaged, so this tool cannot tell what these bytes are. They may hold metadata, or what is left of the picture." },
    { kind: 'zero', ranges });
  }

  // A box cut short or with a wrong size, or bytes after the last box: at the top level,
  // and inside meta, where the walk could not go on.
  const damaged = [];
  const tailStart = model.top.damaged ? model.top.damaged.start : model.top.rest;
  if (tailStart < b.length && !(model.top.damaged && model.top.damaged.type === 'mdat')) damaged.push([tailStart, b.length]);
  const metaBox = model.top.find((x) => x.type === 'meta');
  if (metaBox && model.metaKids.damaged) damaged.push([model.metaKids.damaged.start, metaBox.end]);
  const dirtyDamage = damaged.filter((r) => !allZero(b, [r]));
  if (dirtyDamage.length) {
    set.add({ id: 'heic:damaged', ...UNREADABLE.damaged, value: formatBytes(rangesSize(dirtyDamage)), source: 'HEIC' }, { kind: 'zero', ranges: dirtyDamage });
  }

  const dimsOf = (id) => {
    const ispe = propsOf(model, id, 'ispe')[0];
    return ispe && ispe.dataStart + 12 <= ispe.end ? `${u32be(b, ispe.dataStart + 4)} × ${u32be(b, ispe.dataStart + 8)} pixels, ` : '';
  };
  if (gain) {
    // Apple's gain map needs the HDR headroom from the photo's Apple MakerNote: those two
    // numbers are a detail of their own (amber, kept with the gain map), so the rest of the
    // MakerNote can go without them.
    const ex = model.exif.find((e) => describes(e.item.id, model.primary)) || model.exif[0];
    let v = null;
    let any = null;
    if (ex) {
      const m = parseTiff(readItem(b, ex.item).subarray(ex.off));
      v = m && !m.damaged ? appleHdr(m) : null;
      any = m && !m.damaged ? appleHdrAny(m) : null;
    }
    // Without those numbers, or a headroom in the gain map's own description, no screen can
    // show the gain map in HDR: it is then red, like any extra picture.
    const ownHeadroom = model.gainXmp.some((e) => gainFields(e.parsed, 'gainmap')['HDRGainMap:HDRGainMapHeadroom']);
    const usable = !!any || ownHeadroom;
    set.add({ id: 'heic:gain-map', group: 'hidden', tier: usable ? 'amber' : 'red', label: 'HDR gain map', value: `Apple, ${dimsOf(gain.id)}${formatBytes(rangesSize(codedRanges(model, gain.id)))}`, source: 'HEIC', note: usable ? 'Keeps the extra brightness on HDR screens. It is a second, smaller picture of the same scene: if you edited or blurred this photo in another app first, the hidden picture may still show the original.' : GAIN_MAP_UNUSABLE }, { kind: 'gainmap', aux: gain, couple: [] });
    if (v && !set.has('exif:apple-hdr')) {
      set.add({ id: 'exif:apple-hdr', group: 'hidden', tier: 'amber', label: 'Apple HDR brightness', value: appleHdrValue(v), source: 'EXIF', note: 'Two numbers from the Apple maker notes that tell HDR screens how much brighter the gain map may make the photo. They stay with the gain map in a maker note of their own when the rest of the maker notes go. Removing them removes the HDR gain map too.' }, { kind: 'applehdr', entry: ex, values: v });
    }
    if (set.has('exif:apple-hdr')) set.get('heic:gain-map').couple.push('exif:apple-hdr');
  }
  const odd = auxes.filter((a) => !a.ok && model.items.get(a.id));
  if (odd.length) {
    const name = odd.flatMap((a) => a.names.filter((n) => !n.ok).map((n) => n.name)).find(Boolean) || 'no label';
    const size = rangesSize(odd.flatMap((a) => codedRanges(model, a.id)));
    set.add({ id: 'heic:aux-image', group: 'hidden', tier: 'red', label: 'Extra image layer with an unrecognised label', value: `${name.replace(/[^\x20-\x7e]/g, '?').slice(0, 60)}, ${dimsOf(odd[0].id)}${formatBytes(size)}`, source: 'HEIC', note: 'A layer attached to the picture whose label is not one of the known kinds (transparency, depth, portrait mattes, HDR gain map). The label and the layer may hold anything. Removing it leaves the picture itself unchanged.' }, { kind: 'aux', auxes: odd });
  }
  const kept = auxes.filter((a) => a.ok && a !== gain && !a.names.every((n) => /auxid:1$|alpha$/.test(n.name)));
  if (kept.length) {
    set.warn('This HEIC file also holds a depth map or another extra image layer. It stays in the file, because removing it without re-saving the picture would break it.');
  }
  model.fixes = structureFixes(b, model);
  if (model.fixes.patches.length || model.fixes.names.length) set.normalise = true;
  return model;
}

export const GAIN_MAP_UNUSABLE = 'An Apple HDR gain map without the HDR brightness it needs, so no screen can show it in HDR. It is a second picture that may hold anything, so it is removed by default. Removing it leaves the normal picture unchanged.';

export function scrubHeic(b, model, set, removeIn) {
  const remove = new Set(removeIn);
  const warnings = [];
  const out = b.slice();
  const zero = [];
  const exifKeys = new Map();
  const blank = [];
  let thumbs = false;
  const iccBoxes = [];
  // The HDR gain map and Apple's HDR brightness go together, in either direction.
  const gainItem = set.has('heic:gain-map') ? set.get('heic:gain-map') : null;
  if (gainItem && (remove.has('heic:gain-map') || gainItem.couple.some((c) => remove.has(c)))) {
    remove.add('heic:gain-map');
    for (const c of gainItem.couple) remove.add(c);
  }
  const unlink = [];
  const hideIds = [];
  for (const id of remove) {
    const it = set.get(id);
    if (!it) continue;
    if (it.kind === 'exif') {
      if (!exifKeys.has(it.entry)) exifKeys.set(it.entry, new Set());
      exifKeys.get(it.entry).add(it.key);
    } else if (it.kind === 'zero') { zero.push(...it.ranges); hideIds.push(...(it.hide || [])); }
    else if (it.kind === 'thumbnail') { zero.push(...it.ranges); thumbs = true; }
    else if (it.kind === 'boxes') blank.push(...it.boxes);
    else if (it.kind === 'icctext') iccBoxes.push(...it.boxes);
    else if (it.kind === 'gainmap') unlink.push(it.aux);
    else if (it.kind === 'aux') unlink.push(...it.auxes);
  }

  // The structure in its fixed form (see structureFixes), in place.
  for (const [pos, bytes] of model.fixes.patches) out.set(bytes, pos);

  // Edits inside items first, while every byte is still where the analysis found it. An
  // Apple gain map that stays keeps the photo's two HDR numbers: when the MakerNote goes, a
  // MakerNote holding only those takes its place, as in a JPEG.
  const apple = set.has('exif:apple-hdr') && set.get('exif:apple-hdr').kind === 'applehdr' && !remove.has('exif:apple-hdr') ? set.get('exif:apple-hdr') : null;
  for (const [entry, keys] of exifKeys) {
    const data = readItem(out, entry.item);
    const m = parseTiff(data.subarray(entry.off));
    if (!m) continue;
    const shrink = !!apple && apple.entry === entry && keys.has('makernote');
    const rest = shrink ? new Set([...keys].filter((k) => k !== 'makernote')) : keys;
    const res = rest.size ? removeTiffKeys(m, rest) : { empty: false };
    if (shrink) {
      const m2 = parseTiff(data.subarray(entry.off));
      if (!m2 || !shrinkAppleNote(m2, apple.values)) {
        if (m2) removeTiffKeys(m2, new Set(['makernote']));
        warnings.push('The Apple HDR brightness could not be kept on its own, so the maker notes were removed with it.');
      }
    }
    if (res.empty) blankTiff(parseTiff(data.subarray(entry.off)));
    writeItem(out, entry.item, data);
  }
  // The bytes before each kept EXIF block's TIFF header, in their fixed form.
  for (const entry of model.exif) {
    if (!entry.prefix || allZero(out, entry.item.ranges)) continue;
    const data = readItem(out, entry.item);
    data.set(entry.prefix, 0);
    writeItem(out, entry.item, data);
  }

  // Auxiliary images that go: the reference that attaches them to the picture becomes an
  // unused one (its type is overwritten with 'free', which readers skip), their names are
  // cleared and their coded picture data is zeroed. The picture itself is untouched.
  // A removed image (an auxiliary image, an extra picture) is also marked hidden in its item
  // entry, so a reader does not offer its zeroed data as a picture of its own.
  const skip = new Set(unlink.map((a) => a.id));
  for (const id of [...skip, ...hideIds]) {
    const it = model.items.get(id);
    if (it && it.infe && !it.infe.large) out[it.infe.dataStart + 3] |= 1;
  }
  for (const a of unlink) {
    for (const r of a.refs) out.set([0x66, 0x72, 0x65, 0x65], r.box.start + 4);
    for (const p of a.props) {
      const shared = [...model.assoc].some(([id, list]) => id !== a.id && list.some((i) => model.props[i - 1] === p));
      if (!shared) out.fill(0, p.dataStart, p.end);
    }
    zero.push(...codedRanges(model, a.id));
  }

  // Text inside a colour profile: rewritten in place, same size, colour tags untouched.
  for (const p of iccBoxes) {
    if (blank.includes(p)) continue;
    const cleaned = cleanIcc(out.slice(p.dataStart + 4, p.end));
    if (cleaned) out.set(cleaned, p.dataStart + 4);
    else {
      blank.push(p);
      warnings.push('The text inside the colour profile could not be removed safely, so the whole colour profile was removed. Colours may look slightly different.');
    }
  }
  if (thumbs) warnings.push('The built-in preview was blanked. Some viewers may show an empty thumbnail until the picture is opened.');
  // Same size, harmless type: a box that goes becomes padding and its content is zeroed.
  // A box that also holds the picture's own data keeps its type and that data; everything
  // else in it is zeroed.
  const keep = protectedRanges(model, b.length, skip);
  for (const box of blank) {
    if (keep.some(([ks, ke]) => ks < box.end && ke > box.start)) {
      zero.push([box.dataStart, box.end]);
      warnings.push('One part of the file also holds picture data, so only the picture data in it was kept.');
      continue;
    }
    out.set([0x66, 0x72, 0x65, 0x65], box.start + 4);
    out.fill(0, Math.min(box.end, box.start + 8 + (box.large ? 8 : 0)), box.end);
  }
  zeroRanges(out, zero, keep);

  // XMP last: every packet that stays is written in the canonical form, which changes its
  // length, so the items after it move (spliceHeif). A packet that goes becomes an empty
  // one. The gain map's own description keeps only what a gain map needs, unless that
  // detail is kept, and is emptied with the gain map.
  const edits = [];
  const gainGone = remove.has('heic:gain-map');
  const textOf = (bytes) => new TextDecoder('utf-8').decode(bytes);
  for (const entry of [...model.xmp, ...model.gainXmp]) {
    if (allZero(out, entry.item.ranges)) continue;
    let text;
    let warn;
    if (entry.gain) {
      const parsed = entry.parsed;
      if (gainGone) text = EMPTY_XMP;
      else if (entry.extra && !remove.has(entry.extra)) {
        text = canonicalXmp(parsed, true);
        if (text === null) warn = 'The description inside the HDR gain map could not be written again in a standard form, so it was removed.';
      } else {
        const allowed = gainAllowed(parsed, 'gainmap');
        text = keepOnlyXmp(parsed, (p, i) => allowed.has(i), gainFixes(parsed, 'gainmap').map((x) => x.add));
      }
      if (text === null) text = EMPTY_XMP;
    } else if (entry.about && entry.about.length && entry.about.every((id) => skip.has(id))) {
      // The description of an auxiliary image that goes, goes with it.
      text = EMPTY_XMP;
    } else {
      const plan = planXmp(entry.parsed, entry.items, remove, true);
      warn = plan.warning;
      text = plan.action === 'rewrite' ? plan.text : EMPTY_XMP;
    }
    if (warn) warnings.push(warn);
    // A top-level XMP box that goes becomes a 'free' box of zeros, like any box that goes
    // (readers do not take an empty packet in that box).
    if (entry.box && text === EMPTY_XMP) {
      out.set([0x66, 0x72, 0x65, 0x65], entry.box.start + 4);
      out.fill(0, entry.box.start + 8 + (entry.box.large ? 8 : 0), entry.box.end);
      continue;
    }
    const data = encodeUtf8(text);
    const old = readItem(b, entry.item);
    if (data.length === old.length && data.every((x, i) => x === old[i])) continue;
    edits.push(entry.box ? { box: entry.box, data, entry } : { item: entry.item, data, entry });
  }
  // Item names go: the item list is written again with each name empty. Where it cannot
  // be, each name is overwritten with spaces in place.
  const blankNames = () => { for (const it of model.fixes.names) out.fill(0x20, it.name[0], it.name[1]); };
  const names = model.fixes.names.length ? iinfWithoutNames(out, model, model.fixes.names) : null;
  if (names) edits.push(names);
  else blankNames();
  let bytes = out;
  if (edits.length) {
    const res = spliceHeif(out, model, edits);
    if (res) bytes = res;
    else {
      // The structure does not allow moving data: every edited packet is zeroed in place
      // instead, the same length, so nothing in it survives, not even its layout, and each
      // item name is overwritten with spaces.
      let lostKept = false;
      for (const e of edits) {
        if (!e.entry) continue;
        const blankData = new Uint8Array(e.entry.length);
        const item = e.box ? { ranges: [[e.box.dataStart, e.box.end]] } : e.item;
        if (textOf(e.data) !== EMPTY_XMP) lostKept = true;
        writeItem(out, item, blankData);
      }
      if (names) blankNames();
      if (lostKept) warnings.push('The XMP data could not be written again in a standard form here, so all of it was removed instead.');
    }
  }
  if (model.c2pa && set.has('heic:c2pa') && !remove.has('heic:c2pa') && (remove.size || edits.length)) {
    warnings.push('Content Credentials were kept, but any change to the file makes their signature fail, so checkers will report the picture as altered.');
  }
  return { bytes, warnings };
}

export function firstHeicTiff(b) {
  const model = parseHeif(b);
  for (const item of model.items.values()) {
    if (item.type !== 'Exif' || !item.ranges || item.unsupported) continue;
    const data = readItem(b, item);
    let off = data.length >= 4 ? 4 + u32be(data, 0) : -1;
    if (off < 0 || !isTiffHeader(data, off)) off = findTiffStart(data, 64);
    if (off >= 0) return data.subarray(off);
  }
  return null;
}
