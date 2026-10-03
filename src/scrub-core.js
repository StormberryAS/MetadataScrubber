// MetadataScrubber engine: the one module the interface talks to.
//
// Pure ES module with no DOM dependencies; it runs in browsers and in Node 24. It never
// decodes or re-encodes pixels: it reads the containers around the picture and removes
// metadata by dropping whole parts or overwriting them with zeros.
//
//   detectFormat(bytes)            'jpeg' | 'png' | 'webp' | 'heic' | null
//   inspect(bytes)                 async, { format, width, height, orientation, items, warnings }
//   scrub(bytes, removeIds)        async, { bytes, warnings }
//   buildExif(sourceBytes, keepIds)            fresh EXIF block with only kept simple tags, or null
//   insertExif(bytes, format, exifPayload)     adds that block to a freshly encoded picture
//   privacyWord(remainingItems)    'public' | 'minimal' | 'clean' | 'custom'
//   GROUPS, TIERS

import { latin1, toU8 } from './core/bytes.js?v=b373c219';
import { GROUPS, ItemSet, TIERS } from './core/taxonomy.js?v=b751b9be';
import { analyseJpeg, insertJpegExif, scrubJpeg, walkJpeg } from './core/jpeg.js?v=699750e5';
import { analysePng, firstPngTiff, insertPngExif, isPng, scrubPng, walkPng } from './core/png.js?v=4663547a';
import { analyseWebp, frameSize, insertWebpExif, isWebp, scrubWebp, walkWebp } from './core/webp.js?v=d670219e';
import { analyseHeic, firstHeicTiff, isHeic, scrubHeic } from './core/heic.js?v=5ced97b7';
import { buildTiff, findTiffStart, parseTiff, setTiffDimensions } from './core/tiff.js?v=05d71c42';

export { GROUPS, TIERS };

export function detectFormat(input) {
  const b = toU8(input);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (isPng(b)) return 'png';
  if (isWebp(b)) return 'webp';
  if (isHeic(b)) return 'heic';
  return null;
}

async function analyse(b) {
  const format = detectFormat(b);
  if (!format) throw new Error('This file type is not supported. Use a JPEG, PNG, WebP or HEIC picture.');
  const set = new ItemSet();
  let model;
  if (format === 'jpeg') model = analyseJpeg(b, set);
  else if (format === 'png') model = await analysePng(b, set);
  else if (format === 'webp') model = analyseWebp(b, set);
  else model = analyseHeic(b, set);
  return { format, model, set };
}

export async function inspect(input) {
  const b = toU8(input);
  const { format, model, set } = await analyse(b);
  return {
    format,
    width: model.width || 0,
    height: model.height || 0,
    orientation: model.orientation >= 1 && model.orientation <= 8 ? model.orientation : 1,
    items: set.items.map((i) => ({ ...i })),
    warnings: [...set.warnings],
  };
}

export async function scrub(input, removeIds) {
  const b = toU8(input);
  const { format, model, set } = await analyse(b);
  const remove = new Set();
  const warnings = [];
  for (const id of removeIds || []) {
    if (set.has(id)) remove.add(id);
    else warnings.push(`Nothing called "${id}" was found in this file, so it was skipped.`);
  }
  if (!remove.size) return { bytes: b.slice(), warnings };
  let res;
  if (format === 'jpeg') res = scrubJpeg(b, model, set, remove);
  else if (format === 'png') res = await scrubPng(b, model, set, remove);
  else if (format === 'webp') res = scrubWebp(b, model, set, remove);
  else res = scrubHeic(b, model, set, remove);
  return { bytes: res.bytes, warnings: [...warnings, ...res.warnings] };
}

// The first EXIF block of a file, located without any asynchronous work.
function firstTiff(b) {
  const format = detectFormat(b);
  if (format === 'jpeg') {
    const w = walkJpeg(b);
    const s = w && w.segs.find((x) => x.kind === 'seg' && x.marker === 0xe1 && latin1(b, x.dataStart, x.dataStart + 5) === 'Exif\0');
    return s ? b.subarray(s.dataStart + 6, s.end) : null;
  }
  if (format === 'png') return firstPngTiff(b);
  if (format === 'webp') {
    let p = 12;
    while (p + 8 <= b.length) {
      const size = b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24);
      if (latin1(b, p, p + 4) === 'EXIF') {
        const data = b.subarray(p + 8, Math.min(b.length, p + 8 + size));
        const off = findTiffStart(data, 16);
        return off >= 0 ? data.subarray(off) : null;
      }
      p += 8 + size + (size & 1);
    }
    return null;
  }
  if (format === 'heic') return firstHeicTiff(b);
  return null;
}

// A fresh TIFF/EXIF payload holding only the kept simple tags of the file's first EXIF
// block (IFD0, Exif IFD and GPS), with Orientation forced to 1, no MakerNote and no
// preview. keepIds are item ids from inspect(), such as 'exif:gps' or 'exif:camera'.
// Returns null when nothing is kept.
export function buildExif(sourceBytes, keepIds) {
  const b = toU8(sourceBytes);
  const keys = new Set();
  for (const id of keepIds || []) {
    const m = /^exif:([a-z-]+)(?::\d+)?$/.exec(id);
    if (m) keys.add(m[1]);
  }
  keys.delete('makernote');
  keys.delete('thumbnail');
  if (!keys.size) return null;
  const tiff = firstTiff(b);
  if (!tiff) return null;
  const m = parseTiff(tiff);
  return m ? buildTiff(m, keys) : null;
}

function pictureSize(b, format) {
  if (format === 'jpeg') {
    const w = walkJpeg(b);
    return w && w.sof ? { width: w.sof.width, height: w.sof.height } : null;
  }
  if (format === 'png') {
    const ihdr = walkPng(b).chunks.find((c) => c.type === 'IHDR');
    return ihdr ? { width: ((b[ihdr.dataStart] << 24) >>> 0) + (b[ihdr.dataStart + 1] << 16) + (b[ihdr.dataStart + 2] << 8) + b[ihdr.dataStart + 3], height: ((b[ihdr.dataStart + 4] << 24) >>> 0) + (b[ihdr.dataStart + 5] << 16) + (b[ihdr.dataStart + 6] << 8) + b[ihdr.dataStart + 7] } : null;
  }
  if (format === 'webp') return frameSize(b, walkWebp(b).chunks);
  return null;
}

// Adds a payload from buildExif to a freshly encoded picture of the given format, filling
// in the picture size fields from the picture itself.
export function insertExif(input, format, exifPayload) {
  const b = toU8(input);
  if (!exifPayload || !exifPayload.length) return b;
  const tiff = toU8(exifPayload).slice();
  const size = pictureSize(b, format);
  if (size && size.width && size.height) setTiffDimensions(parseTiff(tiff), size.width, size.height);
  if (format === 'jpeg') return insertJpegExif(b, tiff);
  if (format === 'png') return insertPngExif(b, tiff);
  if (format === 'webp') return insertWebpExif(b, tiff);
  throw new Error(`EXIF cannot be added to a ${format} file`);
}

// The privacy word for a file, from a read-back inspect() of the OUTPUT file.
export function privacyWord(remainingItems) {
  const items = remainingItems || [];
  if (!items.length) return 'clean';
  if (items.some((i) => i.tier === 'red')) return 'custom';
  if (items.some((i) => i.tier === 'amber')) return 'public';
  return 'minimal';
}
