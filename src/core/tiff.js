// EXIF / TIFF engine.
//
// Shared by every container that carries EXIF: JPEG APP1, PNG eXIf and raw profile text,
// WebP EXIF and HEIC Exif items. It reads IFD0, the Exif IFD, every GPS IFD (whether its
// pointer sits in IFD0 or in the Exif IFD), the Interop IFD and the whole chain of preview
// directories after IFD0 (IFD1, IFD2 and so on), in either byte order. It folds tags into
// items that mean something to a person and removes them IN PLACE:
//
//  * removed entries are deleted from their IFD by shifting later entries up, the entry
//    count is decremented and the next-IFD pointer is rewritten at its new position;
//  * a sub-IFD whose last entry goes is dropped whole and its pointer removed from the
//    parent; removing the preview drops IFD1 and everything chained after it;
//  * then the whole block is swept: every byte that no kept part uses is zeroed. That
//    covers removed values, freed table space, dropped directories and their data, and
//    (when the leftover item is removed) bytes that nothing referenced in the first place.
//
// Kept data never moves, so offsets inside a kept MakerNote stay valid.

import { clip, formatBytes, latin1, subtractRanges, u16be, u16le, u32be, u32le, zeroRanges } from './bytes.js?v=b373c219';

// Field sizes per TIFF type; 129 is the UTF-8 string type added in Exif 3.0.
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 129: 1 };

const PTR_EXIF = 0x8769;
const PTR_GPS = 0x8825;
const PTR_INTEROP = 0xa005;
const MAX_CHAIN = 16;

// Tag names, used for ImageMagick-style "exif:Name" text keys and for listing leftovers.
export const TAG_NAMES = {
  0x00fe: 'SubfileType', 0x0100: 'ImageWidth', 0x0101: 'ImageLength', 0x0102: 'BitsPerSample',
  0x0103: 'Compression', 0x0106: 'PhotometricInterpretation', 0x0107: 'Threshholding', 0x0108: 'CellWidth',
  0x0109: 'CellLength', 0x010a: 'FillOrder', 0x010d: 'DocumentName',
  0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model', 0x0111: 'StripOffsets',
  0x0112: 'Orientation', 0x0115: 'SamplesPerPixel', 0x0116: 'RowsPerStrip', 0x0117: 'StripByteCounts',
  0x0118: 'MinSampleValue', 0x0119: 'MaxSampleValue',
  0x011a: 'XResolution', 0x011b: 'YResolution', 0x011c: 'PlanarConfiguration', 0x011d: 'PageName',
  0x0122: 'GrayResponseUnit', 0x0123: 'GrayResponseCurve', 0x0124: 'T4Options', 0x0125: 'T6Options',
  0x0128: 'ResolutionUnit', 0x0129: 'PageNumber', 0x012d: 'TransferFunction', 0x0131: 'Software',
  0x0132: 'DateTime', 0x013b: 'Artist', 0x013c: 'HostComputer', 0x013d: 'Predictor', 0x013e: 'WhitePoint',
  0x013f: 'PrimaryChromaticities', 0x0140: 'ColorMap', 0x0141: 'HalftoneHints', 0x0142: 'TileWidth',
  0x0143: 'TileLength', 0x0144: 'TileOffsets', 0x0145: 'TileByteCounts', 0x014a: 'SubIFDs',
  0x0152: 'ExtraSamples', 0x0153: 'SampleFormat', 0x015b: 'JPEGTables',
  0x0201: 'JPEGInterchangeFormat', 0x0202: 'JPEGInterchangeFormatLength', 0x0211: 'YCbCrCoefficients',
  0x0212: 'YCbCrSubSampling', 0x0213: 'YCbCrPositioning', 0x0214: 'ReferenceBlackWhite',
  0x02bc: 'ApplicationNotes', 0x4746: 'Rating', 0x4749: 'RatingPercent', 0x8298: 'Copyright',
  0x829a: 'ExposureTime', 0x829d: 'FNumber',
  0x83bb: 'IPTC', 0x8649: 'PhotoshopSettings', 0x8769: 'ExifOffset', 0x8773: 'ICCProfile',
  0x8822: 'ExposureProgram', 0x8824: 'SpectralSensitivity', 0x8825: 'GPSInfo', 0x8827: 'ISOSpeedRatings',
  0x8828: 'OECF', 0x882a: 'TimeZoneOffset', 0x8830: 'SensitivityType', 0x8831: 'StandardOutputSensitivity',
  0x8832: 'RecommendedExposureIndex', 0x8833: 'ISOSpeed', 0x8834: 'ISOSpeedLatitudeyyy',
  0x8835: 'ISOSpeedLatitudezzz', 0x9000: 'ExifVersion', 0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized', 0x9010: 'OffsetTime', 0x9011: 'OffsetTimeOriginal',
  0x9012: 'OffsetTimeDigitized', 0x9101: 'ComponentsConfiguration', 0x9102: 'CompressedBitsPerPixel',
  0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue', 0x9203: 'BrightnessValue',
  0x9204: 'ExposureBiasValue', 0x9205: 'MaxApertureValue', 0x9206: 'SubjectDistance',
  0x9207: 'MeteringMode', 0x9208: 'LightSource', 0x9209: 'Flash', 0x920a: 'FocalLength',
  0x9214: 'SubjectArea', 0x927c: 'MakerNote', 0x9286: 'UserComment', 0x9290: 'SubSecTime',
  0x9291: 'SubSecTimeOriginal', 0x9292: 'SubSecTimeDigitized', 0x9400: 'Temperature',
  0x9401: 'Humidity', 0x9402: 'Pressure', 0x9403: 'WaterDepth', 0x9404: 'Acceleration',
  0x9405: 'CameraElevationAngle', 0x9c9b: 'XPTitle', 0x9c9c: 'XPComment', 0x9c9d: 'XPAuthor',
  0x9c9e: 'XPKeywords', 0x9c9f: 'XPSubject', 0xa000: 'FlashpixVersion', 0xa001: 'ColorSpace',
  0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension', 0xa004: 'RelatedSoundFile',
  0xa005: 'InteroperabilityOffset', 0xa20b: 'FlashEnergy', 0xa20c: 'SpatialFrequencyResponse',
  0xa20e: 'FocalPlaneXResolution', 0xa20f: 'FocalPlaneYResolution', 0xa210: 'FocalPlaneResolutionUnit',
  0xa214: 'SubjectLocation', 0xa215: 'ExposureIndex', 0xa217: 'SensingMethod', 0xa300: 'FileSource',
  0xa301: 'SceneType', 0xa302: 'CFAPattern', 0xa401: 'CustomRendered', 0xa402: 'ExposureMode',
  0xa403: 'WhiteBalance', 0xa404: 'DigitalZoomRatio', 0xa405: 'FocalLengthIn35mmFilm',
  0xa406: 'SceneCaptureType', 0xa407: 'GainControl', 0xa408: 'Contrast', 0xa409: 'Saturation',
  0xa40a: 'Sharpness', 0xa40b: 'DeviceSettingDescription', 0xa40c: 'SubjectDistanceRange',
  0xa420: 'ImageUniqueID', 0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber',
  0xa432: 'LensSpecification', 0xa433: 'LensMake', 0xa434: 'LensModel', 0xa435: 'LensSerialNumber',
  0xa436: 'ImageTitle', 0xa437: 'Photographer', 0xa438: 'ImageEditor', 0xa439: 'CameraFirmware',
  0xa43a: 'RAWDevelopingSoftware', 0xa43b: 'ImageEditingSoftware', 0xa43c: 'MetadataEditingSoftware',
  0xa460: 'CompositeImage', 0xa461: 'CompositeImageCount', 0xa462: 'CompositeImageExposureTimes',
  0xa500: 'Gamma', 0xc4a5: 'PrintIM', 0xc612: 'DNGVersion', 0xc614: 'UniqueCameraModel',
  0xc62f: 'CameraSerialNumber', 0xea1c: 'Padding', 0xea1d: 'OffsetSchema',
};

