/*! src/core/taxonomy.js is compiled from ts/src/core/taxonomy.ts by tools/build-ts.sh, which leaves
    out every comment but this one: the explanations are in the source. Edit the TypeScript, never
    the .js: the build refuses to overwrite a hand edit, and its check mode fails on one. */

// Groups, tiers and the item bookkeeping every format module shares.

export type Tier = 'red' | 'amber' | 'green';
export type GroupId = 'where' | 'who' | 'when' | 'device' | 'hidden' | 'technical';

/** What a format module hands to ItemSet.add. Only id, group, tier and label are always set. */
export interface ItemSpec {
  id: string;
  group: string;
  tier: Tier;
  label: string;
  value?: unknown;
  source?: string;
  note?: string;
}

/** The public description of one detail, as inspect() returns it to the page. */
export interface Item {
  id: string;
  group: string;
  tier: Tier;
  label: string;
  value: string;
  source: string | undefined;
  note?: string;
}

/**
 * The private removal data a format module keeps for one item. Its shape depends on the
 * module and on the item's kind, and only the module that stored it reads it back.
 */
// `any` on purpose, as in the JSDoc type this replaces: each format module stores its own fields
// here and reads them back as its own types (offsets, ranges, keys, nested records). With
// `unknown`, every one of those reads would need a cast. A typed record per module is a later
// step, not part of the move to TypeScript, which changes no code.
export type ItemInternal = Record<string, any>;

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
  amber: { label: 'Think about it', description: 'Can reveal routines, devices or history. Kept unless you tick it.' },
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

export const TIER_ORDER: Record<Tier, number> = { red: 0, amber: 1, green: 2 };

// Text a person or an app writes freely (captions, titles, descriptions, keywords,
// comments) can name people, so it is red. Amber holds only structured details: dates,
// time zone, camera, lens, software, other camera data and the HDR details.
// Each format module says so in the note of such a detail.

// The strictest of several tiers: red beats amber beats green.
export function strictest(tiers: Iterable<Tier | null | undefined>): Tier | null {
  let best: Tier | null = null;
  for (const t of tiers) if (t && (best === null || TIER_ORDER[t] < TIER_ORDER[best])) best = t;
  return best;
}

// Shared wording for data a format module cannot read or place.
export const UNREADABLE: {
  damaged: { group: string, tier: Tier, label: string, note: string },
  unknown: { group: string, tier: Tier, label: string, note?: string },
} = {
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
//
// The properties are declared fields (`declare`), so tsc writes no class field: the
// constructor creates them, in this order, as it always has.
export class ItemSet {
  declare items: Item[];
  declare internal: Map<string, ItemInternal>;
  declare byId: Map<string, Item>;
  declare nextSuffix: Map<string, number>;
  declare warnings: string[];
  declare warningSet: Set<string>;
  declare extraWarnings: number;
  /**
   * Set by a format module when a scrub must write the file again even if nothing is
   * removed (its XMP is not yet in the one canonical form). Not set here, deliberately:
   * a new ItemSet has no own property of this name until a format module sets it.
   */
  declare normalise: boolean | undefined;

  constructor() {
    this.items = [];
    this.internal = new Map();
    this.byId = new Map();
    this.nextSuffix = new Map();
    this.warnings = [];
    this.warningSet = new Set();
    this.extraWarnings = 0;
    // A bare read, kept line for line from the JavaScript (DESIGN.md section 2). It creates
    // no property.
    this.normalise;
  }

  /** Returns the id given to the item. */
  add(item: ItemSpec, internal: ItemInternal = {}): string {
    let id = item.id;
    if (this.internal.has(id)) {
      let n = this.nextSuffix.get(item.id) || 2;
      while (this.internal.has(`${item.id}:${n}`)) n++;
      id = `${item.id}:${n}`;
      this.nextSuffix.set(item.id, n + 1);
    }
    const pub: Item = {
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

  has(id: string): boolean { return this.internal.has(id); }
  get(id: string): ItemInternal | undefined { return this.internal.get(id); }
  item(id: string): Item | undefined { return this.byId.get(id); }

  warn(text: string): void {
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
export function cappedId(seen: Set<string>, id: string, overflowId: string, limit: number = 24): string {
  if (seen.has(id) || seen.size < limit) { seen.add(id); return id; }
  return overflowId;
}
