// WebP container.
//
// A RIFF file made of chunks, each padded to an even length. Metadata lives in ICCP, EXIF
// and "XMP " (announced by flags in VP8X) and sometimes in C2PA or private chunks. After
// removal the VP8X flags are brought in line and the RIFF size is rewritten.

import { Assembler, concat, encodeLatin1, encodeUtf8, formatBytes, latin1, u16le, u32le, w24le, w32le } from './bytes.js?v=b373c219';
import { describeC2pa } from './c2pa.js?v=366e87df';
import { iccDescription } from './icc.js?v=1ac906b0';
import { UNREADABLE, cappedId } from './taxonomy.js?v=b751b9be';
import { findTiffStart, parseTiff, removeTiffKeys, tiffItems, tiffOrientation } from './tiff.js?v=05d71c42';
import { addXmpItems, parseXmp, planXmp } from './xmp.js?v=45ad6f50';

const STRUCTURAL = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);
const FLAG_ICC = 0x20;
const FLAG_ALPHA = 0x10;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;

export function isWebp(b) {
  return b.length >= 12 && latin1(b, 0, 4) === 'RIFF' && latin1(b, 8, 12) === 'WEBP';
}

const KNOWN = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP', 'EXIF', 'XMP ', 'C2PA']);

// The first position in [from, end) where known chunks follow each other exactly up to
// `end`, or -1. Bounded, so a crafted file cannot make it slow.
function resync(b, from, end) {
  let tries = 0;
  const stop = Math.min(end - 8, from + 16 * 1024 * 1024);
  for (let q = from; q <= stop; q++) {
    if (!KNOWN.has(latin1(b, q, q + 4))) continue;
    if (++tries > 64) return -1;
    let p = q;
    let steps = 0;
    while (p + 8 <= end && steps++ < 4096) {
      if (!/^[\x20-\x7e]{4}$/.test(latin1(b, p, p + 4))) break;
      const size = u32le(b, p + 4);
      const next = p + 8 + size + (size & 1);
      if (next > end + (size & 1)) break;
      p = Math.min(next, end);
      if (p === end) return q;
    }
  }
  return -1;
}

export function walkWebp(b) {
  const warnings = [];
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
  if (8 + u32le(b, 4) > b.length) warnings.push('The WebP file is shorter than its header says.');
  const chunks = [];
  let p = 12;
  while (p + 8 <= riffEnd) {
    const type = latin1(b, p, p + 4);
    let size = u32le(b, p + 4);
    // VP8X always holds 10 bytes; a different size would swallow the chunks after it.
    if (type === 'VP8X' && size !== 10 && p + 18 <= riffEnd) { warnings.push('The VP8X chunk has a wrong size.'); size = 10; }
    const dataEnd = p + 8 + size;
    if (dataEnd > riffEnd) {
      warnings.push(`The ${type.trim()} chunk is cut short.`);
      // A damaged size can hide the chunks after it. If a run of whole chunks that ends
      // exactly at the end of the file starts inside this one, this one ends there.
      const q = resync(b, p + 8, riffEnd);
      if (q > 0) {
        chunks.push({ type, start: p, dataStart: p + 8, dataEnd: q, end: q, broken: true });
        p = q;
        continue;
      }
      chunks.push({ type, start: p, dataStart: p + 8, dataEnd: riffEnd, end: riffEnd, broken: true });
      p = riffEnd;
      break;
    }
    const end = Math.min(riffEnd, dataEnd + (size & 1));
    chunks.push({ type, start: p, dataStart: p + 8, dataEnd, end });
    p = end;
  }
  return { chunks, riffEnd, tailStart: Math.max(p, riffEnd), warnings };
}

function makeChunk(type, data) {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  out.set(encodeLatin1(type), 0);
  w32le(out, 4, data.length);
  out.set(data, 8);
  return out;
}

export function frameSize(b, chunks) {
  const vp8x = chunks.find((c) => c.type === 'VP8X');
  if (vp8x) return { width: 1 + (b[vp8x.dataStart + 4] | (b[vp8x.dataStart + 5] << 8) | (b[vp8x.dataStart + 6] << 16)), height: 1 + (b[vp8x.dataStart + 7] | (b[vp8x.dataStart + 8] << 8) | (b[vp8x.dataStart + 9] << 16)) };
  const vp8 = chunks.find((c) => c.type === 'VP8 ');
  if (vp8) return { width: u16le(b, vp8.dataStart + 6) & 0x3fff, height: u16le(b, vp8.dataStart + 8) & 0x3fff };
  const vp8l = chunks.find((c) => c.type === 'VP8L');
  if (vp8l) {
    const bits = u32le(b, vp8l.dataStart + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, alpha: !!((bits >>> 28) & 1) };
  }
  return { width: 0, height: 0 };
}