const NAME_TO_TAG = new Map(Object.entries(TAG_NAMES).map(([k, v]) => [v.toLowerCase(), Number(k)]));

const KEY_OF_TAG = new Map();
const assign = (key, tags) => { for (const t of tags) KEY_OF_TAG.set(t, key); };
assign('serial', [0xa431, 0xc62f]);
assign('lens-serial', [0xa435]);
assign('unique-id', [0xa420]);
assign('owner', [0x013b, 0xa430, 0x9c9d, 0xa437, 0xa438]);
assign('copyright', [0x8298]);
assign('datetime', [0x0132, 0x9003, 0x9004, 0x9290, 0x9291, 0x9292]);
assign('timezone', [0x9010, 0x9011, 0x9012, 0x882a]);
assign('camera', [0x010f, 0x0110, 0xc614]);
assign('lens', [0xa432, 0xa433, 0xa434]);
assign('software', [0x0131, 0xa439, 0xa43a, 0xa43b, 0xa43c]);
assign('computer', [0x013c]);
assign('description', [0x010e, 0x9286, 0x9c9b, 0x9c9c, 0x9c9e, 0x9c9f, 0xa436, 0x010d, 0x011d, 0x4746, 0x4749]);
assign('makernote', [0x927c]);
assign('embedded', [0x02bc, 0x83bb, 0x8649]);
assign('orientation', [0x0112]);
assign('resolution', [0x011a, 0x011b, 0x0128]);
assign('colour', [0xa001, 0xa500, 0x013e, 0x013f, 0x0211, 0x0214, 0x8773, 0x012d]);
assign('dimensions', [0xa002, 0xa003, 0x0100, 0x0101]);
assign('exposure', [0x829a, 0x829d, 0x8822, 0x8824, 0x8827, 0x8828, 0x8830, 0x8831, 0x8832, 0x8833,
  0x8834, 0x8835, 0x9201, 0x9202, 0x9203, 0x9204, 0x9205, 0x9206, 0x9207, 0x9208, 0x9209, 0x920a,
  0x9214, 0x9400, 0x9401, 0x9402, 0x9403, 0x9404, 0x9405, 0xa20b, 0xa20c, 0xa20e, 0xa20f, 0xa210,
  0xa214, 0xa215, 0xa217, 0xa300, 0xa301, 0xa302, 0xa401, 0xa402, 0xa403, 0xa404, 0xa405, 0xa406,
  0xa407, 0xa408, 0xa409, 0xa40a, 0xa40b, 0xa40c, 0xa460, 0xa461, 0xa462]);
assign('format', [0x9000, 0xa000, 0x9101, 0x9102, 0x0212, 0x0213, 0x0103, 0x0102, 0x0106, 0x0115,
  0x011c, 0x00fe, 0xea1c, 0xea1d, 0x0107, 0x0108, 0x0109, 0x010a, 0x0111, 0x0116, 0x0117, 0x0118,
  0x0119, 0x0122, 0x0123, 0x0124, 0x0125, 0x0129, 0x013d, 0x0140, 0x0141, 0x0142, 0x0143, 0x0144,
  0x0145, 0x0152, 0x0153, 0x015b, 0xc612]);

