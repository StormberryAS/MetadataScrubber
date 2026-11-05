/*! src/core/iptc.js is compiled from ts/src/core/iptc.ts by tools/build-ts.sh, which leaves out
    every comment but this one: the explanations are in the source. Edit the TypeScript, never the
    .js: the build refuses to overwrite a hand edit, and its check mode fails on one. */

// IPTC-IIM datasets and the Photoshop image resource block (IRB) that usually carries them.
//
// JPEG keeps both in APP13 ("Photoshop 3.0"); PNG keeps them in "Raw profile type iptc" or
// "Raw profile type 8bim" text. Since 0.0.3 a block that stays is always written again in
// one canonical form (canonicalIrb, rebuildIptc), even when nothing in it goes: dates and
// software (amber, kept by default) are the only free-form parts left, and those are
// checked. Resource names, padding, the character set marker, record versions and the
// digest of the old IPTC data cannot carry anything along.

import { clip, concat, encodeLatin1, formatBytes, latin1, startsWith, u16be, u32be, w32be } from './bytes.js';
import type { Range } from './bytes.js';
import { md5 } from './icc.js';
import type { Tier } from './taxonomy.js';
import { deviceNameOk } from './tiff.js';

/** One IPTC dataset: record and number, and where it and its data lie. */
export type IptcDataset = { rec: number; ds: number; id: string; start: number; end: number; dataStart: number; dataEnd: number };
/** Parsed IPTC data: the bytes, the datasets and the unreadable ranges between them. */
export type ParsedIptc = { b: Uint8Array; sets: IptcDataset[]; junk: Range[] };
export type IptcItemDef = { group: string; tier: Tier; label: string; note?: string };
/** One IPTC detail as iptcItems lists it; key is a key of IPTC_ITEMS. */
export type IptcItem = IptcItemDef & { key: string; value: string };
/** One Photoshop image resource. */
export type IrbResource = { id: number; start: number; end: number; dataStart: number; dataEnd: number };
/** A parsed Photoshop image resource block; rest is where the resources stop. */
export type ParsedIrb = { b: Uint8Array; res: IrbResource[]; rest: number };

// ======================================================================================
// IPTC-IIM

export const IPTC_ITEMS: Record<'place' | 'byline' | 'contact' | 'credit' | 'copyright' | 'dates' | 'software' | 'caption' | 'keywords' | 'instructions' | 'other' | 'unreadable', IptcItemDef> = {
  place: { group: 'where', tier: 'red', label: 'Place names' },
  byline: { group: 'who', tier: 'red', label: 'Author name' },
  contact: { group: 'who', tier: 'red', label: 'Contact details' },
  credit: { group: 'who', tier: 'red', label: 'Credit line', note: 'Usually contains a name.' },
  copyright: { group: 'who', tier: 'red', label: 'Copyright notice', note: "Usually contains the photographer's name." },
  dates: { group: 'when', tier: 'amber', label: 'Date and time created' },
  software: { group: 'device', tier: 'amber', label: 'Software used' },
  // Free text can name people, so it is red (0.0.3); dates and software stay amber.
  caption: { group: 'hidden', tier: 'red', label: 'Caption and headline', note: 'Free text written by a person or an app. It can hold names, places or notes.' },
  keywords: { group: 'hidden', tier: 'red', label: 'Keywords', note: 'Free text written by a person or an app. It can hold names, places or notes.' },
  instructions: { group: 'hidden', tier: 'red', label: 'Special instructions', note: 'Free text written by a person or an app. It can hold names, places or notes.' },
  other: { group: 'hidden', tier: 'red', label: 'Other IPTC data', note: 'Other IPTC fields, such as a title, categories or a reference. They are mostly free text, which can hold names, places or notes.' },
  unreadable: { group: 'hidden', tier: 'red', label: 'IPTC data that could not be read', note: 'Bytes between the IPTC fields that no reader uses. They may hold anything.' },
};