export function analyseWebp(b, set) {
  const w = walkWebp(b);
  for (const x of w.warnings) set.warn(x);
  const size = frameSize(b, w.chunks);
  const model = { w, chunks: w.chunks, width: size.width, height: size.height, orientation: 1, exif: [], xmp: [] };
  const unknown = new Map();
  const seenUnknown = new Set();
  const broken = w.chunks.filter((c) => c.broken && !STRUCTURAL.has(c.type));
  if (broken.length) {
    set.add({ id: 'webp:damaged', ...UNREADABLE.damaged, value: `${broken[0].type.trim() || 'Unnamed'} chunk, ${formatBytes(broken.reduce((n, c) => n + c.end - c.start, 0))}`, source: 'WebP' }, { kind: 'chunks', chunks: broken });
  }
  for (const c of w.chunks) {
    if (STRUCTURAL.has(c.type) || c.broken) continue;
    if (c.type === 'ICCP') {
      set.add({ id: 'icc:profile', group: 'technical', tier: 'green', label: 'Colour profile', value: iccDescription(b.subarray(c.dataStart, c.dataEnd)), source: 'ICC profile', note: 'Keeps colours accurate on different screens.' }, { kind: 'chunks', chunks: [c] });
      continue;
    }
    if (c.type === 'EXIF') {
      const data = b.subarray(c.dataStart, c.dataEnd);
      const off = findTiffStart(data, 16);
      const m = off >= 0 ? parseTiff(data.subarray(off)) : null;
      if (!m || m.damaged) {
        if (m) for (const x of m.warnings) set.warn(x);
        set.add({ id: 'exif:unreadable', group: 'hidden', tier: 'red', label: 'EXIF data that could not be read', value: formatBytes(data.length), source: 'EXIF', note: 'It may hold anything, so removing it is the safe choice.' }, { kind: 'chunks', chunks: [c] });
        continue;
      }
      for (const x of m.warnings) set.warn(x);
      if (!model.exif.length) model.orientation = tiffOrientation(m);
      const entry = { chunk: c, off };
      model.exif.push(entry);
      for (const it of tiffItems(m)) {
        const pub = { id: `exif:${it.key}`, group: it.group, tier: it.tier, label: it.label, value: it.value, source: 'EXIF' };
        if (it.note) pub.note = it.note;
        set.add(pub, { kind: 'exif', entry, key: it.key });
      }
      continue;
    }
    if (c.type === 'XMP ') {
      const text = new TextDecoder('utf-8').decode(b.subarray(c.dataStart, c.dataEnd));
      const parsed = parseXmp(text);
      const entry = { chunk: c, parsed, items: [] };
      model.xmp.push(entry);
      entry.items = addXmpItems(set, parsed, {}, { kind: 'xmp', entry }, c.dataEnd - c.dataStart);
      continue;
    }
    if (c.type === 'C2PA') {
      const d = describeC2pa([b.subarray(c.dataStart, c.dataEnd)]);
      set.add({ id: 'webp:c2pa', group: 'hidden', tier: d.tier, label: 'Content Credentials (C2PA)', value: d.value, source: 'C2PA', note: d.note }, { kind: 'chunks', chunks: [c] });
      model.c2pa = true;
      continue;
    }
    const key = cappedId(seenUnknown, `webp:chunk:${c.type.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'data'}`, 'webp:chunk:other');
    if (!unknown.has(key)) unknown.set(key, { type: key === 'webp:chunk:other' ? 'Several kinds of' : c.type, chunks: [] });
    unknown.get(key).chunks.push(c);
  }
  for (const [id, u] of unknown) {
    const total = u.chunks.reduce((n, c) => n + c.end - c.start, 0);
    set.add({ id, ...UNREADABLE.unknown, value: `${u.type.trim()} chunk, ${formatBytes(total)}`, source: 'WebP' }, { kind: 'chunks', chunks: u.chunks });
  }
  if (w.tailStart < b.length) {
    set.add({ id: 'webp:trailing', group: 'hidden', tier: 'red', label: 'Unknown data after the image', value: formatBytes(b.length - w.tailStart), source: 'After the image' }, { kind: 'trailing' });
  }
  return model;
}