// Item definitions, in display order.
export const TIFF_ITEMS = {
  gps: { group: 'where', tier: 'red', label: 'GPS position' },
  owner: { group: 'who', tier: 'red', label: 'Owner and author names' },
  serial: { group: 'who', tier: 'red', label: 'Camera serial number' },
  'lens-serial': { group: 'who', tier: 'red', label: 'Lens serial number' },
  copyright: { group: 'who', tier: 'red', label: 'Copyright notice', note: "Usually contains the photographer's name." },
  computer: { group: 'who', tier: 'red', label: 'Computer name', note: "Often contains the owner's name." },
  datetime: { group: 'when', tier: 'amber', label: 'Date and time' },
  timezone: { group: 'when', tier: 'amber', label: 'Time zone' },
  camera: { group: 'device', tier: 'amber', label: 'Camera make and model' },
  lens: { group: 'device', tier: 'amber', label: 'Lens' },
  software: { group: 'device', tier: 'amber', label: 'Editing software' },
  other: { group: 'device', tier: 'amber', label: 'Other camera data' },
  thumbnail: { group: 'hidden', tier: 'red', label: 'Built-in preview image', note: 'Can still show the original, uncropped photo after cropping.' },
  makernote: { group: 'hidden', tier: 'red', label: 'Manufacturer notes (may include serial numbers)', note: 'Private data the camera maker stores, often including serial numbers.' },
  'unique-id': { group: 'hidden', tier: 'red', label: 'Unique image ID', note: 'Can link copies of the picture back to the original file.' },
  embedded: { group: 'hidden', tier: 'red', label: 'Copy of XMP, IPTC or Photoshop data inside EXIF', note: 'May repeat names, places or serial numbers.' },
  private: { group: 'hidden', tier: 'red', label: 'Unrecognised camera data', note: 'Data this tool does not recognise. It may hold anything, so it is removed by default.' },
  leftover: { group: 'hidden', tier: 'red', label: 'Leftover data inside EXIF', note: 'Bytes that no field uses, often left behind by an earlier edit. They can still hold old values.' },
  description: { group: 'hidden', tier: 'amber', label: 'Description and comments' },
  orientation: { group: 'technical', tier: 'green', label: 'Rotation' },
  dimensions: { group: 'technical', tier: 'green', label: 'Picture size' },
  resolution: { group: 'technical', tier: 'green', label: 'Print resolution' },
  colour: { group: 'technical', tier: 'green', label: 'Colour space' },
  exposure: { group: 'technical', tier: 'green', label: 'Exposure settings' },
  format: { group: 'technical', tier: 'green', label: 'File format details' },
};

// Known tags without a better home are 'other' (amber); tags this tool does not know at
// all are 'private' (red), because they can hold anything.
export function keyForTag(tag) {
  return KEY_OF_TAG.get(tag) || (TAG_NAMES[tag] ? 'other' : 'private');
}

// Key for an ImageMagick-style property name such as "GPSLatitude" or "DateTimeOriginal".
export function keyForTagName(name) {
  if (/^gps/i.test(name)) return 'gps';
  if (/^thumbnail:/i.test(name)) return 'thumbnail';
  const tag = NAME_TO_TAG.get(name.toLowerCase());
  return tag === undefined ? 'private' : keyForTag(tag);
}

// ======================================================================================
// Parsing

export function isTiffHeader(b, p = 0) {
  if (p + 8 > b.length) return false;
  if (b[p] === 0x49 && b[p + 1] === 0x49) return b[p + 2] === 42 && b[p + 3] === 0;
  if (b[p] === 0x4d && b[p + 1] === 0x4d) return b[p + 2] === 0 && b[p + 3] === 42;
  return false;
}

// Locates the TIFF header inside an EXIF payload that may start with "Exif\0\0" or similar.
export function findTiffStart(b, limit = 64) {
  for (let p = 0; p <= Math.min(limit, b.length - 8); p++) if (isTiffHeader(b, p)) return p;
  return -1;
}

const isChain = (ifd) => ifd.chain === true;

export function parseTiff(t) {
  if (!isTiffHeader(t, 0)) return null;
  const le = t[0] === 0x49;
  const r16 = le ? (p) => u16le(t, p) : (p) => u16be(t, p);
  const r32 = le ? (p) => u32le(t, p) : (p) => u32be(t, p);
  const w16 = le
    ? (p, v) => { t[p] = v & 255; t[p + 1] = (v >>> 8) & 255; }
    : (p, v) => { t[p] = (v >>> 8) & 255; t[p + 1] = v & 255; };
  const w32 = le
    ? (p, v) => { t[p] = v & 255; t[p + 1] = (v >>> 8) & 255; t[p + 2] = (v >>> 16) & 255; t[p + 3] = (v >>> 24) & 255; }
    : (p, v) => { t[p] = (v >>> 24) & 255; t[p + 1] = (v >>> 16) & 255; t[p + 2] = (v >>> 8) & 255; t[p + 3] = v & 255; };
  const m = { t, le, r16, r32, w16, w32, ifds: {}, order: [], chain: [], warnings: [], damaged: false };
  const visited = new Set();

  const readIfd = (name, off, parent, label = name) => {
    if (!off) return null;
    if (off < 8 || off + 2 > t.length || visited.has(off)) {
      m.warnings.push(`The ${label} directory in the EXIF data points outside the data and was skipped.`);
      return null;
    }
    visited.add(off);
    const count = r16(off);
    if (off + 2 + count * 12 > t.length) {
      m.warnings.push(`The ${label} directory in the EXIF data is damaged and was skipped.`);
      return null;
    }
    const entries = [];
    for (let i = 0; i < count; i++) {
      const p = off + 2 + i * 12;
      const tag = r16(p);
      const type = r16(p + 2);
      const n = r32(p + 4);
      const unit = TYPE_SIZE[type] || 0;
      const size = unit * n;
      const inline = size <= 4;
      const valueOffset = inline ? p + 8 : r32(p + 8);
      const valid = unit > 0 && size < 0x7fffffff && (inline || (valueOffset >= 8 && valueOffset + size <= t.length));
      entries.push({ tag, type, count: n, size, inline, valueOffset, entryPos: p, valid, index: i });
    }
    const hasNext = off + 2 + count * 12 + 4 <= t.length;
    const next = hasNext ? r32(off + 2 + count * 12) : 0;
    const ifd = { name, offset: off, count, entries, next, hasNext, parent };
    m.ifds[name] = ifd;
    m.order.push(ifd);
    return ifd;
  };

  const ifd0 = readIfd('ifd0', r32(4), null, 'main');
  if (!ifd0) { m.damaged = true; return m; }
  const pointers = (ifd, tag) => ifd.entries.filter((e) => e.tag === tag && e.valid && e.count === 1 && (e.type === 4 || e.type === 13));
  const pe = pointers(ifd0, PTR_EXIF)[0];
  const exif = pe ? readIfd('exif', r32(pe.entryPos + 8), { ifd: 'ifd0', tag: PTR_EXIF, entry: pe.index }, 'Exif') : null;
  // GPS directories, wherever their pointer sits.
  let gpsCount = 0;
  for (const owner of [ifd0, exif]) {
    if (!owner) continue;
    for (const e of pointers(owner, PTR_GPS)) {
      const name = gpsCount ? `gps${gpsCount + 1}` : 'gps';
      if (readIfd(name, r32(e.entryPos + 8), { ifd: owner.name, tag: PTR_GPS, entry: e.index }, 'GPS')) gpsCount++;
    }
  }
  if (exif) {
    const pi = pointers(exif, PTR_INTEROP)[0];
    if (pi) readIfd('interop', r32(pi.entryPos + 8), { ifd: 'exif', tag: PTR_INTEROP, entry: pi.index }, 'Interop');
  }
  // The preview chain: IFD1, then any further directory linked after it.
  let prev = ifd0;
  for (let n = 1; prev.next && n <= MAX_CHAIN; n++) {
    const d = readIfd(`ifd${n}`, prev.next, null, n === 1 ? 'preview' : 'extra preview');
    if (!d) break;
    d.chain = true;
    m.chain.push(d);
    prev = d;
  }
  return m;
}