const DATASET_KEY: Record<string, string> = {
  '2:80': 'byline', '2:85': 'byline', '2:122': 'byline',
  '2:118': 'contact',
  '2:110': 'credit', '2:115': 'credit',
  '2:116': 'copyright',
  '2:90': 'place', '2:92': 'place', '2:95': 'place', '2:100': 'place', '2:101': 'place', '2:26': 'place',
  '2:55': 'dates', '2:60': 'dates', '2:62': 'dates', '2:63': 'dates', '2:30': 'dates', '2:35': 'dates',
  '2:65': 'software', '2:70': 'software',
  '2:120': 'caption', '2:105': 'caption', '2:5': 'caption',
  '2:25': 'keywords',
  '2:40': 'instructions',
};
// Structural datasets: kept while anything else is kept, dropped with the last item.
const STRUCTURAL = new Set(['2:0', '1:0', '1:90']);

// Reads IPTC datasets. Bytes that are not part of a dataset (padding apart) are kept in
// `junk`, and reading resumes at the next byte that starts a plausible dataset, so a stray
// byte cannot hide the fields after it.
export function parseIptc(b: Uint8Array): ParsedIptc {
  const sets: IptcDataset[] = [];
  const junk: Range[] = [];
  let p = 0;
  const plausible = (q: number) => q + 5 <= b.length && b[q] === 0x1c && b[q + 1] >= 1 && b[q + 1] <= 9;
  while (p + 5 <= b.length) {
    if (b[p] !== 0x1c) {
      if (b[p] === 0) { p++; continue; }
      let q = p + 1;
      while (q < b.length && !plausible(q)) q++;
      junk.push([p, q]);
      p = q;
      continue;
    }
    const rec = b[p + 1];
    const ds = b[p + 2];
    let len = u16be(b, p + 3);
    let data = p + 5;
    if (len & 0x8000) {
      const n = len & 0x7fff;
      if (n > 4 || data + n > b.length) { junk.push([p, b.length]); p = b.length; break; }
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + b[data + i];
      data += n;
    }
    if (data + len > b.length) { junk.push([p, b.length]); p = b.length; break; }
    sets.push({ rec, ds, id: `${rec}:${ds}`, start: p, end: data + len, dataStart: data, dataEnd: data + len });
    p = data + len;
  }
  if (p < b.length && b.subarray(p).some((x) => x)) junk.push([p, b.length]);
  return { b, sets, junk };
}

const textOf: (b: Uint8Array, s: IptcDataset) => string = (b, s) => {
  const raw = b.subarray(s.dataStart, s.dataEnd);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw).trim(); } catch { return latin1(raw).trim(); }
};

// The form each date and software dataset must have to stay amber (IPTC-IIM 4.2): dates as
// CCYYMMDD, times as HHMMSS with an optional zone, the program's name as one short line of
// printable text and its version as a short one. A dataset that fails goes with the other
// IPTC fields, which are red.
const DATE_FORM = /^\d{8}$/;
const TIME_FORM = /^\d{6}(?:[+-]\d{4})?$/;
const AMBER_FORM: Record<string, RegExp> = {
  '2:55': DATE_FORM, '2:62': DATE_FORM, '2:30': DATE_FORM,
  '2:60': TIME_FORM, '2:63': TIME_FORM, '2:35': TIME_FORM,
};
function amberOk(b: Uint8Array, s: IptcDataset): boolean {
  const raw = b.subarray(s.dataStart, s.dataEnd);
  let v;
  try { v = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return false; }
  if (AMBER_FORM[s.id]) return AMBER_FORM[s.id].test(v);
  if (s.id === '2:65') return raw.length <= 32 && deviceNameOk(v);
  if (s.id === '2:70') return raw.length <= 10 && deviceNameOk(v);
  return false;
}

