// HEIC (ISO base media file format).
//
// Reads ftyp and meta (hdlr, pitm, iinf with infe v2 and v3, iloc versions 0 to 2 with all
// field sizes and construction methods 0 and 1, idat, iref, iprp with ipco and ipma, grpl).
// Every change is made IN PLACE: no box size and no offset ever changes, so the item
// locations stay valid. EXIF is edited by the TIFF engine inside its item, XMP is rewritten
// and padded with spaces to the same length (or blanked), previews and extra pictures are
// zeroed, and whole boxes that must go (a colour profile, Content Credentials, vendor
// boxes, descriptive properties) become 'free' boxes filled with zeros.
//
// Everything outside the picture itself is accounted for: top-level boxes, meta children,
// item properties, image items the picture does not use, and bytes inside the media data
// that no item points at. What is not needed to show the picture is offered as an item.

import { formatBytes, indexOfAscii, latin1, startsWith, subtractRanges, u16be, u32be, u64be, zeroRanges } from './bytes.js?v=b373c219';
import { describeC2pa } from './c2pa.js?v=366e87df';
import { iccDescription } from './icc.js?v=1ac906b0';
import { UNREADABLE, cappedId } from './taxonomy.js?v=5970adfd';
import { blankTiff, findTiffStart, isTiffHeader, parseTiff, removeTiffKeys, tiffItems } from './tiff.js?v=262e0fe8';
import { addXmpItems, emptyXmp, padXmp, parseXmp, planXmp } from './xmp.js?v=f2cbf417';

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
      if (ver >= 2) {
        id = ver === 2 ? u16be(b, p) : u32be(b, p);
        p += ver === 2 ? 2 : 4;
        p += 2;
        type = latin1(b, p, Math.min(e.end, p + 4));
        p += 4;
        const [, after] = cstr(b, p, e.end);
        p = after;
        if (type === 'mime' || type === 'uri ') [contentType] = cstr(b, p, e.end);
      } else {
        id = u16be(b, p);
        p += 4;
        const [, after] = cstr(b, p, e.end);
        [contentType] = cstr(b, after, e.end);
        type = 'mime';
      }
      model.items.set(id, { id, type, contentType, extents: [], method: 0, hidden: !!(b[e.dataStart + 3] & 1) });
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
      let totalExtents = 0;
      for (let i = 0; i < count && p < iloc.end; i++) {
        const id = ver < 2 ? readN(b, p, 2) : readN(b, p, 4);
        p += ver < 2 ? 2 : 4;
        let method = 0;
        if (ver === 1 || ver === 2) { method = readN(b, p, 2) & 15; p += 2; }
        p += 2;
        const base = readN(b, p, baseSize);
        p += baseSize;
        const n = readN(b, p, 2);
        p += 2;
        const extents = [];
        // A crafted table can claim up to 65,535 extents per item; far beyond any real file.
        if (n > 4096 || totalExtents + n > 65536) throw new Error('Too many extents');
        totalExtents += n;
        for (let k = 0; k < n; k++) {
          if (idxSize) p += idxSize;
          const off = readN(b, p, offSize);
          p += offSize;
          const len = readN(b, p, lenSize);
          p += lenSize;
          extents.push({ off: base + off, len });
        }
        if (p > iloc.end) throw new Error('Location table past its box');
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
      model.refs.push({ type: r.type, from, to });
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

function pictureItems(model) {
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
      if (r.type === 'auxl' && !seen.has(r.from) && r.to.some((t) => seen.has(t))) { const n = seen.size; visit(r.from); changed = changed || seen.size > n; }
    }
  }
  return seen;
}