// Which sub-IFD a pointer entry leads to, if that sub-IFD was read successfully.
function childOf(m, ifd, e) {
  for (const c of m.order) {
    if (c.parent && c.parent.ifd === ifd.name && c.parent.tag === e.tag && c.parent.entry === e.index) return c;
  }
  return null;
}

// The removal key of every entry: a pointer to a sub-IFD we read is structural (null).
function entryKey(m, ifd, e) {
  if (ifd.name.startsWith('gps')) return 'gps';
  if (isChain(ifd)) return 'thumbnail';
  if (ifd.name === 'interop') return 'format';
  if (e.tag === PTR_EXIF || e.tag === PTR_GPS || e.tag === PTR_INTEROP) {
    if (childOf(m, ifd, e)) return null;
    return e.tag === PTR_GPS ? 'gps' : 'private';
  }
  return keyForTag(e.tag);
}

// ======================================================================================
// Value readers

function valueBytes(m, e) {
  return m.t.subarray(e.valueOffset, e.valueOffset + e.size);
}

function readNumbers(m, e) {
  if (!e.valid) return [];
  const out = [];
  const { r16, r32 } = m;
  const at = e.valueOffset;
  const n = Math.min(e.count, 64);
  for (let i = 0; i < n; i++) {
    switch (e.type) {
      case 1: case 7: out.push(m.t[at + i]); break;
      case 6: out.push((m.t[at + i] << 24) >> 24); break;
      case 3: out.push(r16(at + i * 2)); break;
      case 8: out.push((r16(at + i * 2) << 16) >> 16); break;
      case 4: case 13: out.push(r32(at + i * 4)); break;
      case 9: out.push(r32(at + i * 4) | 0); break;
      case 5: { const d = r32(at + i * 8 + 4); out.push(d ? r32(at + i * 8) / d : NaN); break; }
      case 10: { const d = r32(at + i * 8 + 4) | 0; out.push(d ? (r32(at + i * 8) | 0) / d : NaN); break; }
      default: return out;
    }
  }
  return out;
}

function readText(m, e) {
  if (!e.valid) return '';
  const b = valueBytes(m, e);
  if (e.tag >= 0x9c9b && e.tag <= 0x9c9f) {
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) {
      const c = b[i] | (b[i + 1] << 8);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }
  if (e.tag === 0x9286) {
    const code = latin1(b, 0, Math.min(8, b.length));
    const rest = b.subarray(Math.min(8, b.length));
    if (code.startsWith('UNICODE')) {
      let s = '';
      for (let i = 0; i + 1 < rest.length; i += 2) {
        const c = m.le ? rest[i] | (rest[i + 1] << 8) : (rest[i] << 8) | rest[i + 1];
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    }
    return latin1(rest).replace(/\0[\s\S]*$/, '').trim();
  }
  if (e.type === 2 || e.type === 7 || e.type === 1 || e.type === 129) {
    let end = b.length;
    const z = b.indexOf(0);
    if (z >= 0) end = z;
    let s = latin1(b, 0, end);
    try { s = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, end)); } catch { /* keep Latin-1 */ }
    return s.trim();
  }
  return readNumbers(m, e).join(' ');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ORIENTATION_TEXT = {
  1: 'Normal', 2: 'Mirrored left to right', 3: 'Turned upside down', 4: 'Mirrored top to bottom',
  5: 'Mirrored and turned 90° anticlockwise', 6: 'Turned 90° clockwise',
  7: 'Mirrored and turned 90° clockwise', 8: 'Turned 90° anticlockwise',
};
export const orientationText = (o) => ORIENTATION_TEXT[o] || `Unknown (${o})`;

function dms(nums) {
  if (!nums.length || nums.some((x) => !Number.isFinite(x))) return null;
  return (nums[0] || 0) + (nums[1] || 0) / 60 + (nums[2] || 0) / 3600;
}

function fmtExposure(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  if (sec >= 1) return `${+sec.toFixed(1)} s`;
  return `1/${Math.round(1 / sec)} s`;
}

// Size of a JPEG preview, read from its SOF marker.
export function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) return null;
    const mk = b[p + 1];
    if (mk === 0xff) { p++; continue; }
    const len = u16be(b, p + 2);
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
      return { width: u16be(b, p + 7), height: u16be(b, p + 5) };
    }
    if (mk === 0xda) return null;
    p += 2 + len;
  }
  return null;
}

