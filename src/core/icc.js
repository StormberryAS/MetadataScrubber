// ICC colour profiles: what they say, and what in them is more than colour.
//
// A profile is green and kept by default, because removing it can shift colours. Its
// colour data is numbers, but its text tags (description, copyright, device maker and
// model, viewing conditions, metadata) are free text that can carry a name, and so are the
// free fields of its header and any byte a colour engine does not read. So the profile is
// read strictly: a text tag stays only when every string in it is a well-known profile name
// or vendor line (the list below), a colour tag only under a signature that takes it, with
// a type that signature allows, and only the bytes its structure uses count as colour; the
// header's free fields must be zero or registered values. Anything else is offered as text
// inside the colour profile: other text, private tags, tags of a kind that holds no colour,
// bytes no tag uses, bytes inside colour tags that colour engines ignore, free header
// fields, set reserved header bytes and a profile ID that is not the profile's checksum.
//
// Removing that text rewrites the profile IN PLACE: each such text tag is overwritten, at
// its own offset and within its own size, with a fixed neutral value and zeros; the other
// tags are dropped from the table; stray bytes and free header fields are zeroed. Every byte
// a colour engine reads keeps its place and value, the profile keeps its size, and so the
// colours cannot change (and a HEIC box around it keeps its size too). The profile ID is
// recomputed when the old one was right, and cleared to zero, which means "not computed",
// otherwise.

import { clip, latin1, startsWith, u16be, u32be } from './bytes.js?v=4d7df4d3';

// ======================================================================================
// The allowlist: profile names and vendor lines that ship in cameras, phones, operating
// systems and editors, plus the neutral values this module writes. Exact strings only,
// apart from a year where vendors put one. A fixed string carries no hidden information;
// a year carries a few bits at most.

const YEAR = '(?:19[89]\\d|20[0-4]\\d)';
const ICC_TEXTS = new Set([
  // Descriptions: sRGB and its variants.
  'sRGB', 'sRGB IEC61966-2.1', 'sRGB IEC61966-2-1', 'sRGB IEC61966-2-1 black scaled', 'sRGB IEC61966-2-1 no black scaling',
  'sRGB built-in', 'sRGB2014', 'sRGB v4 ICC preference perceptual intent beta', 'sRGB v4 ICC appearance beta',
  'sRGB v1.31 (Canon)', 'sRGB Profile', 'sRGB profile', 'Linear sRGB', 'scRGB', 'sGray', 'sYCC',
  // Wide gamut, HDR and video spaces.
  'Display P3', 'DCI-P3', 'DCI-P3 D65', 'DCI(P3) RGB', 'P3 D65', 'P3-D65', 'Display P3 Linear',
  'Adobe RGB (1998)', 'Compatible with Adobe RGB (1998)', 'AdobeRGB', 'Apple RGB', 'ColorMatch RGB', 'ProPhoto RGB',
  'ROMM RGB', 'ROMM-RGB', 'Wide Gamut RGB', 'eciRGB v2', 'ECI-RGB.V1.0',
  'Rec. 709', 'Rec.709', 'Rec709', 'ITU-R BT.709', 'HDTV (Rec. 709)', 'ITU-R BT.709 RGB',
  'Rec. 2020', 'Rec.2020', 'Rec2020', 'ITU-R BT.2020', 'Rec. ITU-R BT.2020-1', 'Linear Rec2020 RGB',
  'Rec. ITU-R BT.2100 PQ', 'Rec. ITU-R BT.2100 HLG', 'ITU-R BT.2100 PQ', 'ITU-R BT.2100 HLG', 'Rec. 2100 PQ',
  'Rec. 2100 HLG', 'Rec2100 PQ', 'Rec2100 HLG', 'BT.2100 PQ', 'BT.2100 HLG', 'ITUR_2100_PQ_FULL', 'ITUR_2100_HLG_FULL',
  // Grey and print defaults of common editors.
  'Generic Gray Gamma 2.2 Profile', 'Generic Gray Profile', 'Gray Gamma 2.2', 'Gray Gamma 1.8', 'Dot Gain 20%',
  'Generic RGB Profile', 'Generic CMYK Profile', 'U.S. Web Coated (SWOP) v2', 'Coated FOGRA39 (ISO 12647-2:2004)',
  'Japan Color 2001 Coated',
  // Built-in profiles of GIMP, Facebook's compact profile, and the neutral description.
  'GIMP built-in sRGB', 'GIMP built-in Linear sRGB', 'GIMP built-in D65 Grayscale with sRGB TRC', 'GIMP', 'c2',
  'ICC profile',
  // Copyright lines.
  'Copyright (c) 1998 Hewlett-Packard Company', 'Copyright International Color Consortium',
  'Copyright Adobe Systems Incorporated', 'No copyright, use freely', 'Public Domain', 'CC0', 'FB',
  'This profile is free of known copyright restrictions',
  'Copyright (c) Eastman Kodak Company, 1999, all rights reserved.',
  // Device maker, device model and viewing conditions of the HP and Microsoft sRGB profile.
  'IEC http://www.iec.ch', 'IEC 61966-2.1 Default RGB colour space - sRGB', 'IEC 61966-2-1 Default RGB Colour Space - sRGB',
  'Reference Viewing Condition in IEC61966-2.1', 'Reference Viewing Condition in IEC 61966-2-1',
]);
const ICC_PATTERNS = [
  // libultrahdr (Android Ultra HDR) names its profiles from the gamut and the transfer.
  /^(?:sRGB|Display P3|Rec2020|Unknown) Gamut with (?:sRGB|Linear|2\.2|PQ|HLG|Unknown) Transfer$/,
  new RegExp(`^Copyright Apple Inc\\., ${YEAR}$`),
  new RegExp(`^Copyright (?:\\(c\\) )?${YEAR} Apple(?: Computer)? Inc\\.(?:, all rights reserved\\.)?$`),
  new RegExp(`^Copyright (?:\\(c\\) )?${YEAR} Apple(?: Computer)? Inc$`),
  new RegExp(`^Copyright International Color Consortium, ${YEAR}$`),
  new RegExp(`^(?:Copyright )?Google Inc\\.,? ${YEAR}$`),
  new RegExp(`^Copyright (?:\\(c\\) )?${YEAR} Google (?:Inc\\.|LLC)$`),
  new RegExp(`^Copyright ${YEAR} Adobe Systems Incorporated$`),
  new RegExp(`^Copyright (?:Artifex Software ${YEAR}|${YEAR} Artifex Software Inc)$`),
];
// Generic names writers give an embedded profile (PNG iCCP), besides the names above.
// Skia (Chrome, Android) names every profile it writes into a PNG "Skia".
const PROFILE_NAMES = new Set(['ICC Profile', 'icc', 'ICC', 'Photoshop ICC profile', 'Embedded Profile', 'Skia']);

