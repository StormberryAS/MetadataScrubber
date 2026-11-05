/*! src/core/icc.js is compiled from ts/src/core/icc.ts by tools/build-ts.sh, which leaves out
    every comment but this one: the explanations are in the source. Edit the TypeScript, never the
    .js: the build refuses to overwrite a hand edit, and its check mode fails on one. */
import { clip, latin1, startsWith, u16be, u32be } from './bytes.js?v=987761c7';
const YEAR = '(?:19[89]\\d|20[0-4]\\d)';
const ICC_TEXTS = new Set([
    'sRGB', 'sRGB IEC61966-2.1', 'sRGB IEC61966-2-1', 'sRGB IEC61966-2-1 black scaled', 'sRGB IEC61966-2-1 no black scaling',
    'sRGB built-in', 'sRGB2014', 'sRGB v4 ICC preference perceptual intent beta', 'sRGB v4 ICC appearance beta',
    'sRGB v1.31 (Canon)', 'sRGB Profile', 'sRGB profile', 'Linear sRGB', 'scRGB', 'sGray', 'sYCC',
    'Display P3', 'DCI-P3', 'DCI-P3 D65', 'DCI(P3) RGB', 'P3 D65', 'P3-D65', 'Display P3 Linear',
    'Adobe RGB (1998)', 'Compatible with Adobe RGB (1998)', 'AdobeRGB', 'Apple RGB', 'ColorMatch RGB', 'ProPhoto RGB',
    'ROMM RGB', 'ROMM-RGB', 'Wide Gamut RGB', 'eciRGB v2', 'ECI-RGB.V1.0',
    'Rec. 709', 'Rec.709', 'Rec709', 'ITU-R BT.709', 'HDTV (Rec. 709)', 'ITU-R BT.709 RGB',
    'Rec. 2020', 'Rec.2020', 'Rec2020', 'ITU-R BT.2020', 'Rec. ITU-R BT.2020-1', 'Linear Rec2020 RGB',
    'Rec. ITU-R BT.2100 PQ', 'Rec. ITU-R BT.2100 HLG', 'ITU-R BT.2100 PQ', 'ITU-R BT.2100 HLG', 'Rec. 2100 PQ',
    'Rec. 2100 HLG', 'Rec2100 PQ', 'Rec2100 HLG', 'BT.2100 PQ', 'BT.2100 HLG', 'ITUR_2100_PQ_FULL', 'ITUR_2100_HLG_FULL',
    'Generic Gray Gamma 2.2 Profile', 'Generic Gray Profile', 'Gray Gamma 2.2', 'Gray Gamma 1.8', 'Dot Gain 20%',
    'Generic RGB Profile', 'Generic CMYK Profile', 'U.S. Web Coated (SWOP) v2', 'Coated FOGRA39 (ISO 12647-2:2004)',
    'Japan Color 2001 Coated',
    'GIMP built-in sRGB', 'GIMP built-in Linear sRGB', 'GIMP built-in D65 Grayscale with sRGB TRC', 'GIMP', 'c2',
    'ICC profile',
    'Copyright (c) 1998 Hewlett-Packard Company', 'Copyright International Color Consortium',
    'Copyright Adobe Systems Incorporated', 'No copyright, use freely', 'Public Domain', 'CC0', 'FB',
    'This profile is free of known copyright restrictions',
    'Copyright (c) Eastman Kodak Company, 1999, all rights reserved.',
    'IEC http://www.iec.ch', 'IEC 61966-2.1 Default RGB colour space - sRGB', 'IEC 61966-2-1 Default RGB Colour Space - sRGB',
    'Reference Viewing Condition in IEC61966-2.1', 'Reference Viewing Condition in IEC 61966-2-1',
]);
const ICC_PATTERNS = [
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
const PROFILE_NAMES = new Set(['ICC Profile', 'icc', 'ICC', 'Photoshop ICC profile', 'Embedded Profile', 'Skia']);
const norm = (s) => s.replace(/\0+$/, '').replace(/ +$/, '');
export function iccTextAllowed(s) {
    const t = norm(s);
    return !t || ICC_TEXTS.has(t) || ICC_PATTERNS.some((re) => re.test(t));
}
export function iccNameAllowed(s) {
    const t = norm(s);
    return !!t && (ICC_TEXTS.has(t) || PROFILE_NAMES.has(t) || ICC_PATTERNS.some((re) => re.test(t)));
}
const TEXT_TYPES = new Set(['desc', 'text', 'mluc', 'dict', 'utf8', 'ut16', 'zut8']);
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
const MLUC_CODES = new Set(['enUS', 'enGB', 'en\0\0']);
function utf16(b, s, e) {
    let out = '';
    for (let j = s; j + 1 < e; j += 2)
        out += String.fromCharCode((b[j] << 8) | b[j + 1]);
    return out;
}
const allZero = (b, s, e) => { for (let i = s; i < e; i++)
    if (b[i])
        return false; return true; };
function cut(str) {
    const z = str.indexOf('\0');
    if (z < 0)
        return { text: str, dirty: false };
    return { text: str.slice(0, z), dirty: /[^\0]/.test(str.slice(z)) };
}
function readTextTag(b, off, len, type) {
    const end = off + len;
    const strings = [];
    let dirty = false;
    const take = (str) => { const c = cut(str); strings.push(c.text); if (c.dirty)
        dirty = true; };
    const restZero = (p) => { if (p < end && !allZero(b, p, end))
        dirty = true; };
    if (len < 8)
        return { ok: false };
    if (!allZero(b, off + 4, off + 8))
        dirty = true;
    if (type === 'text') {
        take(latin1(b, off + 8, end));
        return { ok: true, strings, dirty };
    }
    if (type === 'utf8' || type === 'zut8') {
        take(new TextDecoder('utf-8').decode(b.subarray(off + 8, end)));
        return { ok: true, strings, dirty };
    }
    if (type === 'ut16') {
        if ((len - 8) % 2)
            dirty = true;
        take(utf16(b, off + 8, end));
        return { ok: true, strings, dirty };
    }
    if (type === 'desc') {
        if (len < 12)
            return { ok: false };
        const ac = u32be(b, off + 8);
        if (12 + ac > len)
            return { ok: false };
        take(latin1(b, off + 12, off + 12 + ac));
        let p = off + 12 + ac;
        if (p + 8 > end) {
            restZero(p);
            return { ok: true, strings, dirty };
        }
        const lang = latin1(b, p, p + 4);
        const uc = u32be(b, p + 4);
        if (p + 8 + 2 * uc > end)
            return { ok: false };
        if (lang !== '\0\0\0\0' && !(uc && MLUC_CODES.has(lang)))
            dirty = true;
        if (uc)
            take(utf16(b, p + 8, p + 8 + 2 * uc));
        p += 8 + 2 * uc;
        if (p + 3 > end) {
            restZero(p);
            return { ok: true, strings, dirty };
        }
        const code = u16be(b, p);
        const sc = b[p + 2];
        if (sc > 67)
            return { ok: false };
        const sEnd = Math.min(end, p + 3 + 67);
        if (p + 3 + sc > sEnd)
            return { ok: false };
        if (code)
            dirty = true;
        if (sc)
            take(latin1(b, p + 3, p + 3 + sc));
        restZero(p + 3 + sc);
        return { ok: true, strings, dirty };
    }
    if (type === 'mluc') {
        if (len < 16)
            return { ok: false };
        const n = u32be(b, off + 8);
        const rs = u32be(b, off + 12);
        if (n > MAX_RECORDS || (n && rs !== 12) || 16 + n * 12 > len)
            return { ok: false };
        const used = [[off, off + 16 + n * 12]];
        const codes = new Set();
        for (let i = 0; i < n; i++) {
            const r = off + 16 + i * 12;
            const code = latin1(b, r, r + 4);
            if (!MLUC_CODES.has(code) || codes.has(code))
                dirty = true;
            codes.add(code);
            const sl = u32be(b, r + 4);
            const so = u32be(b, r + 8);
            if (sl % 2 || so + sl > len || so < 16 + n * 12)
                return { ok: false };
            take(utf16(b, off + so, off + so + sl));
            used.push([off + so, off + so + sl]);
        }
        used.sort((x, y) => x[0] - y[0]);
        let p = off;
        for (const [s, e] of used) {
            if (s > p && !allZero(b, p, s))
                dirty = true;
            p = Math.max(p, e);
        }
        restZero(p);
        return { ok: true, strings, dirty };
    }
    if (type === 'dict') {
        if (len < 16)
            return { ok: false };
        const n = u32be(b, off + 8);
        const rs = u32be(b, off + 12);
        if (n > MAX_RECORDS || ![16, 24, 32].includes(rs) || 16 + n * rs > len)
            return { ok: false };
        for (let i = 0; i < n; i++) {
            const r = off + 16 + i * rs;
            for (let k = 0; k < rs; k += 8) {
                const so = u32be(b, r + k);
                const sl = u32be(b, r + k + 4);
                if (so + sl > len)
                    return { ok: false };
                if (!sl)
                    continue;
                if (k < 16)
                    take(utf16(b, off + so, off + so + sl));
                else {
                    const inner = readTextTag(b, off + so, sl, 'mluc');
                    if (!inner.ok)
                        return { ok: false };
                    strings.push(...inner.strings);
                    if (inner.dirty)
                        dirty = true;
                }
            }
        }
        if (n)
            strings.push('(metadata entries)');
        return { ok: true, strings, dirty };
    }
    return { ok: false };
}
const align4 = (n) => (n + 3) & ~3;
function curveElement(b, p, end) {
    if (p + 12 > end)
        return null;
    const type = latin1(b, p, p + 4);
    if (type === 'curv') {
        const n = u32be(b, p + 8);
        const len = 12 + 2 * n;
        return p + len <= end ? { ranges: [[p, p + 4], [p + 8, p + len]], len } : null;
    }
    if (type === 'para') {
        const fn = u16be(b, p + 8);
        if (fn > 4)
            return null;
        const len = 12 + 4 * [1, 3, 4, 5, 7][fn];
        return p + len <= end ? { ranges: [[p, p + 4], [p + 8, p + 10], [p + 12, p + len]], len } : null;
    }
    return null;
}
function curveSet(b, tagOff, p, n, end, out) {
    for (let i = 0; i < n; i++) {
        const c = curveElement(b, p, end);
        if (!c)
            return false;
        out.push(...c.ranges);
        p = tagOff + align4(p - tagOff + c.len);
    }
    return true;
}
const s15 = (b, p) => (u32be(b, p) | 0) / 65536;
const numbersIn = (b, p, n, lo, hi) => { for (let i = 0; i < n; i++) {
    const v = s15(b, p + 4 * i);
    if (v < lo || v >= hi)
        return false;
} return true; };
const enumIn = (b, p, max) => u32be(b, p) <= max;
const HP_MEAS = [0x6d, 0x65, 0x61, 0x73, ...new Array(23).fill(0), 2, ...new Array(11).fill(0), 2];
function colourUsed(b, off, len, type, sig) {
    const end = off + len;
    const head = [off, off + 4];
    const fits = (n) => off + n <= end;
    switch (type) {
        case 'XYZ ': return fits(20) && (sig === 'lumi' ? numbersIn(b, off + 8, 3, 0, 32768) : numbersIn(b, off + 8, 3, -4, 4)) ? [head, [off + 8, off + 20]] : null;
        case 'sf32': return fits(44) && numbersIn(b, off + 8, 9, -4, 4) ? [head, [off + 8, off + 44]] : null;
        case 'meas':
            if (len === 40 && HP_MEAS.every((x, i) => b[off + i] === x))
                return [[off, off + 40]];
            return fits(36) && enumIn(b, off + 8, 2) && numbersIn(b, off + 12, 3, 0, 4) && enumIn(b, off + 24, 2) && enumIn(b, off + 28, 0x10000) && enumIn(b, off + 32, 8) ? [head, [off + 8, off + 36]] : null;
        case 'view': return fits(36) && numbersIn(b, off + 8, 6, 0, 1000) && enumIn(b, off + 32, 8) ? [head, [off + 8, off + 36]] : null;
        case 'curv':
        case 'para': {
            const c = curveElement(b, off, end);
            return c ? c.ranges : null;
        }
        case 'chrm': {
            if (!fits(12))
                return null;
            const ch = u16be(b, off + 8);
            return ch >= 1 && ch <= 15 && fits(12 + 8 * ch) ? [head, [off + 8, off + 12 + 8 * ch]] : null;
        }
        case 'cicp':
        case 'sig ': return fits(12) ? [head, [off + 8, off + 12]] : null;
        case 'clro': {
            if (!fits(12))
                return null;
            const n = u32be(b, off + 8);
            return n <= 15 && fits(12 + n) ? [head, [off + 8, off + 12 + n]] : null;
        }
        case 'mft1':
        case 'mft2': {
            if (!fits(52))
                return null;
            const inp = b[off + 8];
            const outp = b[off + 9];
            const g = b[off + 10];
            if (!inp || !outp || inp > 15 || outp > 15 || g < 2)
                return null;
            const clut = g ** inp * outp;
            const size = type === 'mft1'
                ? 48 + 256 * inp + clut + 256 * outp
                : 52 + 2 * (u16be(b, off + 48) * inp + clut + u16be(b, off + 50) * outp);
            return Number.isSafeInteger(size) && fits(size) ? [head, [off + 8, off + 11], [off + 12, off + size]] : null;
        }
        case 'mAB ':
        case 'mBA ': {
            if (!fits(32))
                return null;
            const inp = b[off + 8];
            const outp = b[off + 9];
            if (!inp || !outp || inp > 15 || outp > 15)
                return null;
            const ranges = [head, [off + 8, off + 10], [off + 12, off + 32]];
            const at = (k) => u32be(b, off + 12 + 4 * k);
            const [bOff, mtxOff, mOff, clutOff, aOff] = [0, 1, 2, 3, 4].map(at);
            const ab = type === 'mAB ';
            const sets = [[bOff, ab ? outp : inp], [mOff, ab ? outp : inp], [aOff, ab ? inp : outp]];
            for (const [o, n] of sets)
                if (o && (o >= len || !curveSet(b, off, off + o, n, end, ranges)))
                    return null;
            if (mtxOff) {
                if (!fits(mtxOff + 48))
                    return null;
                ranges.push([off + mtxOff, off + mtxOff + 48]);
            }
            if (clutOff) {
                if (!fits(clutOff + 20))
                    return null;
                const c = off + clutOff;
                const prec = b[c + 16];
                if (prec !== 1 && prec !== 2)
                    return null;
                let cells = 1;
                for (let i = 0; i < inp; i++)
                    cells *= b[c + i];
                const size = cells * outp * prec;
                if (!fits(clutOff + 20 + size))
                    return null;
                ranges.push([c, c + inp], [c + 16, c + 17], [c + 20, c + 20 + size]);
            }
            return ranges;
        }
        case 'mpet': {
            if (!fits(16))
                return null;
            const n = u32be(b, off + 12);
            if (n > 256 || !fits(16 + 8 * n))
                return null;
            const ranges = [head, [off + 8, off + 16 + 8 * n]];
            for (let i = 0; i < n; i++) {
                const eo = u32be(b, off + 16 + 8 * i);
                const es = u32be(b, off + 20 + 8 * i);
                if (eo < 16 + 8 * n || !fits(eo + es))
                    return null;
                ranges.push([off + eo, off + eo + es]);
            }
            return ranges;
        }
        default: return null;
    }
}
const CLASSES = new Set(['scnr', 'mntr', 'prtr', 'link', 'spac', 'abst']);
const SPACES = new Set(['XYZ ', 'Lab ', 'Luv ', 'YCbr', 'Yxy ', 'RGB ', 'GRAY', 'HSV ', 'HLS ', 'CMYK', 'CMY ',
    ...'23456789ABCDEF'.split('').map((c) => `${c}CLR`)]);
const CMMS = new Set(['ADBE', 'ACMS', 'appl', 'CCMS', 'UCCM', 'UCMS', 'EFI ', 'FF  ', 'EXAC', 'HCMM', 'argl', 'LgoS', 'HDM ',
    'lcms', 'RIMX', 'DIDO', 'KCMS', 'MCML', 'WCS ', 'SIGN', 'ONYX', 'RGMS', 'SICC', 'TCMM', '32BT', 'vivo', 'WTG ', 'zc00',
    'Lino', 'MSFT', 'KODA', 'none', 'HP  ', 'GOOG', 'Skia']);
const VENDORS = new Set(['APPL', 'appl', 'ADBE', 'MSFT', 'KODA', 'GOOG', 'HP  ', 'IEC ', 'none', 'lcms', 'argl', 'CANO',
    'EPSO', 'NIKO', 'NKON', 'SONY', 'FUJI', 'OLYM', 'RICO', 'XRIT', 'Skia', 'LINO', 'Lino', 'SAMS', 'DELL']);
const MODELS = new Set(['sRGB']);
const PLATFORMS = new Set(['APPL', 'MSFT', 'SGI ', 'SUNW', 'TGNT', '*nix']);
const D50 = [0xf6d6, 0x10000, 0xd32d];
function headerFree(b) {
    const out = [];
    const sig = (p) => latin1(b, p, p + 4);
    const zero = (p, n) => allZero(b, p, p + n);
    const listed = (p, set) => zero(p, 4) || set.has(sig(p));
    const clear = (p, n) => (o) => o.fill(0, p, p + n);
    if (!listed(4, CMMS))
        out.push({ field: 'CMM', fix: clear(4, 4) });
    if (!zero(10, 2))
        out.push({ field: 'version', fix: clear(10, 2) });
    const d = [0, 1, 2, 3, 4, 5].map((i) => u16be(b, 24 + 2 * i));
    const dateOk = d.every((x) => !x) || (d[0] >= 1980 && d[0] <= 2099 && d[1] >= 1 && d[1] <= 12 && d[2] >= 1 && d[2] <= 31 && d[3] <= 23 && d[4] <= 59 && d[5] <= 59);
    if (!dateOk)
        out.push({ field: 'date', fix: clear(24, 12) });
    if (!listed(40, PLATFORMS))
        out.push({ field: 'platform', fix: clear(40, 4) });
    if (!zero(44, 3) || b[47] & 0xfc)
        out.push({ field: 'flags', fix: (o) => { o.fill(0, 44, 47); o[47] &= 3; } });
    if (!listed(48, VENDORS))
        out.push({ field: 'device maker', fix: clear(48, 4) });
    if (!listed(52, MODELS))
        out.push({ field: 'device model', fix: clear(52, 4) });
    const attrs = latin1(b, 56, 63);
    if ((attrs !== '\0\0\0\0\0\0\0' && attrs !== '\0\0\0\x01\0\0\0') || b[63] & 0xf0)
        out.push({ field: 'attributes', fix: (o) => { o.fill(0, 56, 63); o[63] &= 0x0f; } });
    if (!zero(64, 3) || b[67] > 3)
        out.push({ field: 'rendering intent', fix: clear(64, 4) });
    if (!D50.every((v, i) => Math.abs(u32be(b, 68 + 4 * i) - v) <= 16)) {
        out.push({ field: 'illuminant', fix: (o) => D50.forEach((v, i) => w32(o, 68 + 4 * i, v)) });
    }
    if (!listed(80, VENDORS))
        out.push({ field: 'creator', fix: clear(80, 4) });
    return out;
}
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
export function md5(data) {
    const n = data.length;
    const total = ((n + 8) >> 6) * 64 + 64;
    const m = new Uint8Array(total);
    m.set(data);
    m[n] = 0x80;
    const bits = n * 8;
    for (let i = 0; i < 8; i++)
        m[total - 8 + i] = Math.floor(bits / 2 ** (8 * i)) & 255;
    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    const w = new Uint32Array(16);
    for (let o = 0; o < total; o += 64) {
        for (let i = 0; i < 16; i++)
            w[i] = m[o + i * 4] | (m[o + i * 4 + 1] << 8) | (m[o + i * 4 + 2] << 16) | (m[o + i * 4 + 3] << 24);
        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;
        for (let i = 0; i < 64; i++) {
            let f;
            let g;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            }
            else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            }
            else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            }
            else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }
            const s = MD5_S[(i >> 4) * 4 + (i % 4)];
            const t = (a + f + MD5_K[i] + w[g]) >>> 0;
            a = d;
            d = c;
            c = b;
            b = (b + ((t << s) | (t >>> (32 - s)))) >>> 0;
        }
        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }
    const out = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((v, i) => { for (let k = 0; k < 4; k++)
        out[i * 4 + k] = (v >>> (8 * k)) & 255; });
    return out;
}
function profileId(b, size) {
    const c = b.slice(0, size);
    c.fill(0, 44, 48);
    c.fill(0, 64, 68);
    c.fill(0, 84, 100);
    return md5(c);
}
export function inspectIcc(b) {
    const bad = { ok: false };
    if (!b || b.length < 132 || !startsWith(b, 36, 'acsp'))
        return bad;
    if (!CLASSES.has(latin1(b, 12, 16)) || !SPACES.has(latin1(b, 16, 20)) || !SPACES.has(latin1(b, 20, 24)))
        return bad;
    if (![2, 4, 5].includes(b[8]))
        return bad;
    let size = u32be(b, 0);
    if (size < 132)
        return bad;
    const count = u32be(b, 128);
    if (count > MAX_TAGS || 132 + count * 12 > Math.min(size, b.length))
        return bad;
    const tableEnd = 132 + count * 12;
    let sizeFix = false;
    if (size > b.length) {
        sizeFix = true;
        size = b.length;
    }
    const tags = [];
    for (let i = 0; i < count; i++) {
        const e = 132 + i * 12;
        const sig = latin1(b, e, e + 4);
        const off = u32be(b, e + 4);
        const len = u32be(b, e + 8);
        if (off < tableEnd || len < 8 || off + len > size)
            return bad;
        const type = latin1(b, off, off + 4);
        let kind = 'strip';
        if (TEXT_TYPES.has(type))
            kind = 'text';
        else if (TAG_TYPES[sig] && TAG_TYPES[sig].includes(type)) {
            kind = 'keep';
            if (type === 'sig ' && !SIG_VALUES[sig].includes(latin1(b, off + 8, off + 12)))
                kind = 'strip';
        }
        tags.push({ index: i, sig, off, len, type, kind });
    }
    const byOff = [...tags].sort((x, y) => x.off - y.off || x.len - y.len);
    for (let i = 0; i < byOff.length; i++) {
        const t = byOff[i];
        for (let j = i + 1; j < byOff.length && byOff[j].off < t.off + t.len; j++) {
            const u = byOff[j];
            const same = u.off === t.off && u.len === t.len;
            if (same && (t.kind === 'text') === (u.kind === 'text'))
                continue;
            if (same && t.kind !== 'text' && u.kind !== 'text')
                continue;
            if (t.kind !== 'keep' || u.kind !== 'keep')
                return bad;
        }
    }
    const used = new Map();
    for (const t of tags) {
        if (t.kind !== 'keep')
            continue;
        const key = `${t.off}:${t.len}`;
        const k2 = `${key}:${t.sig === 'lumi'}`;
        if (!used.has(k2))
            used.set(k2, colourUsed(b, t.off, t.len, t.type, t.sig));
        t.used = used.get(k2);
        if (t.used)
            continue;
        if (t.sig !== 'meas' && t.sig !== 'view')
            return bad;
        t.kind = 'strip';
    }
    const free = [];
    const extra = [];
    const seen = new Map();
    for (const t of tags) {
        if (t.kind !== 'text')
            continue;
        const key = `${t.off}:${t.len}`;
        let r = seen.get(key);
        if (!r) {
            r = readTextTag(b, t.off, t.len, t.type);
            if (!r.ok)
                r = { ok: true, strings: [], dirty: true, unreadable: true };
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
    const whole = maskOf(b.length, [[0, tableEnd], ...tags.map((t) => [t.off, t.off + t.len])]);
    const kept = maskOf(b.length, tags.filter((t) => t.kind === 'keep').map((t) => [t.off, t.off + t.len]));
    const live = maskOf(b.length, liveOf(tags));
    let gaps = false;
    let inside = false;
    for (let i = 128; i < b.length; i++) {
        if (!b[i])
            continue;
        if (!whole[i] || i >= size)
            gaps = true;
        else if (kept[i] && !live[i])
            inside = true;
    }
    if (gaps)
        extra.push('bytes no tag uses');
    if (inside)
        extra.push('bytes inside colour tags that colour engines ignore');
    const head = headerFree(b);
    if (head.length)
        extra.push(`header fields (${head.map((h) => h.field).join(', ')})`);
    if (sizeFix)
        extra.push('a size larger than the profile');
    if (!allZero(b, 100, 128))
        extra.push('reserved header bytes');
    const id = b.subarray(84, 100);
    const idSet = !allZero(b, 84, 100);
    const idOk = idSet && !sizeFix && profileId(b, size).every((x, i) => x === id[i]);
    if (idSet && !idOk && !sizeFix)
        extra.push('a profile ID that is not its checksum');
    return { ok: true, size, count, tags, free, extra, head, sizeFix, idSet, idOk, clean: !free.length && !extra.length };
}
function liveOf(tags) {
    const live = [];
    for (const t of tags) {
        if (t.kind === 'keep')
            live.push(...t.used);
        else if (t.kind === 'text')
            live.push([t.off, t.off + t.len]);
    }
    return live;
}
function maskOf(n, ranges) {
    const m = new Uint8Array(n);
    for (const [s, e] of ranges)
        m.fill(1, Math.max(0, s), Math.min(n, e));
    return m;
}
const NEUTRAL_DESC = 'ICC profile';
function writeAscii(out, p, s) { for (let i = 0; i < s.length; i++)
    out[p + i] = s.charCodeAt(i); }
function w32(out, p, v) { out[p] = v >>> 24; out[p + 1] = (v >>> 16) & 255; out[p + 2] = (v >>> 8) & 255; out[p + 3] = v & 255; }
function neutralTag(out, t) {
    const { off, len, type } = t;
    out.fill(0, off + 4, off + len);
    const text = t.sig === 'desc' ? NEUTRAL_DESC : '';
    if (type === 'desc') {
        const s = len >= 91 + text.length + 1 ? text : '';
        if (len >= 13) {
            w32(out, off + 8, s.length + 1);
            writeAscii(out, off + 12, s);
        }
        return;
    }
    if (type === 'mluc') {
        const s = len >= 28 + 2 * text.length ? text : '';
        if (len >= 28 && s) {
            w32(out, off + 8, 1);
            w32(out, off + 12, 12);
            writeAscii(out, off + 16, 'enUS');
            w32(out, off + 20, 2 * s.length);
            w32(out, off + 24, 28);
            for (let i = 0; i < s.length; i++) {
                out[off + 28 + 2 * i] = 0;
                out[off + 29 + 2 * i] = s.charCodeAt(i);
            }
        }
        else if (len >= 16)
            w32(out, off + 12, 12);
        return;
    }
    if (type === 'dict') {
        if (len >= 16)
            w32(out, off + 12, 16);
        return;
    }
    if (type === 'text' || type === 'utf8' || type === 'zut8') {
        if (len >= 9 + text.length)
            writeAscii(out, off + 8, text);
        return;
    }
    if (type === 'ut16') {
        if (len >= 10 + 2 * text.length)
            for (let i = 0; i < text.length; i++)
                out[off + 9 + 2 * i] = text.charCodeAt(i);
    }
}
export function cleanIcc(b) {
    const info = inspectIcc(b);
    if (!info.ok)
        return null;
    if (info.clean)
        return b.slice();
    const out = b.slice();
    const { size, tags } = info;
    const keep = tags.filter((t) => t.kind !== 'strip');
    const done = new Set();
    for (const t of tags) {
        if (t.kind !== 'text' || t.allowed)
            continue;
        const key = `${t.off}:${t.len}`;
        if (done.has(key))
            continue;
        done.add(key);
        neutralTag(out, t);
    }
    out.fill(0, 132, 132 + info.count * 12);
    w32(out, 128, keep.length);
    keep.forEach((t, i) => {
        const e = 132 + i * 12;
        writeAscii(out, e, t.sig);
        w32(out, e + 4, t.off);
        w32(out, e + 8, t.len);
    });
    const live = [[0, 132 + keep.length * 12], ...liveOf(keep)].sort((x, y) => x[0] - y[0]);
    let p = 128;
    for (const [s, e] of live) {
        if (s > p)
            out.fill(0, p, s);
        p = Math.max(p, e);
    }
    if (p < out.length)
        out.fill(0, p, out.length);
    for (const h of info.head)
        h.fix(out);
    if (info.sizeFix)
        w32(out, 0, size);
    out.fill(0, 100, 128);
    if (info.idSet && info.idOk)
        out.set(profileId(out, size), 84);
    else
        out.fill(0, 84, 100);
    const again = inspectIcc(out);
    if (!again.ok || !again.clean)
        return null;
    for (const t of keep) {
        if (t.kind !== 'keep')
            continue;
        for (const [s, e] of t.used)
            for (let i = s; i < e; i++)
                if (out[i] !== b[i])
                    return null;
    }
    return out;
}
export function iccDescription(b) {
    const info = inspectIcc(b);
    if (!info.ok)
        return 'Colour profile';
    const desc = info.tags.find((t) => t.sig === 'desc' && t.kind === 'text');
    const name = desc ? (desc.strings.map(norm).find((x) => x && iccTextAllowed(x)) || '') : '';
    return clip(name) || 'Colour profile';
}
export function iccFreeText(info) {
    const order = (t) => (t.sig === 'desc' ? 0 : t.sig === 'cprt' ? 1 : 2);
    const parts = [...info.free].sort((x, y) => order(x) - order(y)).map((f) => `${labelOf(f.sig)}: ${f.text}`);
    return clip([...parts, ...info.extra].join('; '));
}
export const ICC_TEXT_ITEM = {
    id: 'icc:text', group: 'hidden', tier: 'red', label: 'Text inside the colour profile', source: 'ICC profile',
    note: 'Text in the colour profile that is not a known profile name or copyright line, or data no colour engine reads. It can hold names or notes. Removing it rewrites only that text, so the colours stay the same.',
};
export const ICC_UNREADABLE_ITEM = {
    id: 'icc:unreadable', group: 'hidden', tier: 'red', label: 'Colour profile that could not be read', source: 'ICC profile',
    note: 'It may hold anything, so removing it is the safe choice. Colours may look slightly different without it.',
};