function finishRiff(out) {
  w32le(out, 4, out.length - 8);
  return out;
}

// Rewrites VP8X flags so they match the chunks actually present.
function fixFlags(out) {
  const w = walkWebp(out);
  const vp8x = w.chunks.find((c) => c.type === 'VP8X');
  if (!vp8x) return out;
  const has = (t) => w.chunks.some((c) => c.type === t);
  let f = out[vp8x.dataStart];
  f = has('ICCP') ? f | FLAG_ICC : f & ~FLAG_ICC;
  f = has('EXIF') ? f | FLAG_EXIF : f & ~FLAG_EXIF;
  f = has('XMP ') ? f | FLAG_XMP : f & ~FLAG_XMP;
  out[vp8x.dataStart] = f;
  return out;
}

export function scrubWebp(b, model, set, remove) {
  const warnings = [];
  const out = b.slice();
  const drop = new Set();
  const replace = new Map();
  let cutTrailing = false;
  const exifKeys = new Map();
  for (const id of remove) {
    const it = set.get(id);
    if (!it) continue;
    if (it.kind === 'chunks') for (const c of it.chunks) drop.add(c);
    else if (it.kind === 'trailing') cutTrailing = true;
    else if (it.kind === 'exif') {
      if (!exifKeys.has(it.entry)) exifKeys.set(it.entry, new Set());
      exifKeys.get(it.entry).add(it.key);
    }
  }
  for (const [entry, keys] of exifKeys) {
    const c = entry.chunk;
    const m = parseTiff(out.subarray(c.dataStart + entry.off, c.dataEnd));
    if (removeTiffKeys(m, keys).empty) drop.add(c);
  }
  for (const entry of model.xmp) {
    const plan = planXmp(entry.parsed, entry.items, remove);
    if (plan.warning) warnings.push(plan.warning);
    if (plan.action === 'drop') drop.add(entry.chunk);
    else if (plan.action === 'rewrite') replace.set(entry.chunk, makeChunk('XMP ', encodeUtf8(plan.text)));
  }
  const c2paItem = set.has('webp:c2pa');
  if (model.c2pa && c2paItem && !remove.has('webp:c2pa') && (drop.size || replace.size || exifKeys.size || cutTrailing)) {
    warnings.push('Content Credentials were kept, but any change to the file makes their signature fail, so checkers will report the picture as altered.');
  }
  const asm = new Assembler(out);
  asm.copy(0, 12);
  for (const c of model.chunks) {
    if (drop.has(c) && !STRUCTURAL.has(c.type)) continue;
    if (replace.has(c)) { asm.add(replace.get(c)); continue; }
    asm.copy(c.start, c.end);
  }
  const riff = asm.finish();
  finishRiff(riff);
  fixFlags(riff);
  const tail = cutTrailing || model.w.tailStart >= b.length ? null : out.subarray(model.w.tailStart);
  return { bytes: tail ? concat([riff, tail]) : riff, warnings };
}

export function insertWebpExif(b, tiff) {
  const w = walkWebp(b);
  const parts = [encodeLatin1('RIFF'), new Uint8Array(4), encodeLatin1('WEBP')];
  const exif = makeChunk('EXIF', tiff);
  const hasVp8x = w.chunks.some((c) => c.type === 'VP8X');
  if (!hasVp8x) {
    const size = frameSize(b, w.chunks);
    if (!size.width || !size.height) throw new Error('The WebP picture size could not be read');
    const data = new Uint8Array(10);
    data[0] = FLAG_EXIF | (size.alpha || w.chunks.some((c) => c.type === 'ALPH') ? FLAG_ALPHA : 0);
    w24le(data, 4, size.width - 1);
    w24le(data, 7, size.height - 1);
    parts.push(makeChunk('VP8X', data));
  }
  let inserted = false;
  for (const c of w.chunks) {
    if (c.type === 'EXIF') continue;
    if (!inserted && c.type === 'XMP ') { parts.push(exif); inserted = true; }
    parts.push(b.subarray(c.start, c.end));
  }
  if (!inserted) parts.push(exif);
  const out = concat(parts);
  finishRiff(out);
  return fixFlags(out);
}