// Only trailing NULs and trailing ASCII spaces (some profiles pad their copyright line
// with them; their number carries a few bits at most) are dropped. Any other character,
// tabs and other white space included, is part of the text and must match exactly.
const norm = (s) => s.replace(/\0+$/, '').replace(/ +$/, '');
// Whether one string from a text tag is a well-known value. Empty text is allowed.
export function iccTextAllowed(s) {
  const t = norm(s);
  return !t || ICC_TEXTS.has(t) || ICC_PATTERNS.some((re) => re.test(t));
}
// Whether a profile's name (PNG iCCP, XMP photoshop:ICCProfile) is a well-known one.
export function iccNameAllowed(s) {
  const t = norm(s);
  return !!t && (ICC_TEXTS.has(t) || PROFILE_NAMES.has(t) || ICC_PATTERNS.some((re) => re.test(t)));
}

// ======================================================================================
// Tag kinds

// Types that hold text: checked against the list, and neutralised when they fail.
const TEXT_TYPES = new Set(['desc', 'text', 'mluc', 'dict', 'utf8', 'ut16', 'zut8']);
// The colour tags a colour engine reads, each with the types the specification gives it
// (ICC.1:2022 section 9, ICC.1:2001-04 section 6.4), plus the measurement and viewing
// condition tags of the HP sRGB profile most cameras embed, which hold a fixed set of
// numbers. Every other signature, and these signatures with any other type, hold nothing a
// colour engine needs (targets, calibration dates, private tags), so they go with the text.
const LUT_TYPES = ['mft1', 'mft2', 'mAB ', 'mBA '];
const TAG_TYPES = {
  rXYZ: ['XYZ '], gXYZ: ['XYZ '], bXYZ: ['XYZ '], wtpt: ['XYZ '], bkpt: ['XYZ '], lumi: ['XYZ '],
  rTRC: ['curv', 'para'], gTRC: ['curv', 'para'], bTRC: ['curv', 'para'], kTRC: ['curv', 'para'],
  chad: ['sf32'], chrm: ['chrm'], cicp: ['cicp'], clro: ['clro'], meas: ['meas'], view: ['view'],
  A2B0: LUT_TYPES, A2B1: LUT_TYPES, A2B2: LUT_TYPES, B2A0: LUT_TYPES, B2A1: LUT_TYPES, B2A2: LUT_TYPES,
  gamt: LUT_TYPES, pre0: LUT_TYPES, pre1: LUT_TYPES, pre2: LUT_TYPES,
  D2B0: ['mpet'], D2B1: ['mpet'], D2B2: ['mpet'], D2B3: ['mpet'], B2D0: ['mpet'], B2D1: ['mpet'], B2D2: ['mpet'], B2D3: ['mpet'],
  tech: ['sig '], ciis: ['sig '], rig0: ['sig '], rig2: ['sig '],
};
// Signature-type tags hold one of a few registered values.
const SIG_VALUES = {
  tech: ['fscn', 'dcam', 'rscn', 'ijet', 'twax', 'epho', 'esta', 'dsub', 'rpho', 'fprn', 'vidm', 'vidc', 'pjtv', 'CRT ',
    'PMD ', 'AMD ', 'KPCD', 'imgs', 'grav', 'offs', 'silk', 'flex', 'mpfs', 'mpfr', 'dmpc', 'dcpj'],
  ciis: ['scoe', 'sape', 'fpce'],
  rig0: ['prmg'],
  rig2: ['prmg', 'vrmg'],
};
const TAG_LABEL = { desc: 'description', cprt: 'copyright', dmnd: 'device maker', dmdd: 'device model', vued: 'viewing conditions', meta: 'metadata', targ: 'target', scrd: 'screening' };
const sigText = (sig) => sig.replace(/[^\x20-\x7e]/g, '?').trim() || '?';
const labelOf = (sig) => TAG_LABEL[sig] || `tag ${sigText(sig)}`;