// Where a preview directory's picture lies. A length that runs past the end of the block
// is cut at the end, so the bytes that do exist are still found and removed.
function thumbnailRanges(m, ifd) {
  const ranges = [];
  const len = m.t.length;
  const get = (tag) => ifd.entries.find((e) => e.tag === tag && e.valid);
  const off = get(0x0201);
  const cnt = get(0x0202);
  if (off && cnt) {
    const s = readNumbers(m, off)[0];
    const n = readNumbers(m, cnt)[0];
    if (s >= 8 && s < len && n > 0) ranges.push([s, Math.min(len, s + n)]);
  }
  const so = get(0x0111);
  const sc = get(0x0117);
  if (so && sc) {
    const a = readNumbers(m, so);
    const c = readNumbers(m, sc);
    for (let i = 0; i < Math.min(a.length, c.length); i++) if (a[i] >= 8 && a[i] < len && c[i] > 0) ranges.push([a[i], Math.min(len, a[i] + c[i])]);
  }
  return ranges;
}

const tableRange = (ifd) => [ifd.offset, ifd.offset + 2 + ifd.count * 12 + (ifd.hasNext ? 4 : 0)];
const valueRange = (e) => [e.valueOffset, e.valueOffset + e.size];

// Subtracts `minus` from `ranges`; both are lists of [start, end).
const subtract = subtractRanges;

// Value ranges a maker note's own directory points at, outside the maker note block.
// Best effort: maker notes have no standard layout, so a directory is looked for at the
// usual header lengths, and offsets are tried from the TIFF header (Canon, Sony and most
// others) and from the start of the maker note (Fujifilm, Apple). Only bytes that no
// other part of the block uses are claimed, so keeping a maker note can never keep a
// removed GPS value alive.
function makerNoteRanges(m, e) {
  if (!e.valid || e.inline) return [];
  const t = m.t;
  const s = e.valueOffset;
  const end = s + e.size;
  for (const c of [0, 2, 6, 8, 10, 12, 14, 18]) {
    const p = s + c;
    if (p + 2 > end) break;
    const n = m.r16(p);
    if (n < 1 || n > 512 || p + 2 + n * 12 > end) continue;
    let good = 0;
    const byBase = [[], []];
    for (let i = 0; i < n; i++) {
      const q = p + 2 + i * 12;
      const type = m.r16(q + 2);
      const unit = TYPE_SIZE[type];
      if (!unit) continue;
      good++;
      const size = unit * m.r32(q + 4);
      if (size <= 4 || size >= t.length) continue;
      const off = m.r32(q + 8);
      [0, s].forEach((base, k) => { const a = base + off; if (a >= 8 && a + size <= t.length) byBase[k].push([a, a + size]); });
    }
    if (good < Math.ceil(n * 0.8)) continue;
    const inside = (list) => list.filter(([a, b]) => a >= s && b <= end).length;
    const pick = inside(byBase[1]) > inside(byBase[0]) || (inside(byBase[1]) === inside(byBase[0]) && byBase[1].length > byBase[0].length) ? byBase[1] : byBase[0];
    return pick.filter(([a, b]) => a < s || b > end);
  }
  return [];
}

// Who uses which bytes. Returns { referenced, orphans, makernote } where orphans are the
// stretches of the block that nothing references and that are not all zero.
function ownership(m) {
  const referenced = [[0, 8]];
  const others = [[0, 8]];
  let makerNote = null;
  for (const ifd of m.order) {
    referenced.push(tableRange(ifd));
    others.push(tableRange(ifd));
    for (const e of ifd.entries) {
      if (!e.valid || e.inline) continue;
      referenced.push(valueRange(e));
      others.push(valueRange(e));
      if (e.tag === 0x927c && !makerNote && !isChain(ifd)) makerNote = e;
    }
    if (isChain(ifd)) { const r = thumbnailRanges(m, ifd); referenced.push(...r); others.push(...r); }
  }
  const mn = makerNote ? subtract(makerNoteRanges(m, makerNote), others) : [];
  referenced.push(...mn);
  const gaps = subtract([[8, m.t.length]], referenced);
  const orphans = gaps.filter(([s, e]) => { for (let i = s; i < e; i++) if (m.t[i]) return true; return false; });
  return { orphans, makernote: mn };
}

function orphanSummary(m, orphans) {
  let nonZero = 0;
  let best = '';
  for (const [s, e] of orphans) {
    let run = '';
    for (let i = s; i <= e; i++) {
      const c = i < e ? m.t[i] : 0;
      if (c) nonZero++;
      if (c >= 0x20 && c < 0x7f) run += String.fromCharCode(c);
      else { if (run.trim().length > best.trim().length) best = run; run = ''; }
    }
  }
  return { nonZero, text: best.trim() };
}