// The primary picture's own data. Never zeroed. Picture data lives in the media data or
// idat boxes and never overlaps another item, so a damaged location that claims more than
// that protects only the part that can really be picture data.
function protectedRanges(model, length) {
  const picture = pictureItems(model);
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

export function analyseHeic(b, set) {
  const model = parseHeif(b);
  for (const it of model.items.values()) {
    if (!it.misplaced && notPictureData(b, model, it)) {
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
      const parsed = parseXmp(new TextDecoder('utf-8').decode(data));
      const entry = { item, parsed, length: data.length, items: [] };
      model.xmp.push(entry);
      entry.items = addXmpItems(set, parsed, {}, { kind: 'xmp', entry }, data.length);
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
      set.add({ id: 'heic:extra-image', group: 'hidden', tier: 'red', label: 'Extra picture inside the file', value: `${dims}${formatBytes(rangesSize(item.ranges))}`, source: 'HEIC', note: 'A picture the main image does not use. It could be an earlier or uncropped version, with its own metadata.' }, { kind: 'zero', ranges: item.ranges });
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
    const desc = iccDescription(b.subarray(colr[0].dataStart + 4, colr[0].end));
    set.add({ id: 'icc:profile', group: 'technical', tier: 'green', label: 'Colour profile', value: desc, source: 'ICC profile', note: 'Keeps colours accurate on different screens.' }, { kind: 'boxes', boxes: colr });
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
    else if (p.type === 'crtt' || p.type === 'mdft') describe.times.push(p);
    else unknownBox(p, `${p.type.replace(/[^\x20-\x7e]/g, '?')} property`);
  });
  if (describe.udes.length) {
    set.add({ id: 'heic:description', group: 'who', tier: 'red', label: 'Name and description stored with the picture', value: udesText(b, describe.udes[0]) || formatBytes(rangesSize(describe.udes.map((p) => [p.start, p.end]))), source: 'HEIC', note: 'Free text written by a person or an app. It can hold names, places or notes.' }, { kind: 'boxes', boxes: describe.udes });
  }
  if (describe.altt.length) {
    set.add({ id: 'heic:alt-text', group: 'hidden', tier: 'amber', label: 'Text description of the picture', value: udesText(b, describe.altt[0]) || formatBytes(describe.altt[0].end - describe.altt[0].start), source: 'HEIC' }, { kind: 'boxes', boxes: describe.altt });
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
      if (allZero(b, [[box.dataStart, box.end]])) continue;
      const item = { ranges: [[box.dataStart, box.end]] };
      const data = b.subarray(box.dataStart, box.end);
      const parsed = parseXmp(new TextDecoder('utf-8').decode(data));
      const entry = { item, parsed, length: data.length, items: [] };
      model.xmp.push(entry);
      entry.items = addXmpItems(set, parsed, {}, { kind: 'xmp', entry }, data.length);
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

  const aux = model.refs.filter((r) => r.type === 'auxl' && r.to.includes(model.primary)).map((r) => model.items.get(r.from)).filter(Boolean);
  const auxC = (id) => propsOf(model, id, 'auxC').map((p) => latin1(b, p.dataStart + 4, p.end).replace(/\0[\s\S]*$/, '')).join(' ');
  if (aux.some((it) => !/auxid:1$|alpha/i.test(auxC(it.id)))) {
    set.warn('This HEIC file also holds a depth map or HDR gain map. It stays in the file, because removing it without re-saving the picture would break it.');
  }
  return model;
}

export function scrubHeic(b, model, set, remove) {
  const warnings = [];
  const out = b.slice();
  const zero = [];
  const exifKeys = new Map();
  const blank = [];
  let thumbs = false;
  for (const id of remove) {
    const it = set.get(id);
    if (!it) continue;
    if (it.kind === 'exif') {
      if (!exifKeys.has(it.entry)) exifKeys.set(it.entry, new Set());
      exifKeys.get(it.entry).add(it.key);
    } else if (it.kind === 'zero') zero.push(...it.ranges);
    else if (it.kind === 'thumbnail') { zero.push(...it.ranges); thumbs = true; }
    else if (it.kind === 'boxes') blank.push(...it.boxes);
  }

  // Edits inside items first, while every byte is still where the analysis found it.
  for (const [entry, keys] of exifKeys) {
    const data = readItem(out, entry.item);
    const m = parseTiff(data.subarray(entry.off));
    if (!m) continue;
    const res = removeTiffKeys(m, keys);
    if (res.empty) blankTiff(parseTiff(data.subarray(entry.off)));
    writeItem(out, entry.item, data);
  }

  for (const entry of model.xmp) {
    const plan = planXmp(entry.parsed, entry.items, remove);
    if (plan.warning) warnings.push(plan.warning);
    if (plan.action === 'keep') continue;
    let data = null;
    if (plan.action === 'rewrite') {
      data = padXmp(plan.text, entry.length);
      if (!data) {
        // A fresh packet without the wrapper and indentation is smaller; try that.
        const compact = planXmp(entry.parsed, entry.items, remove, true);
        data = compact.action === 'rewrite' ? padXmp(compact.text, entry.length) : null;
      }
      if (!data) warnings.push('The XMP data could not be edited safely, so all of it was removed instead.');
    }
    if (!data) data = emptyXmp(entry.length) || new Uint8Array(entry.length).fill(0x20);
    writeItem(out, entry.item, data);
  }

  if (thumbs) warnings.push('The built-in preview was blanked. Some viewers may show an empty thumbnail until the picture is opened.');
  if (model.c2pa && set.has('heic:c2pa') && !remove.has('heic:c2pa') && remove.size) {
    warnings.push('Content Credentials were kept, but any change to the file makes their signature fail, so checkers will report the picture as altered.');
  }
  // Same size, harmless type: a box that goes becomes padding and its content is zeroed.
  // A box that also holds the picture's own data keeps its type and that data; everything
  // else in it is zeroed.
  const keep = protectedRanges(model, b.length);
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
  return { bytes: out, warnings };
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