const MAX_TAGS = 1024;
const MAX_RECORDS = 1024;
// The language and country codes a description may carry: a profile names itself in
// English, and the codes of any other record are free letters that could spell anything.
const MLUC_CODES = new Set(['enUS', 'enGB', 'en\0\0']);

function utf16(b, s, e) {
  let out = '';
  for (let j = s; j + 1 < e; j += 2) out += String.fromCharCode((b[j] << 8) | b[j + 1]);
  return out;
}
const allZero = (b, s, e) => { for (let i = s; i < e; i++) if (b[i]) return false; return true; };
// A string up to its first NUL; dirty when anything after that NUL is not zero.
function cut(str) {
  const z = str.indexOf('\0');
  if (z < 0) return { text: str, dirty: false };
  return { text: str.slice(0, z), dirty: /[^\0]/.test(str.slice(z)) };
}

// Reads one text tag. Returns { ok, strings, dirty } where dirty means bytes the
// structure does not account for are not zero; ok is false when the structure does not
// fit in the tag.
function readTextTag(b, off, len, type) {
  const end = off + len;
  const strings = [];
  let dirty = false;
  const take = (str) => { const c = cut(str); strings.push(c.text); if (c.dirty) dirty = true; };
  const restZero = (p) => { if (p < end && !allZero(b, p, end)) dirty = true; };
  if (len < 8) return { ok: false };
  if (!allZero(b, off + 4, off + 8)) dirty = true;
  if (type === 'text') { take(latin1(b, off + 8, end)); return { ok: true, strings, dirty }; }
  if (type === 'utf8' || type === 'zut8') { take(new TextDecoder('utf-8').decode(b.subarray(off + 8, end))); return { ok: true, strings, dirty }; }
  if (type === 'ut16') {
    if ((len - 8) % 2) dirty = true;
    take(utf16(b, off + 8, end));
    return { ok: true, strings, dirty };
  }
  if (type === 'desc') {
    if (len < 12) return { ok: false };
    const ac = u32be(b, off + 8);
    if (12 + ac > len) return { ok: false };
    take(latin1(b, off + 12, off + 12 + ac));
    let p = off + 12 + ac;
    if (p + 8 > end) { restZero(p); return { ok: true, strings, dirty }; }
    const lang = latin1(b, p, p + 4);
    const uc = u32be(b, p + 4);
    if (p + 8 + 2 * uc > end) return { ok: false };
    // The Unicode language code is a free four-byte field: zero, or English.
    if (lang !== '\0\0\0\0' && !(uc && MLUC_CODES.has(lang))) dirty = true;
    if (uc) take(utf16(b, p + 8, p + 8 + 2 * uc));
    p += 8 + 2 * uc;
    if (p + 3 > end) { restZero(p); return { ok: true, strings, dirty }; }
    const code = u16be(b, p);
    const sc = b[p + 2];
    if (sc > 67) return { ok: false };
    const sEnd = Math.min(end, p + 3 + 67);
    if (p + 3 + sc > sEnd) return { ok: false };
    // The ScriptCode code is free too; profiles write zero.
    if (code) dirty = true;
    if (sc) take(latin1(b, p + 3, p + 3 + sc));
    restZero(p + 3 + sc);
    return { ok: true, strings, dirty };
  }
  if (type === 'mluc') {
    if (len < 16) return { ok: false };
    const n = u32be(b, off + 8);
    const rs = u32be(b, off + 12);
    if (n > MAX_RECORDS || (n && rs !== 12) || 16 + n * 12 > len) return { ok: false };
    const used = [[off, off + 16 + n * 12]];
    const codes = new Set();
    for (let i = 0; i < n; i++) {
      const r = off + 16 + i * 12;
      const code = latin1(b, r, r + 4);
      // Codes other than English, and the same code twice, are free letters.
      if (!MLUC_CODES.has(code) || codes.has(code)) dirty = true;
      codes.add(code);
      const sl = u32be(b, r + 4);
      const so = u32be(b, r + 8);
      if (sl % 2 || so + sl > len || so < 16 + n * 12) return { ok: false };
      take(utf16(b, off + so, off + so + sl));
      used.push([off + so, off + so + sl]);
    }
    used.sort((x, y) => x[0] - y[0]);
    let p = off;
    for (const [s, e] of used) { if (s > p && !allZero(b, p, s)) dirty = true; p = Math.max(p, e); }
    restZero(p);
    return { ok: true, strings, dirty };
  }
  if (type === 'dict') {
    if (len < 16) return { ok: false };
    const n = u32be(b, off + 8);
    const rs = u32be(b, off + 12);
    if (n > MAX_RECORDS || ![16, 24, 32].includes(rs) || 16 + n * rs > len) return { ok: false };
    for (let i = 0; i < n; i++) {
      const r = off + 16 + i * rs;
      for (let k = 0; k < rs; k += 8) {
        const so = u32be(b, r + k);
        const sl = u32be(b, r + k + 4);
        if (so + sl > len) return { ok: false };
        if (!sl) continue;
        // Names and values are UTF-16 text; the display names are whole mluc structures.
        if (k < 16) take(utf16(b, off + so, off + so + sl));
        else {
          const inner = readTextTag(b, off + so, sl, 'mluc');
          if (!inner.ok) return { ok: false };
          strings.push(...inner.strings);
          if (inner.dirty) dirty = true;
        }
      }
    }
    // Any record at all counts as text that is not on the list.
    if (n) strings.push('(metadata entries)');
    return { ok: true, strings, dirty };
  }
  return { ok: false };
}

