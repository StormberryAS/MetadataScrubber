// Groups, tiers and the item bookkeeping every format module shares.

export const GROUPS = [
  { id: 'where', label: 'Where', description: 'Where the picture was taken: GPS position, altitude, direction and place names.' },
  { id: 'who', label: 'Who', description: 'Who took or owns it: names, contact details, copyright, camera and lens serial numbers, and the name of the computer that saved it.' },
  { id: 'when', label: 'When', description: 'When it was taken or changed: dates, times and time zone.' },
  { id: 'device', label: 'Device', description: 'What made it: camera make and model, lens, and editing software.' },
  { id: 'hidden', label: 'Hidden extras', description: 'Things you cannot see in the picture: a built-in preview, edit history, comments, unique IDs, extra images or video, and Content Credentials.' },
  { id: 'technical', label: 'Technical', description: 'Settings that help the picture display correctly: rotation, colour profile, size and exposure.' },
];

export const TIERS = {
  red: { label: 'Remove before sharing', description: 'Can identify you, your camera or the place. Removed by default.' },
  amber: { label: 'Think about it', description: 'Can reveal routines, devices or history. Removed by default.' },
  green: { label: 'Harmless and useful', description: 'Helps the picture display correctly. Kept by default.' },
};

export const SOURCES = {
  exif: 'EXIF',
  xmp: 'XMP',
  iptc: 'IPTC',
  png: 'PNG text',
  icc: 'ICC profile',
  c2pa: 'C2PA',
  after: 'After the image',
};

export const TIER_ORDER = { red: 0, amber: 1, green: 2 };

// The strictest of several tiers: red beats amber beats green.
export function strictest(tiers) {
  let best = null;
  for (const t of tiers) if (t && (best === null || TIER_ORDER[t] < TIER_ORDER[best])) best = t;
  return best;
}

// Shared wording for data a format module cannot read or place.
export const UNREADABLE = {
  damaged: {
    group: 'hidden', tier: 'red', label: 'Damaged data at the end of the file',
    note: 'The file stops in the middle of a part, so this part cannot be read. It may hold anything, so removing it is the safe choice.',
  },
  unknown: {
    group: 'hidden', tier: 'red', label: 'Unidentified extra data from the device or software',
  },
};

const MAX_WARNINGS = 40;

// Collects items for one file and keeps each item's private removal data out of the
// public object. Ids stay stable because files are always walked in the same order;
// a repeated id (two EXIF blocks, say) gets a numeric suffix.
//
// Every operation is constant time, so a crafted file with thousands of parts cannot
// make the page freeze.
export class ItemSet {
  constructor() {
    this.items = [];
    this.internal = new Map();
    this.byId = new Map();
    this.nextSuffix = new Map();
    this.warnings = [];
    this.warningSet = new Set();
    this.extraWarnings = 0;
  }

  add(item, internal = {}) {
    let id = item.id;
    if (this.internal.has(id)) {
      let n = this.nextSuffix.get(item.id) || 2;
      while (this.internal.has(`${item.id}:${n}`)) n++;
      id = `${item.id}:${n}`;
      this.nextSuffix.set(item.id, n + 1);
    }
    const pub = {
      id,
      group: item.group,
      tier: item.tier,
      label: item.label,
      value: item.value === undefined || item.value === null ? '' : String(item.value),
      source: item.source,
    };
    if (item.note) pub.note = item.note;
    this.items.push(pub);
    this.internal.set(id, internal);
    this.byId.set(id, pub);
    return id;
  }

  has(id) { return this.internal.has(id); }
  get(id) { return this.internal.get(id); }
  item(id) { return this.byId.get(id); }

  warn(text) {
    if (this.warningSet.has(text)) return;
    if (this.warnings.length >= MAX_WARNINGS) {
      this.extraWarnings++;
      const last = `There were ${this.extraWarnings} more problems with this file.`;
      if (this.warnings.length === MAX_WARNINGS) this.warnings.push(last);
      else this.warnings[MAX_WARNINGS] = last;
      return;
    }
    this.warningSet.add(text);
    this.warnings.push(text);
  }
}

// Keeps the number of separate items for unidentified parts manageable: up to `limit`
// distinct ids, then everything else is folded into one item. Returns the id to use.
export function cappedId(seen, id, overflowId, limit = 24) {
  if (seen.has(id) || seen.size < limit) { seen.add(id); return id; }
  return overflowId;
}