const datasetKey: (s: IptcDataset, b?: Uint8Array) => string | null = (s, b) => {
  if (STRUCTURAL.has(s.id)) return null;
  const k = DATASET_KEY[s.id] || 'other';
  return (k === 'dates' || k === 'software') && b && !amberOk(b, s) ? 'other' : k;
};

export function iptcItems(parsed: ParsedIptc): IptcItem[] {
  const buckets: Map<string, IptcDataset[]> = new Map();
  for (const s of parsed.sets) {
    const k = datasetKey(s, parsed.b);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    (buckets.get(k) as IptcDataset[]).push(s);
  }
  const junkBytes = (parsed.junk || []).reduce((n, [a, c]) => n + c - a, 0);
  if (junkBytes) buckets.set('unreadable', []);
  const items: IptcItem[] = [];
  for (const [key, def] of Object.entries(IPTC_ITEMS)) {
    const list = buckets.get(key);
    if (!list) continue;
    let value;
    if (key === 'unreadable') value = formatBytes(junkBytes);
    else if (key === 'other') value = `${list.length} field${list.length === 1 ? '' : 's'}`;
    else if (key === 'dates') {
      const d = list.find((s) => s.id === '2:55');
      const t = list.find((s) => s.id === '2:60');
      const ds = d ? textOf(parsed.b, d).replace(/^(\d{4})(\d\d)(\d\d)$/, '$1-$2-$3') : '';
      const ts = t ? textOf(parsed.b, t).replace(/^(\d\d)(\d\d)(\d\d)/, '$1:$2:$3') : '';
      value = clip([ds, ts].filter(Boolean).join(' ') || `${list.length} date fields`);
    } else value = clip([...new Set(list.map((s) => textOf(parsed.b, s)).filter(Boolean))].join(', '));
    items.push({ key, ...def, value });
  }
  return items;
}