// ======================================================================================
// Colour tags: which of their bytes a colour engine reads.
//
// A colour tag is kept byte for byte, but only the bytes its type's structure uses carry
// colour: reserved fields, padding and anything after the structure are free, so they must
// be zero. These return the used ranges (absolute positions) of one colour tag, or null when
// its structure does not fit inside the tag.

const align4 = (n) => (n + 3) & ~3;

// One curve element (curv or para) at p, ending by end: { ranges, len } or null.
function curveElement(b, p, end) {
  if (p + 12 > end) return null;
  const type = latin1(b, p, p + 4);
  if (type === 'curv') {
    const n = u32be(b, p + 8);
    const len = 12 + 2 * n;
    return p + len <= end ? { ranges: [[p, p + 4], [p + 8, p + len]], len } : null;
  }
  if (type === 'para') {
    const fn = u16be(b, p + 8);
    if (fn > 4) return null;
    const len = 12 + 4 * [1, 3, 4, 5, 7][fn];
    return p + len <= end ? { ranges: [[p, p + 4], [p + 8, p + 10], [p + 12, p + len]], len } : null;
  }
  return null;
}

// A sequence of n curve elements, each starting on a four-byte boundary from the tag start.
function curveSet(b, tagOff, p, n, end, out) {
  for (let i = 0; i < n; i++) {
    const c = curveElement(b, p, end);
    if (!c) return false;
    out.push(...c.ranges);
    p = tagOff + align4(p - tagOff + c.len);
  }
  return true;
}

// s15Fixed16 numbers from p on, each with |value| below lim.
const s15 = (b, p) => (u32be(b, p) | 0) / 65536;
const numbersIn = (b, p, n, lo, hi) => { for (let i = 0; i < n; i++) { const v = s15(b, p + 4 * i); if (v < lo || v >= hi) return false; } return true; };
const enumIn = (b, p, max) => u32be(b, p) <= max;
const HP_MEAS = [0x6d, 0x65, 0x61, 0x73, ...new Array(23).fill(0), 2, ...new Array(11).fill(0), 2];

function colourUsed(b, off, len, type, sig) {
  const end = off + len;
  const head = [off, off + 4];
  const fits = (n) => off + n <= end;
  switch (type) {
    // Colour tristimulus values lie well within -4..4; luminance is in candelas per square
    // metre. Text written as numbers falls far outside these ranges.
    case 'XYZ ': return fits(20) && (sig === 'lumi' ? numbersIn(b, off + 8, 3, 0, 32768) : numbersIn(b, off + 8, 3, -4, 4)) ? [head, [off + 8, off + 20]] : null;
    case 'sf32': return fits(44) && numbersIn(b, off + 8, 9, -4, 4) ? [head, [off + 8, off + 44]] : null;
    // Measurement: observer, backing XYZ, geometry, flare, illuminant type.
    // The HP sRGB profile's own measurement tag is 40 bytes long; it is taken as it is.
    case 'meas':
      if (len === 40 && HP_MEAS.every((x, i) => b[off + i] === x)) return [[off, off + 40]];
      return fits(36) && enumIn(b, off + 8, 2) && numbersIn(b, off + 12, 3, 0, 4) && enumIn(b, off + 24, 2) && enumIn(b, off + 28, 0x10000) && enumIn(b, off + 32, 8) ? [head, [off + 8, off + 36]] : null;
    // Viewing conditions: illuminant and surround XYZ in candelas per square metre, illuminant type.
    case 'view': return fits(36) && numbersIn(b, off + 8, 6, 0, 1000) && enumIn(b, off + 32, 8) ? [head, [off + 8, off + 36]] : null;
    case 'curv': case 'para': { const c = curveElement(b, off, end); return c ? c.ranges : null; }
    case 'chrm': {
      if (!fits(12)) return null;
      const ch = u16be(b, off + 8);
      return ch >= 1 && ch <= 15 && fits(12 + 8 * ch) ? [head, [off + 8, off + 12 + 8 * ch]] : null;
    }
    case 'cicp': case 'sig ': return fits(12) ? [head, [off + 8, off + 12]] : null;
    case 'clro': {
      if (!fits(12)) return null;
      const n = u32be(b, off + 8);
      return n <= 15 && fits(12 + n) ? [head, [off + 8, off + 12 + n]] : null;
    }
    case 'mft1': case 'mft2': {
      if (!fits(52)) return null;
      const inp = b[off + 8];
      const outp = b[off + 9];
      const g = b[off + 10];
      if (!inp || !outp || inp > 15 || outp > 15 || g < 2) return null;
      const clut = g ** inp * outp;
      const size = type === 'mft1'
        ? 48 + 256 * inp + clut + 256 * outp
        : 52 + 2 * (u16be(b, off + 48) * inp + clut + u16be(b, off + 50) * outp);
      return Number.isSafeInteger(size) && fits(size) ? [head, [off + 8, off + 11], [off + 12, off + size]] : null;
    }
    case 'mAB ': case 'mBA ': {
      if (!fits(32)) return null;
      const inp = b[off + 8];
      const outp = b[off + 9];
      if (!inp || !outp || inp > 15 || outp > 15) return null;
      const ranges = [head, [off + 8, off + 10], [off + 12, off + 32]];
      const at = (k) => u32be(b, off + 12 + 4 * k);
      const [bOff, mtxOff, mOff, clutOff, aOff] = [0, 1, 2, 3, 4].map(at);
      // mAB: A curves (inputs), CLUT, M curves, matrix, B curves (outputs); mBA the reverse.
      const ab = type === 'mAB ';
      const sets = [[bOff, ab ? outp : inp], [mOff, ab ? outp : inp], [aOff, ab ? inp : outp]];
      for (const [o, n] of sets) if (o && (o >= len || !curveSet(b, off, off + o, n, end, ranges))) return null;
      if (mtxOff) { if (!fits(mtxOff + 48)) return null; ranges.push([off + mtxOff, off + mtxOff + 48]); }
      if (clutOff) {
        if (!fits(clutOff + 20)) return null;
        const c = off + clutOff;
        const prec = b[c + 16];
        if (prec !== 1 && prec !== 2) return null;
        let cells = 1;
        for (let i = 0; i < inp; i++) cells *= b[c + i];
        const size = cells * outp * prec;
        if (!fits(clutOff + 20 + size)) return null;
        ranges.push([c, c + inp], [c + 16, c + 17], [c + 20, c + 20 + size]);
      }
      return ranges;
    }
    case 'mpet': {
      if (!fits(16)) return null;
      const n = u32be(b, off + 12);
      if (n > 256 || !fits(16 + 8 * n)) return null;
      const ranges = [head, [off + 8, off + 16 + 8 * n]];
      // The processing elements themselves are taken whole: their own layouts are not read.
      for (let i = 0; i < n; i++) {
        const eo = u32be(b, off + 16 + 8 * i);
        const es = u32be(b, off + 20 + 8 * i);
        if (eo < 16 + 8 * n || !fits(eo + es)) return null;
        ranges.push([off + eo, off + eo + es]);
      }
      return ranges;
    }
    default: return null;
  }
}

