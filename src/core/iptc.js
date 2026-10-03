// IPTC-IIM datasets and the Photoshop image resource block (IRB) that usually carries them.
//
// JPEG keeps both in APP13 ("Photoshop 3.0"); PNG keeps them in "Raw profile type iptc" or
// "Raw profile type 8bim" text. Removal rebuilds the block from the kept parts only.

import { clip, concat, formatBytes, latin1, startsWith, u16be, u32be, w32be } from './bytes.js?v=b373c219';

// ======================================================================================
// IPTC-IIM

export const IPTC_ITEMS = {
  place: { group: 'where', tier: 'red', label: 'Place names' },
  byline: { group: 'who', tier: 'red', label: 'Author name' },
  contact: { group: 'who', tier: 'red', label: 'Contact details' },
  credit: { group: 'who', tier: 'red', label: 'Credit line', note: 'Usually contains a name.' },
  copyright: { group: 'who', tier: 'red', label: 'Copyright notice', note: "Usually contains the photographer's name." },
  dates: { group: 'when', tier: 'amber', label: 'Date and time created' },
  software: { group: 'device', tier: 'amber', label: 'Software used' },
  caption: { group: 'hidden', tier: 'amber', label: 'Caption and headline' },
  keywords: { group: 'hidden', tier: 'amber', label: 'Keywords' },
  instructions: { group: 'hidden', tier: 'amber', label: 'Special instructions' },
  other: { group: 'hidden', tier: 'amber', label: 'Other IPTC data' },
  unreadable: { group: 'hidden', tier: 'red', label: 'IPTC data that could not be read', note: 'Bytes between the IPTC fields that no reader uses. They may hold anything.' },
};

const DATASET_KEY = {
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
export function parseIptc(b) {
  const sets = [];
  const junk = [];
  let p = 0;
  const plausible = (q) => q + 5 <= b.length && b[q] === 0x1c && b[q + 1] >= 1 && b[q + 1] <= 9;
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

const textOf = (b, s) => {
  const raw = b.subarray(s.dataStart, s.dataEnd);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw).trim(); } catch { return latin1(raw).trim(); }
};

const datasetKey = (s) => (STRUCTURAL.has(s.id) ? null : DATASET_KEY[s.id] || 'other');

export function iptcItems(parsed) {
  const buckets = new Map();
  for (const s of parsed.sets) {
    const k = datasetKey(s);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(s);
  }
  const junkBytes = (parsed.junk || []).reduce((n, [a, c]) => n + c - a, 0);
  if (junkBytes) buckets.set('unreadable', []);
  const items = [];
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

// Rebuilds the IPTC data from the kept datasets only (unreadable bytes never survive a
// rebuild). Returns null when nothing meaningful is left.
export function rebuildIptc(parsed, removeKeys) {
  const kept = parsed.sets.filter((s) => { const k = datasetKey(s); return k ? !removeKeys.has(k) : true; });
  if (!kept.some((s) => datasetKey(s))) return null;
  return concat(kept.map((s) => parsed.b.subarray(s.start, s.end)));
}

// ======================================================================================
// Photoshop image resource block

export function parseIrb(b) {
  const res = [];
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

export function irbOtherValue(list) {
  const total = list.reduce((s, r) => s + (r.dataEnd - r.dataStart), 0);
  return `${list.length} block${list.length === 1 ? '' : 's'}, ${formatBytes(total)}`;
}

// Rebuilds the block from kept resources; `replace` maps resource objects to new data.
export function rebuildIrb(parsed, keep, replace = new Map()) {
  const parts = [];
  for (const r of parsed.res) {
    if (!keep(r)) continue;
    const data = replace.get(r);
    if (!data) { parts.push(parsed.b.subarray(r.start, r.end)); continue; }
    const head = parsed.b.slice(r.start, r.dataStart);
    w32be(head, head.length - 4, data.length);
    parts.push(head, data);
    if (data.length & 1) parts.push(new Uint8Array(1));
  }
  return concat(parts);
}