function describeItem(m, key, entries) {
  const byTag = new Map(entries.map((x) => [x.e.tag, x.e]));
  const text = (tag) => (byTag.has(tag) ? readText(m, byTag.get(tag)) : '');
  const num = (tag) => (byTag.has(tag) ? readNumbers(m, byTag.get(tag))[0] : undefined);
  const join = (list) => clip(list.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '));
  switch (key) {
    case 'gps': {
      const g = m.ifds.gps;
      if (!g) return 'GPS data that could not be read';
      const get = (tag) => g.entries.find((e) => e.tag === tag && e.valid);
      const lat = get(2) ? dms(readNumbers(m, get(2))) : null;
      const lon = get(4) ? dms(readNumbers(m, get(4))) : null;
      const latRef = get(1) ? readText(m, get(1)).charAt(0).toUpperCase() : 'N';
      const lonRef = get(3) ? readText(m, get(3)).charAt(0).toUpperCase() : 'E';
      const parts = [];
      if (lat !== null && lon !== null) parts.push(`${lat.toFixed(4)} ${latRef || 'N'}, ${lon.toFixed(4)} ${lonRef || 'E'}`);
      const alt = get(6) ? readNumbers(m, get(6))[0] : undefined;
      if (Number.isFinite(alt)) {
        const below = get(5) && readNumbers(m, get(5))[0] === 1;
        parts.push(`altitude ${below ? '-' : ''}${Math.round(alt)} m`);
      }
      if (!parts.length) parts.push(`GPS data without a full position (${plural(g.entries.length, 'field')})`);
      return clip(parts.join(', '));
    }
    case 'owner': return join([0x013b, 0xa430, 0x9c9d, 0xa437, 0xa438].map(text)) || plural(entries.length, 'name field');
    case 'serial': return join([0xa431, 0xc62f].map(text));
    case 'lens-serial': return clip(text(0xa435));
    case 'unique-id': return clip(text(0xa420));
    case 'copyright': return clip(text(0x8298));
    case 'datetime': {
      const v = text(0x9003) || text(0x0132) || text(0x9004);
      return v ? clip(v.replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3')) : plural(entries.length, 'date field');
    }
    case 'timezone': return join([0x9011, 0x9010, 0x9012].map(text)) || clip(String(num(0x882a) ?? ''));
    case 'camera': {
      const make = text(0x010f);
      const model = text(0x0110);
      return clip(model && make && model.toLowerCase().startsWith(make.toLowerCase()) ? model : [make, model, text(0xc614)].filter(Boolean).join(' '));
    }
    case 'lens': return join([text(0xa434), text(0xa433)]) || 'Lens specification';
    case 'software': return join([0x0131, 0xa43b, 0xa43a, 0xa43c, 0xa439].map(text));
    case 'computer': return clip(text(0x013c));
    case 'description': return join([0x010e, 0x9286, 0x9c9b, 0x9c9c, 0x9c9f, 0x9c9e, 0xa436, 0x010d, 0x011d].map(text)) || (byTag.has(0x4746) ? `Rating ${num(0x4746)}` : 'Empty text fields');
    case 'makernote': {
      const e = byTag.get(0x927c);
      const b = e && e.valid ? valueBytes(m, e) : new Uint8Array(0);
      const head = latin1(b, 0, Math.min(12, b.length)).match(/^[A-Za-z][A-Za-z0-9 ]{2,}/);
      return clip(`${head ? head[0].trim() + ', ' : ''}${formatBytes(e ? e.size : 0)}`);
    }
    case 'embedded': {
      const what = { 0x02bc: 'XMP', 0x83bb: 'IPTC', 0x8649: 'Photoshop data' };
      return clip(entries.map((x) => `${what[x.e.tag]}, ${formatBytes(x.e.size)}`).join('; '));
    }
    case 'private': {
      const names = entries.map((x) => `tag 0x${x.e.tag.toString(16).padStart(4, '0')}`);
      const total = entries.reduce((n, x) => n + (x.e.valid ? x.e.size : 0), 0);
      return clip(`${names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')}, ${formatBytes(total)}`);
    }
    case 'leftover': {
      const own = ownership(m);
      const sum = orphanSummary(m, own.orphans);
      return clip(`${formatBytes(sum.nonZero)}${sum.text.length >= 4 ? `, including the text "${clip(sum.text, 40)}"` : ''}`);
    }
    case 'thumbnail': {
      const ifd = m.chain[0];
      const ranges = ifd ? thumbnailRanges(m, ifd) : [];
      const total = m.chain.reduce((n, d) => n + thumbnailRanges(m, d).reduce((s, [a, b]) => s + b - a, 0), 0);
      const size = ranges.length ? jpegSize(m.t.subarray(ranges[0][0], ranges[0][1])) : null;
      const more = m.chain.length > 1 ? `, plus ${plural(m.chain.length - 1, 'more preview')}` : '';
      return size ? `${size.width} × ${size.height} pixels, ${formatBytes(total)}${more}` : `${formatBytes(total)}${more}`;
    }
    case 'orientation': return orientationText(num(0x0112));
    case 'dimensions': {
      const w = num(0xa002) ?? num(0x0100);
      const h = num(0xa003) ?? num(0x0101);
      return w && h ? `${w} × ${h} pixels` : plural(entries.length, 'size field');
    }
    case 'resolution': {
      const x = num(0x011a);
      const unit = num(0x0128);
      return Number.isFinite(x) ? `${Math.round(x)} ${unit === 3 ? 'dots per cm' : 'dpi'}` : 'Resolution unit';
    }
    case 'colour': {
      const cs = num(0xa001);
      if (cs === 1) return 'sRGB';
      if (cs === 2) return 'Adobe RGB';
      if (cs === 0xffff) return 'Uncalibrated (see colour profile)';
      return plural(entries.length, 'colour field');
    }
    case 'exposure': {
      const parts = [fmtExposure(num(0x829a))];
      const f = num(0x829d);
      if (Number.isFinite(f) && f > 0) parts.push(`f/${+f.toFixed(1)}`);
      const iso = num(0x8827);
      if (iso) parts.push(`ISO ${iso}`);
      const fl = num(0x920a);
      if (Number.isFinite(fl) && fl > 0) parts.push(`${+fl.toFixed(1)} mm`);
      return clip(parts.filter(Boolean).join(', ') || plural(entries.length, 'setting'));
    }
    case 'format': {
      const v = text(0x9000);
      return v && /^\d{4}$/.test(v) ? `Exif version ${+v.slice(0, 2)}.${v.slice(2)}` : plural(entries.length, 'field');
    }
    default: {
      const names = entries.map((x) => TAG_NAMES[x.e.tag] || `tag 0x${x.e.tag.toString(16).padStart(4, '0')}`);
      return clip(names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '));
    }
  }
}

// Items present in a parsed TIFF, in display order: [{key, group, tier, label, value, note}].
export function tiffItems(m) {
  const buckets = new Map();
  for (const ifd of m.order) {
    for (const e of ifd.entries) {
      const key = entryKey(m, ifd, e);
      if (!key) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ ifd, e });
    }
  }
  if (m.chain.length && !buckets.has('thumbnail')) buckets.set('thumbnail', []);
  if (m.ifds.gps && !buckets.has('gps')) buckets.set('gps', []);
  if (m.ifds.ifd0) {
    const own = ownership(m);
    if (orphanSummary(m, own.orphans).nonZero >= 4) buckets.set('leftover', []);
  }
  const out = [];
  for (const [key, def] of Object.entries(TIFF_ITEMS)) {
    const entries = buckets.get(key);
    if (!entries) continue;
    out.push({ key, ...def, value: describeItem(m, key, entries) });
  }
  return out;
}

export function tiffOrientation(m) {
  const ifd0 = m && m.ifds.ifd0;
  const e = ifd0 && ifd0.entries.find((x) => x.tag === 0x0112 && x.valid);
  const v = e ? readNumbers(m, e)[0] : 1;
  return v >= 1 && v <= 8 ? v : 1;
}

export function tiffIsEmpty(m) {
  return !m.ifds.ifd0 || (m.ifds.ifd0.count === 0 && !m.chain.length);
}

// ======================================================================================
// In-place removal

// Removes every entry whose key is in `keys`, then zeroes every byte of the block that no
// kept part uses. Returns { changed, empty } where empty means nothing is left in IFD0 or
// the preview chain, so the caller may drop the whole EXIF block.
export function removeTiffKeys(m, keys) {
  const t = m.t;
  if (!m.ifds.ifd0) return { changed: false, empty: true };
  const own = ownership(m);
  const dropped = new Set();
  const removed = new Map();
  const mark = (ifd, e) => {
    if (!removed.has(ifd.name)) removed.set(ifd.name, new Set());
    removed.get(ifd.name).add(e.index);
  };

  for (const ifd of m.order) {
    if (ifd.name.startsWith('gps') && keys.has('gps')) { dropped.add(ifd.name); continue; }
    if (isChain(ifd) && keys.has('thumbnail')) { dropped.add(ifd.name); continue; }
    if (ifd.name === 'interop' && keys.has('format')) { dropped.add(ifd.name); continue; }
    for (const e of ifd.entries) {
      const key = entryKey(m, ifd, e);
      if (key && keys.has(key)) mark(ifd, e);
    }
  }

  // Children before parents (the parse order lists parents first): an emptied or dropped
  // sub-IFD takes its pointer with it, which may in turn empty the parent.
  const liveCount = (ifd) => (dropped.has(ifd.name) ? 0 : ifd.count - (removed.get(ifd.name)?.size || 0));
  for (const c of [...m.order].reverse()) {
    if (!c.parent) continue;
    if (dropped.has(c.name) || (removed.get(c.name)?.size && liveCount(c) === 0)) {
      dropped.add(c.name);
      const parent = m.ifds[c.parent.ifd];
      const pe = parent && parent.entries[c.parent.entry];
      if (pe) mark(parent, pe);
    }
  }
  const leftoverGone = keys.has('leftover') && own.orphans.length > 0;
  if (!dropped.size && !removed.size && !leftoverGone) return { changed: false, empty: tiffIsEmpty(m) };

  const live = [[0, 8]];
  const rewrites = [];
  for (const ifd of m.order) {
    if (dropped.has(ifd.name)) continue;
    const rem = removed.get(ifd.name) || new Set();
    const kept = ifd.entries.filter((e) => !rem.has(e.index));
    for (const e of kept) {
      if (!e.inline && e.valid) live.push(valueRange(e));
      if (e.tag === 0x927c && !isChain(ifd)) live.push(...own.makernote);
    }
    if (isChain(ifd)) live.push(...thumbnailRanges(m, ifd));
    const newEnd = ifd.offset + 2 + kept.length * 12 + (ifd.hasNext ? 4 : 0);
    live.push([ifd.offset, newEnd]);
    let next = ifd.next;
    if ((ifd.name === 'ifd0' || isChain(ifd)) && next && m.chain.some((d) => d.offset === next && dropped.has(d.name))) next = 0;
    if (rem.size || next !== ifd.next) rewrites.push({ ifd, kept, next });
  }
  if (!keys.has('leftover')) live.push(...own.orphans);

  for (const { ifd, kept, next } of rewrites) {
    const copies = kept.map((e) => t.slice(e.entryPos, e.entryPos + 12));
    m.w16(ifd.offset, kept.length);
    copies.forEach((c, i) => t.set(c, ifd.offset + 2 + i * 12));
    if (ifd.hasNext) m.w32(ifd.offset + 2 + kept.length * 12, next);
  }
  zeroRanges(t, [[8, t.length]], live);

  const ifd0Left = liveCount(m.ifds.ifd0);
  const chainLeft = m.chain.some((d) => !dropped.has(d.name));
  return { changed: true, empty: ifd0Left === 0 && !chainLeft };
}

// Makes an EXIF block empty in place: header kept, IFD0 with no entries, everything else zero.
export function blankTiff(m) {
  const t = m.t;
  const off = m.r32(4);
  if (off >= 8 && off + 6 <= t.length) {
    t.fill(0, 8);
    m.w16(off, 0);
    m.w32(off + 2, 0);
  } else {
    t.fill(0, 8);
    if (t.length >= 14) { m.w32(4, 8); m.w16(8, 0); m.w32(10, 0); }
  }
}

// Writes the picture size into PixelXDimension and PixelYDimension, in place.
export function setTiffDimensions(m, width, height) {
  const exif = m && m.ifds.exif;
  if (!exif) return;
  for (const e of exif.entries) {
    if ((e.tag !== 0xa002 && e.tag !== 0xa003) || e.count !== 1) continue;
    const v = e.tag === 0xa002 ? width : height;
    if (e.type === 4) m.w32(e.entryPos + 8, v);
    else if (e.type === 3 && v < 65536) m.w16(e.entryPos + 8, v);
  }
}

// ======================================================================================
// Fresh EXIF for re-encoded pictures

const BUILD_SKIP = new Set([PTR_EXIF, PTR_GPS, PTR_INTEROP, 0x927c, 0x0201, 0x0202, 0x0111, 0x0117,
  0x0116, 0x014a, 0x8773, 0x02bc, 0x83bb, 0x8649, 0xa002, 0xa003, 0x0100, 0x0101, 0xea1c, 0xea1d,
  0x0103, 0x0102, 0x0106, 0x0115, 0x011c, 0x00fe, 0x0212, 0xa005, 0x0144, 0x0145, 0x015b, 0x0140]);
// Keys never written into a fresh block, whatever the user kept: their data only makes
// sense in the original file, or cannot be checked.
const BUILD_NEVER = new Set(['makernote', 'thumbnail', 'embedded', 'private', 'leftover']);

// Builds a new TIFF block holding only the simple tags whose keys are kept. Orientation is
// written as 1 because the caller has baked rotation into the pixels. No MakerNote, no
// preview, no Interop IFD. Returns null when nothing is kept.
export function buildTiff(m, keepKeys) {
  if (!m || !m.ifds.ifd0) return null;
  const keepKey = (k) => keepKeys.has(k) && !BUILD_NEVER.has(k);
  const pick = (ifd, all) => (ifd ? ifd.entries.filter((e) => e.valid && !BUILD_SKIP.has(e.tag) && (all || keepKey(keyForTag(e.tag)))) : []);
  const raw = (e) => ({ tag: e.tag, type: e.type, count: e.count, bytes: m.t.slice(e.valueOffset, e.valueOffset + e.size) });
  const short = (v) => (m.le ? new Uint8Array([v & 255, v >> 8]) : new Uint8Array([v >> 8, v & 255]));
  const ifd0 = pick(m.ifds.ifd0, false).map((e) => (e.tag === 0x0112 ? { tag: 0x0112, type: 3, count: 1, bytes: short(1) } : raw(e)));
  const exif = pick(m.ifds.exif, false).map(raw);
  const gps = keepKey('gps') ? pick(m.ifds.gps, true).map(raw) : [];
  if (!ifd0.length && !exif.length && !gps.length) return null;
  // Fields every EXIF block in a JPEG is expected to have. They are structural and green;
  // the picture size is filled in by insertExif from the picture it goes into.
  const long = (v) => (m.le ? new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24]) : new Uint8Array([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]));
  const add = (list, tag, type, count, bytes) => { if (!list.some((e) => e.tag === tag)) list.push({ tag, type, count, bytes }); };
  const ascii = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  add(ifd0, 0x011a, 5, 1, new Uint8Array([...long(72), ...long(1)]));
  add(ifd0, 0x011b, 5, 1, new Uint8Array([...long(72), ...long(1)]));
  add(ifd0, 0x0128, 3, 1, short(2));
  add(ifd0, 0x0213, 3, 1, short(1));
  add(exif, 0x9000, 7, 4, ascii('0232'));
  add(exif, 0x9101, 7, 4, new Uint8Array([1, 2, 3, 0]));
  add(exif, 0xa000, 7, 4, ascii('0100'));
  add(exif, 0xa001, 3, 1, short(1));
  add(exif, 0xa002, 4, 1, long(0));
  add(exif, 0xa003, 4, 1, long(0));
  if (gps.length && !gps.some((e) => e.tag === 0x0000)) gps.push({ tag: 0x0000, type: 1, count: 4, bytes: new Uint8Array([2, 3, 0, 0]) });
  ifd0.push({ tag: PTR_EXIF, type: 4, count: 1, ptr: 'exif' });
  if (gps.length) ifd0.push({ tag: PTR_GPS, type: 4, count: 1, ptr: 'gps' });
  const dirs = [['ifd0', ifd0], ['exif', exif], ['gps', gps]].filter(([, l]) => l.length);
  for (const [, list] of dirs) list.sort((a, b) => a.tag - b.tag);

  // Layout: header, then each directory followed by its out-of-line values.
  let size = 8;
  const at = {};
  for (const [name, list] of dirs) {
    at[name] = size;
    size += 2 + list.length * 12 + 4;
    for (const e of list) if (e.bytes && e.bytes.length > 4) size += e.bytes.length + (e.bytes.length & 1);
  }
  const out = new Uint8Array(size);
  const w16 = (p, v) => { if (m.le) { out[p] = v & 255; out[p + 1] = v >> 8; } else { out[p] = v >> 8; out[p + 1] = v & 255; } };
  const w32 = (p, v) => {
    if (m.le) { out[p] = v & 255; out[p + 1] = (v >>> 8) & 255; out[p + 2] = (v >>> 16) & 255; out[p + 3] = v >>> 24; }
    else { out[p] = v >>> 24; out[p + 1] = (v >>> 16) & 255; out[p + 2] = (v >>> 8) & 255; out[p + 3] = v & 255; }
  };
  out[0] = out[1] = m.le ? 0x49 : 0x4d;
  w16(2, 42);
  w32(4, 8);
  for (const [name, list] of dirs) {
    const base = at[name];
    w16(base, list.length);
    let data = base + 2 + list.length * 12 + 4;
    list.forEach((e, i) => {
      const p = base + 2 + i * 12;
      w16(p, e.tag); w16(p + 2, e.type); w32(p + 4, e.count);
      if (e.ptr) w32(p + 8, at[e.ptr]);
      else if (e.bytes.length <= 4) out.set(e.bytes, p + 8);
      else { w32(p + 8, data); out.set(e.bytes, data); data += e.bytes.length + (e.bytes.length & 1); }
    });
    w32(base + 2 + list.length * 12, 0);
  }
  return out;
}