// ======================================================================================
// The header (ICC.1 section 7.2). The fields that say how to read the profile must hold
// registered values; the others (CMM, platform, maker, model, creator, date, flags,
// attributes, intent, illuminant, the version's spare bytes) are free fields that no colour
// conversion reads, so each must be zero or a registered value, and is set to zero (or to
// D50 for the illuminant) when it is not.

const CLASSES = new Set(['scnr', 'mntr', 'prtr', 'link', 'spac', 'abst']);
const SPACES = new Set(['XYZ ', 'Lab ', 'Luv ', 'YCbr', 'Yxy ', 'RGB ', 'GRAY', 'HSV ', 'HLS ', 'CMYK', 'CMY ',
  ...'23456789ABCDEF'.split('').map((c) => `${c}CLR`)]);
// Registered CMM and vendor signatures seen in profiles that ship with cameras, phones,
// operating systems, printers and editors. A fixed four-letter code carries a few bits.
const CMMS = new Set(['ADBE', 'ACMS', 'appl', 'CCMS', 'UCCM', 'UCMS', 'EFI ', 'FF  ', 'EXAC', 'HCMM', 'argl', 'LgoS', 'HDM ',
  'lcms', 'RIMX', 'DIDO', 'KCMS', 'MCML', 'WCS ', 'SIGN', 'ONYX', 'RGMS', 'SICC', 'TCMM', '32BT', 'vivo', 'WTG ', 'zc00',
  'Lino', 'MSFT', 'KODA', 'none', 'HP  ', 'GOOG', 'Skia']);
const VENDORS = new Set(['APPL', 'appl', 'ADBE', 'MSFT', 'KODA', 'GOOG', 'HP  ', 'IEC ', 'none', 'lcms', 'argl', 'CANO',
  'EPSO', 'NIKO', 'NKON', 'SONY', 'FUJI', 'OLYM', 'RICO', 'XRIT', 'Skia', 'LINO', 'Lino', 'SAMS', 'DELL']);
const MODELS = new Set(['sRGB']);
const PLATFORMS = new Set(['APPL', 'MSFT', 'SGI ', 'SUNW', 'TGNT', '*nix']);
const D50 = [0xf6d6, 0x10000, 0xd32d];