// Rebuilds the IPTC data from the kept datasets only, in the canonical form: datasets in
// record and number order (repeats keep their order), each with the shortest length field,
// the record versions (1:0, 2:0) written as version 4, and the character set (1:90) kept
// only as the one marker for UTF-8. Unreadable bytes never survive. Returns null when
// nothing meaningful is left.
const UTF8_MARK = [0x1b, 0x25, 0x47];
function dataset(rec: number, ds: number, data: Uint8Array): Uint8Array {
  const n = data.length;
  const head = n < 0x8000 ? [0x1c, rec, ds, n >> 8, n & 255] : [0x1c, rec, ds, 0x80, 4, n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return concat([new Uint8Array(head), data]);
}
/** @param removeKeys keys of IPTC_ITEMS whose datasets go */
export function rebuildIptc(parsed: ParsedIptc, removeKeys: Set<string> = new Set()): Uint8Array | null {
  const b = parsed.b;
  const kept = parsed.sets.filter((s) => { const k = datasetKey(s, b); return k && !removeKeys.has(k); });
  if (!kept.length) return null;
  const recs = new Set(kept.map((s) => s.rec));
  const utf8 = parsed.sets.some((s) => s.id === '1:90' && s.dataEnd - s.dataStart === 3 && UTF8_MARK.every((x, i) => b[s.dataStart + i] === x));
  const out: Uint8Array[] = [];
  if (recs.has(1) || utf8) out.push(dataset(1, 0, new Uint8Array([0, 4])));
  if (utf8) out.push(dataset(1, 90, new Uint8Array(UTF8_MARK)));
  const sorted = kept.map((s, i) => ({ s, i })).sort((x, y) => x.s.rec - y.s.rec || x.s.ds - y.s.ds || x.i - y.i).map((x) => x.s);
  let rec2 = false;
  for (const s of sorted) {
    if (s.rec === 2 && !rec2) { out.push(dataset(2, 0, new Uint8Array([0, 4]))); rec2 = true; }
    out.push(dataset(s.rec, s.ds, b.subarray(s.dataStart, s.dataEnd)));
  }
  return concat(out);
}

// ======================================================================================
// Photoshop image resource block

export function parseIrb(b: Uint8Array): ParsedIrb {
  const res: IrbResource[] = [];
  let p = 0;
  while (p + 12 <= b.length && (startsWith(b, p, '8BIM') || startsWith(b, p, 'MeSa') || startsWith(b, p, 'PHUT') || startsWith(b, p, 'AgHg') || startsWith(b, p, 'DCSR'))) {
    const id = u16be(b, p + 4);
    const nameLen = b[p + 6];
    let q = p + 7 + nameLen;
    if ((nameLen + 1) & 1) q++;
    if (q + 4 > b.length) break;
    const size = u32be(b, q);
    const data = q + 4;
    if (data + size > b.length) break;
    const end = Math.min(b.length, data + size + (size & 1));
    res.push({ id, start: p, end, dataStart: data, dataEnd: data + size });
    p = end;
  }
  return { b, res, rest: p };
}

export const IRB_IPTC = 0x0404;
export const IRB_IPTC_DIGEST = 0x0425;
export const IRB_THUMBS = new Set([0x0409, 0x040c]);
export const IRB_XMP = 0x0424;
export const IRB_EXIF = new Set([0x0422, 0x0423]);

// Photoshop resources other than IPTC, previews and copies of EXIF or XMP. Several hold
// free text (a caption, a web address, slice, layer and channel names), so they are red.
export const IRB_OTHER_NOTE = 'Photoshop settings that can include a caption, a web address or names given to layers and channels. They can hold names or notes.';

export function irbOtherValue(list: IrbResource[]): string {
  const total = list.reduce((s, r) => s + (r.dataEnd - r.dataStart), 0);
  return `${list.length} block${list.length === 1 ? '' : 's'}, ${formatBytes(total)}`;
}

// One resource in the canonical form: its signature, its number, an empty name, its
// length and its data, padded with a zero to an even length.
function resource(sig: string, id: number, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(12);
  head.set(encodeLatin1(sig));
  head[4] = id >> 8; head[5] = id & 255;
  w32be(head, 8, data.length);
  return concat([head, data, new Uint8Array(data.length & 1)]);
}

// The block written again in the canonical form from the kept resources (see the top of
// this file): parts are the kinds of resource that go ('thumbs', 'embedded', 'other'),
// removeIptc the IPTC detail keys that go. The IPTC resource is written as the canonical
// IPTC data and, when the block had one, followed by the digest Photoshop keeps of that
// data, computed again. Any further IPTC or digest resource and anything after the last
// resource never stay. Returns the new block (empty when nothing is left).
/**
 * @param iptc the parsed data of iptcRes
 * @param iptcRes the IPTC resource that is kept
 */
export function canonicalIrb(irb: ParsedIrb, iptc: ParsedIptc | null | undefined, iptcRes: IrbResource | null | undefined, { parts = new Set(), removeIptc = new Set() }: { parts?: Set<string>; removeIptc?: Set<string> } = {}): Uint8Array {
  const b = irb.b;
  const newIptc = iptc && iptcRes ? rebuildIptc(iptc, removeIptc) : null;
  const hadDigest = irb.res.some((r) => r.id === IRB_IPTC_DIGEST);
  const out: Uint8Array[] = [];
  for (const r of irb.res) {
    if (r.id === IRB_IPTC) {
      if (r !== iptcRes || !newIptc) continue;
      out.push(resource('8BIM', IRB_IPTC, newIptc));
      if (hadDigest) out.push(resource('8BIM', IRB_IPTC_DIGEST, md5(newIptc)));
      continue;
    }
    if (r.id === IRB_IPTC_DIGEST) continue;
    if (IRB_THUMBS.has(r.id) ? parts.has('thumbs') : r.id === IRB_XMP || IRB_EXIF.has(r.id) ? parts.has('embedded') : parts.has('other')) continue;
    out.push(resource(latin1(b, r.start, r.start + 4), r.id, b.subarray(r.dataStart, r.dataEnd)));
  }
  return concat(out);
}