// What in the header is free and not zero or registered: [{ text, fix }] where fix writes
// the neutral value into a copy.
function headerFree(b) {
  const out = [];
  const sig = (p) => latin1(b, p, p + 4);
  const zero = (p, n) => allZero(b, p, p + n);
  const listed = (p, set) => zero(p, 4) || set.has(sig(p));
  const clear = (p, n) => (o) => o.fill(0, p, p + n);
  if (!listed(4, CMMS)) out.push({ field: 'CMM', fix: clear(4, 4) });
  if (!zero(10, 2)) out.push({ field: 'version', fix: clear(10, 2) });
  const d = [0, 1, 2, 3, 4, 5].map((i) => u16be(b, 24 + 2 * i));
  const dateOk = d.every((x) => !x) || (d[0] >= 1980 && d[0] <= 2099 && d[1] >= 1 && d[1] <= 12 && d[2] >= 1 && d[2] <= 31 && d[3] <= 23 && d[4] <= 59 && d[5] <= 59);
  if (!dateOk) out.push({ field: 'date', fix: clear(24, 12) });
  if (!listed(40, PLATFORMS)) out.push({ field: 'platform', fix: clear(40, 4) });
  if (!zero(44, 3) || b[47] & 0xfc) out.push({ field: 'flags', fix: (o) => { o.fill(0, 44, 47); o[47] &= 3; } });
  if (!listed(48, VENDORS)) out.push({ field: 'device maker', fix: clear(48, 4) });
  if (!listed(52, MODELS)) out.push({ field: 'device model', fix: clear(52, 4) });
  // Attributes: the four bits the specification defines; the ICC's own sRGB2014 profile
  // also sets one vendor bit, which is allowed as it is.
  const attrs = latin1(b, 56, 63);
  if ((attrs !== '\0\0\0\0\0\0\0' && attrs !== '\0\0\0\x01\0\0\0') || b[63] & 0xf0) out.push({ field: 'attributes', fix: (o) => { o.fill(0, 56, 63); o[63] &= 0x0f; } });
  if (!zero(64, 3) || b[67] > 3) out.push({ field: 'rendering intent', fix: clear(64, 4) });
  if (!D50.every((v, i) => Math.abs(u32be(b, 68 + 4 * i) - v) <= 16)) {
    out.push({ field: 'illuminant', fix: (o) => D50.forEach((v, i) => w32(o, 68 + 4 * i, v)) });
  }
  if (!listed(80, VENDORS)) out.push({ field: 'creator', fix: clear(80, 4) });
  return out;
}

// ======================================================================================
// MD5, for the profile ID (ICC.1 7.2.18).

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
export function md5(data) {
  const n = data.length;
  const total = ((n + 8) >> 6) * 64 + 64;
  const m = new Uint8Array(total);
  m.set(data);
  m[n] = 0x80;
  const bits = n * 8;
  for (let i = 0; i < 8; i++) m[total - 8 + i] = Math.floor(bits / 2 ** (8 * i)) & 255;
  let a0 = 0x67452301; let b0 = 0xefcdab89; let c0 = 0x98badcfe; let d0 = 0x10325476;
  const w = new Uint32Array(16);
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = m[o + i * 4] | (m[o + i * 4 + 1] << 8) | (m[o + i * 4 + 2] << 16) | (m[o + i * 4 + 3] << 24);
    let a = a0; let b = b0; let c = c0; let d = d0;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const s = MD5_S[(i >> 4) * 4 + (i % 4)];
      const t = (a + f + MD5_K[i] + w[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((t << s) | (t >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => { for (let k = 0; k < 4; k++) out[i * 4 + k] = (v >>> (8 * k)) & 255; });
  return out;
}

// The profile ID as the specification computes it: MD5 of the profile with the flags,
// the rendering intent and the ID itself set to zero.
function profileId(b, size) {
  const c = b.slice(0, size);
  c.fill(0, 44, 48);
  c.fill(0, 64, 68);
  c.fill(0, 84, 100);
  return md5(c);
}

// ======================================================================================
// Reading

// Reads a profile strictly. Returns { ok: false } when it cannot be read safely, else
// { ok: true, size, tags, free: [{ sig, text }], extra: [text], clean } where free lists the
// text that is not on the list, extra what else no colour engine reads, and clean is true
// when there is neither.
export function inspectIcc(b) {
  const bad = { ok: false };
  if (!b || b.length < 132 || !startsWith(b, 36, 'acsp')) return bad;
  // What says how to read the profile must be registered; a named-colour profile is a list
  // of named colours, not a colour space, so it is not read either.
  if (!CLASSES.has(latin1(b, 12, 16)) || !SPACES.has(latin1(b, 16, 20)) || !SPACES.has(latin1(b, 20, 24))) return bad;
  if (![2, 4, 5].includes(b[8])) return bad;
  let size = u32be(b, 0);
  if (size < 132) return bad;
  const count = u32be(b, 128);
  if (count > MAX_TAGS || 132 + count * 12 > Math.min(size, b.length)) return bad;
  const tableEnd = 132 + count * 12;
  // A declared size larger than the data is what LittleCMS reads as the data's size, when
  // every tag fits in the data; the size is then written again.
  let sizeFix = false;
  if (size > b.length) { sizeFix = true; size = b.length; }
  const tags = [];
  for (let i = 0; i < count; i++) {
    const e = 132 + i * 12;
    const sig = latin1(b, e, e + 4);
    const off = u32be(b, e + 4);
    const len = u32be(b, e + 8);
    if (off < tableEnd || len < 8 || off + len > size) return bad;
    const type = latin1(b, off, off + 4);
    let kind = 'strip';
    if (TEXT_TYPES.has(type)) kind = 'text';
    else if (TAG_TYPES[sig] && TAG_TYPES[sig].includes(type)) {
      kind = 'keep';
      if (type === 'sig ' && !SIG_VALUES[sig].includes(latin1(b, off + 8, off + 12))) kind = 'strip';
    }
    tags.push({ index: i, sig, off, len, type, kind });
  }
  // Tags may share their data (the same offset and size), but a tag that is rewritten or
  // dropped must not partly overlap any other, or the rewrite would touch it.
  const byOff = [...tags].sort((x, y) => x.off - y.off || x.len - y.len);
  for (let i = 0; i < byOff.length; i++) {
    const t = byOff[i];
    for (let j = i + 1; j < byOff.length && byOff[j].off < t.off + t.len; j++) {
      const u = byOff[j];
      const same = u.off === t.off && u.len === t.len;
      if (same && (t.kind === 'text') === (u.kind === 'text')) continue;
      if (same && t.kind !== 'text' && u.kind !== 'text') continue;
      if (t.kind !== 'keep' || u.kind !== 'keep') return bad;
    }
  }
  // The bytes each colour tag's structure uses; a structure that does not fit is not read.
  const used = new Map();
  for (const t of tags) {
    if (t.kind !== 'keep') continue;
    const key = `${t.off}:${t.len}`;
    const k2 = `${key}:${t.sig === 'lumi'}`;
    if (!used.has(k2)) used.set(k2, colourUsed(b, t.off, t.len, t.type, t.sig));
    t.used = used.get(k2);
    if (t.used) continue;
    // Measurement and viewing data that does not fit its form goes like a private tag; a
    // colour tag that does not fit cannot be read.
    if (t.sig !== 'meas' && t.sig !== 'view') return bad;
    t.kind = 'strip';
  }
  const free = [];
  const extra = [];
  const seen = new Map();
  for (const t of tags) {
    if (t.kind !== 'text') continue;
    const key = `${t.off}:${t.len}`;
    let r = seen.get(key);
    if (!r) {
      r = readTextTag(b, t.off, t.len, t.type);
      // A text tag whose structure does not fit is text that cannot be read: it is
      // overwritten like any other, inside its own space, so the profile stays readable.
      if (!r.ok) r = { ok: true, strings: [], dirty: true, unreadable: true };
      r.allowed = !r.dirty && r.strings.every(iccTextAllowed);
      seen.set(key, r);
    }
    t.allowed = r.allowed;
    t.strings = r.strings;
    if (!r.allowed) {
      const shown = [...new Set(r.strings.map(norm).filter((s) => s && !iccTextAllowed(s)))];
      free.push({ sig: t.sig, text: shown.join(' | ') || (r.unreadable ? 'text that could not be read' : r.dirty ? 'hidden bytes' : 'text') });
    }
  }
  const stripped = tags.filter((t) => t.kind === 'strip');
  if (stripped.length) {
    const sigs = [...new Set(stripped.map((t) => sigText(t.sig)))];
    extra.push(`${sigs.length === 1 ? 'tag' : 'tags'} ${sigs.slice(0, 4).join(', ')}${sigs.length > 4 ? ` and ${sigs.length - 4} more` : ''} that most colour engines ignore`);
  }
  // Bytes nothing uses: between the table and the tags, between tags, after the size; and
  // inside colour tags, the reserved fields and whatever follows the structure.
  const whole = maskOf(b.length, [[0, tableEnd], ...tags.map((t) => [t.off, t.off + t.len])]);
  const kept = maskOf(b.length, tags.filter((t) => t.kind === 'keep').map((t) => [t.off, t.off + t.len]));
  const live = maskOf(b.length, liveOf(tags));
  let gaps = false;
  let inside = false;
  for (let i = 128; i < b.length; i++) {
    if (!b[i]) continue;
    if (!whole[i] || i >= size) gaps = true;
    else if (kept[i] && !live[i]) inside = true;
  }
  if (gaps) extra.push('bytes no tag uses');
  if (inside) extra.push('bytes inside colour tags that colour engines ignore');
  const head = headerFree(b);
  if (head.length) extra.push(`header fields (${head.map((h) => h.field).join(', ')})`);
  if (sizeFix) extra.push('a size larger than the profile');
  if (!allZero(b, 100, 128)) extra.push('reserved header bytes');
  const id = b.subarray(84, 100);
  const idSet = !allZero(b, 84, 100);
  const idOk = idSet && !sizeFix && profileId(b, size).every((x, i) => x === id[i]);
  if (idSet && !idOk && !sizeFix) extra.push('a profile ID that is not its checksum');
  return { ok: true, size, count, tags, free, extra, head, sizeFix, idSet, idOk, clean: !free.length && !extra.length };
}

// The ranges a colour engine reads in the kept tags, plus the whole of every text tag.
function liveOf(tags) {
  const live = [];
  for (const t of tags) {
    if (t.kind === 'keep') live.push(...t.used);
    else if (t.kind === 'text') live.push([t.off, t.off + t.len]);
  }
  return live;
}
// A mask with 1 at every position inside one of the ranges.
function maskOf(n, ranges) {
  const m = new Uint8Array(n);
  for (const [s, e] of ranges) m.fill(1, Math.max(0, s), Math.min(n, e));
  return m;
}

// ======================================================================================
// Neutral rewrite

const NEUTRAL_DESC = 'ICC profile';

function writeAscii(out, p, s) { for (let i = 0; i < s.length; i++) out[p + i] = s.charCodeAt(i); }
function w32(out, p, v) { out[p] = v >>> 24; out[p + 1] = (v >>> 16) & 255; out[p + 2] = (v >>> 8) & 255; out[p + 3] = v & 255; }

// Overwrites one text tag with a neutral value of the same type, in its own space.
function neutralTag(out, t) {
  const { off, len, type } = t;
  out.fill(0, off + 4, off + len);
  const text = t.sig === 'desc' ? NEUTRAL_DESC : '';
  if (type === 'desc') {
    // ASCII count and string, then empty Unicode and ScriptCode parts (91 bytes at least).
    const s = len >= 91 + text.length + 1 ? text : '';
    if (len >= 13) { w32(out, off + 8, s.length + 1); writeAscii(out, off + 12, s); }
    return;
  }
  if (type === 'mluc') {
    const s = len >= 28 + 2 * text.length ? text : '';
    if (len >= 28 && s) {
      w32(out, off + 8, 1); w32(out, off + 12, 12);
      writeAscii(out, off + 16, 'enUS');
      w32(out, off + 20, 2 * s.length); w32(out, off + 24, 28);
      for (let i = 0; i < s.length; i++) { out[off + 28 + 2 * i] = 0; out[off + 29 + 2 * i] = s.charCodeAt(i); }
    } else if (len >= 16) w32(out, off + 12, 12);
    return;
  }
  if (type === 'dict') { if (len >= 16) w32(out, off + 12, 16); return; }
  if (type === 'text' || type === 'utf8' || type === 'zut8') { if (len >= 9 + text.length) writeAscii(out, off + 8, text); return; }
  if (type === 'ut16') {
    // An odd length cannot hold whole UTF-16 characters: the last byte stays zero.
    if (len >= 10 + 2 * text.length) for (let i = 0; i < text.length; i++) out[off + 9 + 2 * i] = text.charCodeAt(i);
  }
}

// The same profile with its unlisted text neutralised and everything else no colour
// engine reads removed, same length as the input, or null when that cannot be done
// safely. Colour tags keep their offsets and the bytes a colour engine reads; the result
// is checked.
export function cleanIcc(b) {
  const info = inspectIcc(b);
  if (!info.ok) return null;
  if (info.clean) return b.slice();
  const out = b.slice();
  const { size, tags } = info;
  const keep = tags.filter((t) => t.kind !== 'strip');
  // Text tags that fail, each shared range once.
  const done = new Set();
  for (const t of tags) {
    if (t.kind !== 'text' || t.allowed) continue;
    const key = `${t.off}:${t.len}`;
    if (done.has(key)) continue;
    done.add(key);
    neutralTag(out, t);
  }
  // Drop the other tags from the table.
  out.fill(0, 132, 132 + info.count * 12);
  w32(out, 128, keep.length);
  keep.forEach((t, i) => {
    const e = 132 + i * 12;
    writeAscii(out, e, t.sig);
    w32(out, e + 4, t.off);
    w32(out, e + 8, t.len);
  });
  // Zero every byte past the header that is neither the table, a text tag, nor a byte a
  // colour engine reads in a kept colour tag: dropped tags, gaps, reserved fields and
  // whatever follows a colour tag's structure, and anything after the size.
  const live = [[0, 132 + keep.length * 12], ...liveOf(keep)].sort((x, y) => x[0] - y[0]);
  let p = 128;
  for (const [s, e] of live) { if (s > p) out.fill(0, p, s); p = Math.max(p, e); }
  if (p < out.length) out.fill(0, p, out.length);
  // The header: free fields to zero (the illuminant to D50), the size to the data's.
  for (const h of info.head) h.fix(out);
  if (info.sizeFix) w32(out, 0, size);
  out.fill(0, 100, 128);
  // The profile ID: recomputed when it was right before, else cleared.
  if (info.idSet && info.idOk) out.set(profileId(out, size), 84);
  else out.fill(0, 84, 100);
  // Check: readable, nothing left to clean, and every byte a colour engine reads the same.
  const again = inspectIcc(out);
  if (!again.ok || !again.clean) return null;
  for (const t of keep) {
    if (t.kind !== 'keep') continue;
    for (const [s, e] of t.used) for (let i = s; i < e; i++) if (out[i] !== b[i]) return null;
  }
  return out;
}

// ======================================================================================
// Descriptions for the list

// The profile's own name, for the green detail: the first string of its description that
// is a well-known name (other strings, such as translations, show in the red detail).
export function iccDescription(b) {
  const info = inspectIcc(b);
  if (!info.ok) return 'Colour profile';
  const desc = info.tags.find((t) => t.sig === 'desc' && t.kind === 'text');
  const name = desc ? (desc.strings.map(norm).find((x) => x && iccTextAllowed(x)) || '') : '';
  return clip(name) || 'Colour profile';
}

// What the red detail shows: the unlisted text first, then what else would go.
export function iccFreeText(info) {
  const order = (t) => (t.sig === 'desc' ? 0 : t.sig === 'cprt' ? 1 : 2);
  const parts = [...info.free].sort((x, y) => order(x) - order(y)).map((f) => `${labelOf(f.sig)}: ${f.text}`);
  return clip([...parts, ...info.extra].join('; '));
}

// The red details for one profile: { id, item } to add, or null when it is clean. The
// caller supplies the private removal data.
export const ICC_TEXT_ITEM = {
  id: 'icc:text', group: 'hidden', tier: 'red', label: 'Text inside the colour profile', source: 'ICC profile',
  note: 'Text in the colour profile that is not a known profile name or copyright line, or data no colour engine reads. It can hold names or notes. Removing it rewrites only that text, so the colours stay the same.',
};
export const ICC_UNREADABLE_ITEM = {
  id: 'icc:unreadable', group: 'hidden', tier: 'red', label: 'Colour profile that could not be read', source: 'ICC profile',
  note: 'It may hold anything, so removing it is the safe choice. Colours may look slightly different without it.',
};
