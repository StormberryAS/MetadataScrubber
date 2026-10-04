// XMP reader and selective rewriter.
//
// A small, careful XML scanner (no DOMParser, so it runs in Node too). It understands
// elements, attributes, text, comments, CDATA and processing instructions, records the
// source position of everything, and reads XMP properties in both forms used inside an
// RDF node: attributes (exif:GPSLatitude="...") and child elements (<dc:creator><rdf:Seq>...).
// Typed nodes (an rdf:RDF child that is not rdf:Description) are read the same way, and
// rdf:about values, comments, stray text and unknown processing instructions are offered
// too, so nothing in a packet is hidden from the list.
//
// Removing anything writes a FRESH packet from the kept properties only: comments, typed
// node names, old identifiers and any text between properties do not survive. The new
// packet is parsed again and checked before it is trusted.

import { clip, encodeUtf8, utf8 } from './bytes.js?v=4d7df4d3';
import { iccNameAllowed } from './icc.js?v=15403b52';
import { deviceNameOk, keyForTagName, technicalCount } from './tiff.js?v=f010e347';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const META = 'adobe:ns:meta/';
const MAX_DEPTH = 256;

// Namespace URIs to the usual prefixes, so files that pick odd prefixes still map.
const NS = {
  [RDF]: 'rdf',
  [META]: 'x',
  'http://purl.org/dc/elements/1.1/': 'dc',
  'http://ns.adobe.com/xap/1.0/': 'xmp',
  'http://ns.adobe.com/xap/1.0/rights/': 'xmpRights',
  'http://ns.adobe.com/xap/1.0/mm/': 'xmpMM',
  'http://ns.adobe.com/xap/1.0/g/img/': 'xmpGImg',
  'http://ns.adobe.com/xmp/note/': 'xmpNote',
  'http://ns.adobe.com/photoshop/1.0/': 'photoshop',
  'http://ns.adobe.com/tiff/1.0/': 'tiff',
  'http://ns.adobe.com/exif/1.0/': 'exif',
  'http://cipa.jp/exif/1.0/': 'exifEX',
  'http://ns.adobe.com/exif/1.0/aux/': 'aux',
  'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/': 'Iptc4xmpCore',
  'http://iptc.org/std/Iptc4xmpExt/2008-02-29/': 'Iptc4xmpExt',
  'http://ns.adobe.com/camera-raw-settings/1.0/': 'crs',
  'http://ns.adobe.com/lightroom/1.0/': 'lr',
  'http://ns.google.com/photos/1.0/camera/': 'GCamera',
  'http://ns.google.com/photos/1.0/container/': 'Container',
  'http://ns.google.com/photos/1.0/container/item/': 'Item',
  'http://ns.adobe.com/hdr-gain-map/1.0/': 'hdrgm',
  'http://ns.apple.com/HDRGainMap/1.0/': 'HDRGainMap',
  'http://ns.apple.com/pixeldatainfo/1.0/': 'apdi',
  'http://ns.google.com/photos/1.0/image/': 'GImage',
  'http://ns.google.com/photos/1.0/depthmap/': 'GDepth',
  'http://ns.google.com/photos/1.0/panorama/': 'GPano',
  'http://ns.useplus.org/ldf/xmp/1.0/': 'plus',
  'http://www.metadataworkinggroup.com/schemas/regions/': 'mwg-rs',
  'http://ns.microsoft.com/photo/1.2/': 'MP',
  'http://ns.microsoft.com/photo/1.0/': 'MicrosoftPhoto',
  'http://ns.adobe.com/xmp/1.0/DynamicMedia/': 'xmpDM',
  'http://ns.adobe.com/pdf/1.3/': 'pdf',
  'http://www.dji.com/drone-dji/1.0/': 'drone-dji',
  'http://www.digikam.org/ns/1.0/': 'digiKam',
};

// Some writers drop the final '#' or change its case; readers still treat it as RDF.
const isRdfUri = (u) => !!u && u.replace(/#$/, '').toLowerCase() === RDF.slice(0, -1);

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
// White space between XML nodes: ASCII only. Any other space character (no-break, en,
// em, ideographic and so on) can spell text, so it is not blank.
const blank = (s) => /^[ \t\r\n\0]*$/.test(s);

// Builds an element tree with source positions. Throws on malformed input, and on
// nesting deeper than any real packet needs (a crafted file must not exhaust the stack).
export function parseXml(s) {
  const root = { name: '#root', attrs: [], children: [], start: 0, end: s.length, parent: null, depth: 0, comments: [], pis: [] };
  let cur = root;
  let p = 0;
  // Line ends are read as XML 1.0 reads them (section 2.11): CR LF and a lone CR become LF,
  // before character references, which may still give a CR.
  const addText = (a, b) => { if (b > a) cur.children.push({ text: decodeEntities(s.slice(a, b).replace(/\r\n?/g, '\n')), start: a, end: b }); };
  while (p < s.length) {
    const lt = s.indexOf('<', p);
    if (lt < 0) { addText(p, s.length); break; }
    addText(p, lt);
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      if (e < 0) throw new Error('Unclosed comment');
      root.comments.push({ text: s.slice(lt + 4, e), start: lt, end: e + 3 });
      p = e + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt);
      if (e < 0) throw new Error('Unclosed CDATA');
      cur.children.push({ text: s.slice(lt + 9, e).replace(/\r\n?/g, '\n'), start: lt, end: e + 3 });
      p = e + 3;
      continue;
    }
    if (s.startsWith('<?', lt)) {
      const e = s.indexOf('?>', lt);
      if (e < 0) throw new Error('Unclosed processing instruction');
      const body = s.slice(lt + 2, e);
      root.pis.push({ target: body.split(/[\s?]/)[0], text: body, start: lt, end: e + 2 });
      p = e + 2;
      continue;
    }
    if (s.startsWith('<!', lt)) {
      const e = s.indexOf('>', lt);
      if (e < 0) throw new Error('Unclosed declaration');
      root.comments.push({ text: s.slice(lt + 2, e), start: lt, end: e + 1 });
      p = e + 1;
      continue;
    }
    if (s[lt + 1] === '/') {
      const e = s.indexOf('>', lt);
      if (e < 0) throw new Error('Unclosed end tag');
      const name = s.slice(lt + 2, e).trim();
      if (cur === root || name !== cur.name) throw new Error(`Mismatched end tag ${name}`);
      cur.end = e + 1;
      cur = cur.parent;
      p = e + 1;
      continue;
    }
    let q = lt + 1;
    while (q < s.length && !isWs(s[q]) && s[q] !== '/' && s[q] !== '>') q++;
    const name = s.slice(lt + 1, q);
    if (!name) throw new Error('Empty tag name');
    const attrs = [];
    let selfClose = false;
    for (;;) {
      const wsStart = q;
      while (q < s.length && isWs(s[q])) q++;
      if (q >= s.length) throw new Error('Unclosed start tag');
      if (s[q] === '/' && s[q + 1] === '>') { selfClose = true; q += 2; break; }
      if (s[q] === '>') { q++; break; }
      if (q === wsStart) throw new Error('Missing space between attributes');
      const a0 = q;
      while (q < s.length && !isWs(s[q]) && s[q] !== '=' && s[q] !== '>' && s[q] !== '/') q++;
      const aname = s.slice(a0, q);
      while (q < s.length && isWs(s[q])) q++;
      if (s[q] !== '=' || !aname) throw new Error('Malformed attribute');
      q++;
      while (q < s.length && isWs(s[q])) q++;
      const quote = s[q];
      if (quote !== '"' && quote !== "'") throw new Error('Unquoted attribute');
      const e = s.indexOf(quote, q + 1);
      if (e < 0) throw new Error('Unclosed attribute');
      const raw = s.slice(q + 1, e);
      if (raw.includes('<')) throw new Error('Bad attribute value');
      // Attribute values are normalised as XML 1.0 does (section 3.3.3): each literal tab,
      // line feed or carriage return (a CR LF pair counts once) is a space; a character
      // reference still gives the character itself.
      attrs.push({ name: aname, value: decodeEntities(raw.replace(/\r\n|[\r\n\t]/g, ' ')), start: wsStart, end: e + 1 });
      q = e + 1;
    }
    const el = { name, attrs, children: [], start: lt, openEnd: q, end: selfClose ? q : -1, parent: cur, depth: cur.depth + 1 };
    if (el.depth > MAX_DEPTH) throw new Error('Too deeply nested');
    cur.children.push(el);
    if (!selfClose) cur = el;
    p = q;
  }
  if (cur !== root) throw new Error('Unclosed element');
  return root;
}

const elements = (el) => el.children.filter((c) => c.name !== undefined);
const splitName = (n) => { const i = n.indexOf(':'); return i < 0 ? ['', n] : [n.slice(0, i), n.slice(i + 1)]; };
const isNsAttr = (a) => a.name === 'xmlns' || a.name.startsWith('xmlns:');

function nsUri(el, prefix) {
  const key = prefix ? `xmlns:${prefix}` : 'xmlns';
  for (let e = el; e; e = e.parent) {
    const a = e.attrs && e.attrs.find((x) => x.name === key);
    if (a) return isRdfUri(a.value) ? RDF : a.value;
  }
  return prefix === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : '';
}

function qualify(el, name) {
  const [prefix, local] = splitName(name);
  const uri = nsUri(el, prefix);
  return { prefix: NS[uri] || prefix || '?', local, uri, raw: prefix };
}

// The name a kept element or attribute is written with: the usual prefix of its namespace
// when the namespace is a known one, so a prefix chosen to carry text does not survive.
// Unprefixed attributes have no namespace and keep their name.
function canonName(el, name, attr = false) {
  const [prefix, local] = splitName(name);
  if (prefix === 'xml' || prefix === 'xmlns' || name === 'xmlns' || (attr && !prefix)) return name;
  const uri = nsUri(el, prefix);
  if (uri === RDF) return `rdf:${local}`;
  return NS[uri] ? `${NS[uri]}:${local}` : name;
}
// The attribute that declares a prefix for an element, or null.
function nsDecl(el, prefix) {
  const key = prefix ? `xmlns:${prefix}` : 'xmlns';
  for (let e = el; e; e = e.parent) {
    const a = e.attrs && e.attrs.find((x) => x.name === key);
    if (a) return a;
  }
  return null;
}
// The prefixes Adobe's own early writers used for the XMP namespaces (the format was first
// called XAP): fixed names, so they carry nothing.
const LEGACY_PREFIX = { xmp: 'xap', xmpMM: 'xapMM', xmpRights: 'xapRights', xmpGImg: 'xapGImg' };
// The packet wrapper as XMP writers give it: a fixed identifier and a fixed end.
const XPACKET_OK = [
  /^xpacket begin=(["'])(?:\uFEFF|\u00ef\u00bb\u00bf)?\1 id=(["'])W5M0MpCehiHzreSzNTczkc9d\2 ?$/,
  /^xpacket end=(["'])[wr]\1 ?$/,
];
// Numeric character references a writer needs: for the characters XML must escape and for
// tabs and line breaks, without leading zeros. Others choose a form freely, which can
// carry bits, so they are listed as hidden text.
const REF_NEEDED = new Set([9, 10, 13, 34, 38, 39, 60, 62]);

const textOf = (el) => el.children.filter((c) => c.name === undefined).map((c) => c.text).join('').trim();

function valueOf(el, depth = 0) {
  if (depth > 6) return '';
  const res = el.attrs.find((a) => qualify(el, a.name).uri === RDF && qualify(el, a.name).local === 'resource');
  if (res) return res.value;
  const kids = elements(el);
  const fieldAttrs = el.attrs.filter((a) => !isNsAttr(a) && qualify(el, a.name).uri !== RDF && !a.name.startsWith('xml:'));
  const parts = fieldAttrs.map((a) => `${splitName(a.name)[1]}: ${a.value}`);
  for (const k of kids) {
    const q = qualify(k, k.name);
    if (q.uri === RDF && (q.local === 'Seq' || q.local === 'Bag' || q.local === 'Alt')) {
      parts.push(elements(k).map((li) => valueOf(li, depth + 1)).filter(Boolean).join('; '));
    } else if (q.uri === RDF && (q.local === 'Description' || q.local === 'li')) {
      parts.push(valueOf(k, depth + 1));
    } else {
      const v = valueOf(k, depth + 1);
      if (v) parts.push(`${q.local}: ${v}`);
    }
  }
  if (!kids.length && !parts.length) return textOf(el);
  return parts.filter(Boolean).join('; ');
}

// First element matching a test, searched without recursion.
function findElement(root, test) {
  const stack = [...elements(root)].reverse();
  while (stack.length) {
    const el = stack.pop();
    if (test(el)) return el;
    const kids = elements(el);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return null;
}

function wsBefore(s, i) {
  while (i > 0 && isWs(s[i - 1])) i--;
  return i;
}

// ======================================================================================
// HDR gain map and Container directory: what a kept gain map may keep.
//
// Only fields a published gain map specification defines as needed to find or show the
// gain map survive with it, and only with a value of the form the specification gives:
// Adobe's hdrgm namespace (Gain Map 1.0, used by Ultra HDR), Apple's HDRGainMap namespace,
// the core fields of the Container directory (GContainer, as Ultra HDR and Motion Photo
// use it), and, in the gain map's own packet only, Apple's apdi:AuxiliaryImageType with the
// one fixed value that marks an Apple gain map (readers such as Chrome require it). A known
// name with any other value, a repeated field, and anything else in those namespaces is
// offered as a detail of its own.

export const HDRGM_URI = 'http://ns.adobe.com/hdr-gain-map/1.0/';
export const APPLE_GAIN_URI = 'http://ns.apple.com/HDRGainMap/1.0/';
export const APDI_URI = 'http://ns.apple.com/pixeldatainfo/1.0/';
export const APPLE_GAIN_MAP_TYPE = 'urn:com:apple:photo:2020:aux:hdrgainmap';
const CONTAINER_URI = 'http://ns.google.com/photos/1.0/container/';
const ITEM_URI = 'http://ns.google.com/photos/1.0/container/item/';

// A number as writers print it. The gain map's numbers are single-precision values, so a
// value has at most nine significant digits, or is exactly the double a single-precision
// value prints as (2.299999952316284 for 2.3); more digits than that are free to carry text.
const REAL_RE = /^[+-]?(\d{1,20}(\.\d{0,20})?|\.\d{1,20})([eE][+-]?\d{1,3})?$/;
const sigDigits = (v) => v.replace(/[eE].*$/, '').replace(/[^0-9]/g, '').replace(/^0+/, '').replace(/0+$/, '').length;
const realOk = (v) => v.length <= 32 && REAL_RE.test(v) && Number.isFinite(Number(v))
  && (sigDigits(v) <= 9 || String(Math.fround(Number(v))) === String(Number(v)));
// The range each gain map number can have (Adobe Gain Map 1.0: log2 boosts, a gamma, small
// offsets, a capacity in stops; Apple: the headroom as a factor). Text written as a number
// falls outside them.
const SPANS = { log2: [-16, 16], gamma: [0, 16, true], offset: [-1, 1], capacity: [0, 16], headroom: [1, 1000] };
const spanOk = (kind, v) => { const [lo, hi, open] = SPANS[kind]; const x = Number(v); return Number.isFinite(x) && x <= hi && (open ? x > lo : x >= lo); };
const GAIN_RANGES = Object.fromEntries(Object.keys(SPANS).map((k) => [k, (v) => realOk(v) && spanOk(k, v)]));
// A number in range but with more digits than a single-precision value has (a double such
// as 2.321928094887362, as some writers print one): the extra digits are free, so the value
// is not kept as it is, but it is written again rounded to nine significant digits, which
// is what a reader keeps of it.
const roundable = (kind, v) => v.length <= 32 && REAL_RE.test(v) && Object.hasOwn(SPANS, kind) && spanOk(kind, v) && !realOk(v);
const rounded = (v) => String(Number(Number(v).toPrecision(9)));
// The directory names its parts from fixed lists only, so no free text rides along: the
// roles Ultra HDR and Motion Photo define, and the file types they use for them.
const SEMANTICS = new Set(['Primary', 'GainMap', 'MotionPhoto']);
const MIME_FOR = { Primary: ['image/jpeg'], GainMap: ['image/jpeg'], MotionPhoto: ['video/mp4', 'video/quicktime'] };
const MIMES = new Set(Object.values(MIME_FOR).flat());
const VALUE_OK = {
  ...GAIN_RANGES,
  real: realOk,
  // Apple writes the version as a 16.16 fixed-point number: 65536 for 1.0, 131072 for 2.0.
  appleVersion: (v) => /^\d{1,7}$/.test(v) && ((Number(v) % 65536 === 0 && Number(v) <= 16 * 65536) || Number(v) < 256),
  bool: (v) => v === 'True' || v === 'False',
  version: (v) => /^\d{1,3}(\.\d{1,3}){1,2}$/.test(v),
  int: (v) => /^\d{1,10}$/.test(v),
  mime: (v) => MIMES.has(v),
  semantic: (v) => SEMANTICS.has(v),
  apdi: (v) => v === APPLE_GAIN_MAP_TYPE,
};
// A kind ending in 3 is a number, or an rdf:Seq of one or three numbers (one per colour
// channel).
const GAIN_FIELDS = {
  [HDRGM_URI]: {
    Version: 'version', BaseRenditionIsHDR: 'bool', GainMapMin: 'log23', GainMapMax: 'log23', Gamma: 'gamma3',
    OffsetSDR: 'offset3', OffsetHDR: 'offset3', HDRCapacityMin: 'capacity', HDRCapacityMax: 'capacity',
  },
  [APPLE_GAIN_URI]: { HDRGainMapVersion: 'appleVersion', HDRGainMapHeadroom: 'headroom' },
};
// Allowed in the gain map's own packet only: a photo does not need it.
const GAIN_MAP_ONLY_FIELDS = { [APDI_URI]: { AuxiliaryImageType: 'apdi' } };
const gainFieldsOf = (uri, carrier) => GAIN_FIELDS[uri] || (carrier === 'gainmap' ? GAIN_MAP_ONLY_FIELDS[uri] : null);
const ITEM_FIELDS = { Mime: 'mime', Semantic: 'semantic', Length: 'int', Padding: 'int' };

const isRdfNode = (el, local) => { const q = qualify(el, el.name); return q.uri === RDF && q.local === local; };
const fieldAttrsOf = (el) => el.attrs.filter((a) => !isNsAttr(a));
const rawText = (el) => el.children.filter((c) => c.name === undefined).map((c) => c.text).join('');
const onlyBlankText = (el) => el.children.every((c) => c.name !== undefined || blank(c.text));
const isGainNs = (p) => p.uri === HDRGM_URI || p.uri === APPLE_GAIN_URI || p.uri === APDI_URI || p.prefix === 'hdrgm' || p.prefix === 'HDRGainMap' || p.prefix === 'apdi';
const isContainerNs = (p) => p.uri === CONTAINER_URI || p.uri === ITEM_URI || p.prefix === 'Container' || p.prefix === 'Item';

function gainValueOk(kind, p) {
  const triple = kind.endsWith('3');
  const test = VALUE_OK[triple ? kind.slice(0, -1) : kind];
  if (p.kind === 'attr') return test(p.value);
  if (p.kind !== 'elem') return false;
  const el = p.node;
  if (fieldAttrsOf(el).length) return false;
  const kids = elements(el);
  if (!kids.length) return test(rawText(el));
  if (!triple || kids.length !== 1 || !onlyBlankText(el)) return false;
  const seq = kids[0];
  if (!isRdfNode(seq, 'Seq') || fieldAttrsOf(seq).length || !onlyBlankText(seq)) return false;
  const lis = elements(seq);
  if (lis.length !== 1 && lis.length !== 3) return false;
  return lis.every((li) => isRdfNode(li, 'li') && !fieldAttrsOf(li).length && !elements(li).length && test(rawText(li)));
}

// Indices of the properties a kept gain map may keep: each known gain map field once, with
// a value of the form its specification gives. carrier is 'photo' (the default) or
// 'gainmap', the gain map's own packet.
export function gainAllowed(parsed, carrier = 'photo') {
  const ok = new Set();
  const seen = new Set();
  if (!parsed.ok) return ok;
  parsed.props.forEach((p, i) => {
    if (p.kind !== 'attr' && p.kind !== 'elem') return;
    const fields = gainFieldsOf(p.uri, carrier);
    if (!fields || !Object.hasOwn(fields, p.local)) return;
    const name = `${p.uri}${p.local}`;
    if (seen.has(name)) return;
    seen.add(name);
    if (gainValueOk(fields[p.local], p)) ok.add(i);
  });
  return ok;
}

// Gain map numbers with more digits than they need, as attributes or simple elements: each
// written again rounded (see roundable), { index, local, add } for rewriteXmp. Only the
// first copy of a field counts, and only when no well-formed copy exists.
export function gainFixes(parsed, carrier = 'photo') {
  const out = [];
  if (!parsed || !parsed.ok) return out;
  const allowed = gainAllowed(parsed, carrier);
  const keptNames = new Set([...allowed].map((i) => `${parsed.props[i].uri}${parsed.props[i].local}`));
  const seen = new Set();
  parsed.props.forEach((p, i) => {
    if (p.kind !== 'attr' && p.kind !== 'elem') return;
    const fields = gainFieldsOf(p.uri, carrier);
    if (!fields || !Object.hasOwn(fields, p.local)) return;
    const name = `${p.uri}${p.local}`;
    if (seen.has(name) || keptNames.has(name)) return;
    seen.add(name);
    const kind = fields[p.local].replace(/3$/, '');
    const simple = p.kind === 'attr' || (!fieldAttrsOf(p.node).length && !elements(p.node).length);
    const v = p.kind === 'attr' ? p.value : rawText(p.node);
    if (!simple || !roundable(kind, v)) return;
    out.push({ index: i, local: p.local, add: { key: p.key, name: p.kind === 'attr' ? p.attr.name : p.node.name, node: p.node, value: rounded(v) } });
  });
  return out;
}

// When a packet's hdrgm:Version has a value of the wrong form (so it is offered for removal)
// and no well-formed copy exists, the attribute that replaces it with the one value Gain
// Map 1.0 defines: { index, add } for planXmp, or null. Readers need hdrgm:Version in the
// photo to find the gain map, and a fixed value carries no hidden bits.
export function versionFix(parsed) {
  if (!parsed || !parsed.ok) return null;
  const allowed = gainAllowed(parsed);
  const isVersion = (p) => (p.kind === 'attr' || p.kind === 'elem') && p.uri === HDRGM_URI && p.local === 'Version';
  if ([...allowed].some((i) => isVersion(parsed.props[i]))) return null;
  const index = parsed.props.findIndex(isVersion);
  if (index < 0) return null;
  const p = parsed.props[index];
  const name = p.kind === 'attr' ? p.attr.name : p.node.name;
  return { index, add: { key: p.key, name, node: p.node, value: '1.0' } };
}

// Apple's label in a gain map's own packet, when it holds the one fixed value but in a form
// that is not kept (an attribute on it, an unusual prefix): the label written again in the
// usual form, { index, add } for rewriteXmp, or null. Readers find an Apple gain map only
// by this label, and a fixed value carries no hidden bits.
export function appleLabelFix(parsed) {
  if (!parsed || !parsed.ok) return null;
  const isLabel = (p) => (p.kind === 'attr' || p.kind === 'elem') && p.uri === APDI_URI && p.local === 'AuxiliaryImageType';
  if ([...gainAllowed(parsed, 'gainmap')].some((i) => isLabel(parsed.props[i]))) return null;
  const index = parsed.props.findIndex((p) => isLabel(p) && p.value === APPLE_GAIN_MAP_TYPE);
  if (index < 0) return null;
  const p = parsed.props[index];
  return { index, add: { key: p.key, name: p.kind === 'attr' ? p.attr.name : p.node.name, node: p.node, value: APPLE_GAIN_MAP_TYPE } };
}

// Whether a packet has an hdrgm:Version at all, of any value: what tells a reader of the
// photo that a gain map follows.
export function hasGainVersion(parsed) {
  return !!(parsed && parsed.ok && parsed.props.some((p) => (p.kind === 'attr' || p.kind === 'elem') && p.uri === HDRGM_URI && p.local === 'Version'));
}

// The gain map fields of a packet as name and value, for the plausibility check and tests.
export function gainFields(parsed, carrier = 'photo') {
  const out = {};
  for (const i of gainAllowed(parsed, carrier)) {
    const p = parsed.props[i];
    out[`${p.uri === HDRGM_URI ? 'hdrgm' : p.uri === APDI_URI ? 'apdi' : 'HDRGainMap'}:${p.local}`] = p.value;
  }
  return out;
}

// Reads a Container:Directory element: one rdf:Seq of rdf:li, each holding one
// Container:Item with Item:Mime, Item:Semantic, Item:Length and Item:Padding. Returns
// { ok, entries, extras }; extras are every other attribute, element and text in it, each
// with a reference to the node it came from. ok is false when the shape is not that of a
// directory at all.
function parseDirectory(dirEl) {
  const fail = { ok: false, entries: [], extras: [] };
  const extras = [];
  const entries = [];
  const extraAttr = (el, a) => extras.push({ ref: a, el, name: a.name, value: a.value });
  const extraEl = (el) => extras.push({ ref: el, el, name: el.name, value: valueOf(el) || '' });
  const extraText = (el) => {
    for (const c of el.children) if (c.name === undefined && !blank(c.text)) extras.push({ ref: c, el, text: true, value: c.text.replace(/[\s\0]+/g, ' ').trim() });
  };
  const attrs = (el, allow = () => false) => { for (const a of fieldAttrsOf(el)) if (!allow(a)) extraAttr(el, a); };
  const resourceAttr = (el) => (a) => { const q = qualify(el, a.name); return q.uri === RDF && q.local === 'parseType' && a.value === 'Resource'; };
  attrs(dirEl);
  extraText(dirEl);
  const kids = elements(dirEl);
  const seq = kids.find((k) => isRdfNode(k, 'Seq'));
  if (!seq) return fail;
  for (const k of kids) if (k !== seq) extraEl(k);
  attrs(seq);
  extraText(seq);
  for (const li of elements(seq)) {
    if (!isRdfNode(li, 'li')) { extraEl(li); continue; }
    const resource = fieldAttrsOf(li).some(resourceAttr(li));
    attrs(li, resourceAttr(li));
    extraText(li);
    let holder = li;
    if (!resource) {
      const d = elements(li);
      if (d.length !== 1 || !isRdfNode(d[0], 'Description')) return fail;
      holder = d[0];
      attrs(holder, (a) => { const q = qualify(holder, a.name); return q.uri === RDF && q.local === 'about' && blank(a.value); });
      extraText(holder);
    }
    const inner = elements(holder);
    const item = inner.find((k) => { const q = qualify(k, k.name); return q.uri === CONTAINER_URI && q.local === 'Item'; });
    if (!item) return fail;
    for (const k of inner) if (k !== item) extraEl(k);
    const fields = {};
    const fieldKind = (el, name) => { const q = qualify(el, name); return q.uri === ITEM_URI && Object.hasOwn(ITEM_FIELDS, q.local) ? q.local : null; };
    // A Mime that is not one the entry's role uses is not part of the directory. On the
    // photo and the gain map, removing it writes the one value the role allows, so a reader
    // still finds the gain map; it carries no hidden bits.
    let badMime = null;
    for (const a of fieldAttrsOf(item)) {
      if (resourceAttr(item)(a)) continue;
      const f = fieldKind(item, a.name);
      if (f && !fields[f] && VALUE_OK[ITEM_FIELDS[f]](a.value)) fields[f] = { value: a.value, attr: a };
      else if (f === 'Mime' && !fields.Mime && !badMime) badMime = { ref: a, el: item, name: a.name, value: a.value };
      else extraAttr(item, a);
    }
    extraText(item);
    for (const k of elements(item)) {
      const f = fieldKind(k, k.name);
      const simple = !fieldAttrsOf(k).length && !elements(k).length;
      if (f && !fields[f] && simple && VALUE_OK[ITEM_FIELDS[f]](rawText(k))) fields[f] = { value: rawText(k), el: k };
      else if (f === 'Mime' && simple && !fields.Mime && !badMime) badMime = { ref: k, el: k, name: k.name, value: valueOf(k) || rawText(k) };
      else extraEl(k);
    }
    const role = fields.Semantic ? fields.Semantic.value : null;
    if (fields.Mime && role && !MIME_FOR[role].includes(fields.Mime.value)) {
      const f = fields.Mime;
      delete fields.Mime;
      badMime = { ref: f.attr || f.el, el: f.attr ? item : f.el, name: f.attr ? f.attr.name : f.el.name, value: f.value };
    }
    if (badMime) {
      if (role === 'Primary' || role === 'GainMap') badMime.fix = MIME_FOR[role][0];
      extras.push(badMime);
    }
    const num = (f) => (fields[f] ? Number(fields[f].value) : null);
    entries.push({ li, fields, semantic: fields.Semantic ? fields.Semantic.value : null, mime: fields.Mime ? fields.Mime.value : null, length: num('Length'), padding: num('Padding') });
  }
  return { ok: true, entries, extras };
}

function subKey(x) {
  if (x.text) return { key: 'xml:text', prefix: 'xml', local: 'text', uri: '' };
  const q = qualify(x.el, x.name);
  return { key: `${q.prefix}:${q.local}`, prefix: q.prefix, local: q.local, uri: q.uri };
}

const dirSig = (d) => JSON.stringify(d.entries.map((e) => [e.semantic, e.mime, e.length, e.padding]));

// A copy of a directory element with some nodes left out (skip) and some values replaced
// (patch: attribute or element to its new text). The copy keeps the original parent, so
// its namespace prefixes still resolve.
function directoryClone(node, skip, patch) {
  const clone = (el, parent) => {
    const c = { name: el.name, attrs: [], children: [], parent };
    for (const a of el.attrs) if (!skip.has(a)) c.attrs.push(patch.has(a) ? { ...a, value: String(patch.get(a)) } : a);
    if (patch.has(el)) c.children = [{ text: String(patch.get(el)) }];
    else for (const k of el.children) if (!skip.has(k)) c.children.push(k.name === undefined ? k : clone(k, c));
    return c;
  };
  return clone(node, node.parent);
}

// The first readable Container directory of a packet: { index, prop, dir }, or null.
export function directoryOf(parsed) {
  if (!parsed || !parsed.ok) return null;
  const index = parsed.props.findIndex((p) => p.dir && p.dir.primary);
  return index < 0 ? null : { index, prop: parsed.props[index], dir: parsed.props[index].dir };
}

// Offers whole directory entries as sub-properties of the directory: entries (numbered
// from 0, the photo) that stand for no part stored after the image. Such an entry is not
// needed to find anything, and its fields may carry anything, so removing it drops it.
export function offerDirectoryEntries(parsed, numbers) {
  const d = directoryOf(parsed);
  if (!d) return;
  for (const n of numbers) {
    const e = d.dir.entries[n];
    if (!e || n === 0) continue;
    const value = [e.semantic, e.mime, e.length !== null ? `length ${e.length}` : ''].filter(Boolean).join(', ') || `entry ${n + 1}`;
    parsed.props.push({ key: 'Container:Item', prefix: 'Container', local: 'Item', uri: CONTAINER_URI, kind: 'sub', value, start: -1, end: -1, parent: d.index, ref: e.li });
  }
}

// Parses an XMP packet. Returns { ok, text, props, hasRdf } where each prop is
// { key: 'prefix:Local', prefix, local, kind, value, start, end } and kind is 'attr',
// 'elem', 'about', 'sub' or 'hidden' (comments and stray text).
export function parseXmp(input) {
  const text = typeof input === 'string' ? input : utf8(input);
  let root;
  try {
    root = parseXml(text);
  } catch (err) {
    return { ok: false, text, props: [], error: String(err.message || err) };
  }
  const props = [];
  const hidden = [];
  const hide = (value) => { if (!blank(value)) hidden.push(value.replace(/[\s\0]+/g, ' ').trim()); };
  for (const c of root.comments) hide(c.text);
  for (const pi of root.pis) if (pi.target !== 'xpacket' || !XPACKET_OK.some((re) => re.test(pi.text))) hide(pi.target === 'xpacket' ? `packet wrapper: ${pi.text}` : pi.text);
  if (text.includes('<![CDATA[')) hide('CDATA section');
  for (const m of text.matchAll(/&#(x?)([0-9a-fA-F]+);/g)) {
    const n = parseInt(m[2], m[1] ? 16 : 10);
    if (/^0/.test(m[2]) || !REF_NEEDED.has(n)) { hide(`character reference ${m[0]}`); break; }
  }

  const isRdfEl = (el, local) => { const q = qualify(el, el.name); return q.uri === RDF && q.local === local; };
  const rdf = findElement(root, (el) => isRdfEl(el, 'RDF'));

  // Everything around rdf:RDF that is not just whitespace: text, attributes other than the
  // toolkit name, and sibling elements, on every wrapper from the root down.
  const outerText = (el) => { for (const c of el.children) if (c.name === undefined) hide(c.text); };
  if (rdf) {
    const chain = [];
    for (let e = rdf.parent; e; e = e.parent) chain.push(e);
    for (const w of chain) {
      outerText(w);
      for (const a of w.attrs) {
        if (isNsAttr(a)) continue;
        const q = qualify(w, a.name);
        // The toolkit name says which program wrote the packet. No reader needs it and its
        // value is free text, so the canonical form never writes it (0.0.3): it is left out
        // without being listed, like the packet's layout.
        if (q.uri === META && (q.local === 'xmptk' || q.local === 'xaptk')) continue;
        hide(`${a.name}=${a.value}`);
      }
      for (const el of elements(w)) if (el !== rdf && !chain.includes(el)) hide(valueOf(el) || el.name);
    }
  }
  if (rdf) {
    outerText(rdf);
    for (const a of rdf.attrs) if (!isNsAttr(a)) hide(`${a.name}=${a.value}`);
    for (const d of elements(rdf)) {
      outerText(d);
      // A typed node's own name is free text; rdf:Description is the only name XMP uses.
      if (!isRdfEl(d, 'Description')) hide(`typed node ${d.name}`);
      for (const a of d.attrs) {
        if (isNsAttr(a)) continue;
        // xml:lang, xml:space and the like say nothing about the picture; their values are free.
        if (a.name.startsWith('xml:')) { hide(`${a.name}=${a.value}`); continue; }
        const q = qualify(d, a.name);
        if (q.uri === RDF) {
          if (q.local === 'about' || q.local === 'ID' || q.local === 'nodeID') {
            if (a.value !== '') props.push({ key: 'rdf:about', prefix: 'rdf', local: q.local, kind: 'about', value: a.value, start: a.start, end: a.end, attr: a, node: d });
          } else hide(`${a.name}=${a.value}`);
          continue;
        }
        props.push({ key: `${q.prefix}:${q.local}`, prefix: q.prefix, local: q.local, uri: q.uri, kind: 'attr', value: a.value, start: a.start, end: a.end, attr: a, node: d });
      }
      for (const c of elements(d)) {
        const q = qualify(c, c.name);
        props.push({ key: `${q.prefix}:${q.local}`, prefix: q.prefix, local: q.local, uri: q.uri, kind: 'elem', value: valueOf(c), start: wsBefore(text, c.start), end: c.end, node: c });
      }
    }
  }
  // The Container directory (the list of parts stored after the image) is read field by
  // field: its core fields describe the parts, and everything else in it is offered as a
  // sub-property of its own, so a label or a stray field can go while the directory stays.
  const count = props.length;
  let primaryDir = false;
  for (let i = 0; i < count; i++) {
    const p = props[i];
    if (p.kind !== 'elem' || p.uri !== CONTAINER_URI || p.local !== 'Directory') continue;
    p.dir = parseDirectory(p.node);
    if (!p.dir.ok || primaryDir) continue;
    primaryDir = true;
    p.dir.primary = true;
    for (const x of p.dir.extras) props.push({ ...subKey(x), kind: 'sub', value: x.value, start: -1, end: -1, parent: i, ref: x.ref, fix: x.fix });
  }
  // Namespace prefixes are names the writer chooses: a known namespace must use its usual
  // prefix, and a declaration no name uses is free text, unless it is a known namespace
  // under its usual prefix.
  const usedDecl = new Set();
  const checkName = (el, name, attr) => {
    const [prefix] = splitName(name);
    if (prefix === 'xml' || (attr && !prefix)) return;
    const decl = nsDecl(el, prefix);
    if (decl) usedDecl.add(decl);
    const uri = nsUri(el, prefix);
    const want = uri === RDF ? 'rdf' : NS[uri];
    if (want && prefix !== want && !(LEGACY_PREFIX[want] === prefix)) hide(`prefix ${prefix || '(none)'} for ${want}`);
  };
  const all = [...elements(root)];
  while (all.length) {
    const el = all.pop();
    checkName(el, el.name, false);
    for (const a of el.attrs) if (!isNsAttr(a)) checkName(el, a.name, true);
    all.push(...elements(el));
  }
  const decls = [...elements(root)];
  while (decls.length) {
    const el = decls.pop();
    for (const a of el.attrs) {
      if (!isNsAttr(a) || usedDecl.has(a)) continue;
      const prefix = a.name === 'xmlns' ? '' : a.name.slice(6);
      const uri = isRdfUri(a.value) ? RDF : a.value;
      const want = uri === RDF ? 'rdf' : NS[uri];
      if (!prefix || prefix === 'xml' || (want !== prefix && LEGACY_PREFIX[want] !== prefix)) hide(`${a.name}=${a.value}`);
    }
    decls.push(...elements(el));
  }
  if (hidden.length) props.push({ key: 'xml:hidden', prefix: 'xml', local: 'hidden', kind: 'hidden', value: [...new Set(hidden)].join(' / '), start: -1, end: -1 });
  // A packet with content but no RDF root is something other readers may still read.
  const opaque = !rdf && !blank(text.replace(/<\?xpacket[^>]*>/g, '').replace(/<x:xmpmeta[^>]*\/>/, '').replace(/<x:xmpmeta[^>]*>\s*<\/x:xmpmeta>/, ''));
  return { ok: true, text, props, hasRdf: !!rdf, opaque };
}

// ======================================================================================
// Mapping to items

export const XMP_ITEMS = {
  gps: { group: 'where', tier: 'red', label: 'GPS position' },
  place: { group: 'where', tier: 'red', label: 'Place names' },
  creator: { group: 'who', tier: 'red', label: 'Author name and contact details' },
  owner: { group: 'who', tier: 'red', label: 'Camera owner name' },
  people: { group: 'who', tier: 'red', label: 'Names of people in the picture' },
  rights: { group: 'who', tier: 'red', label: 'Rights owner details' },
  serial: { group: 'who', tier: 'red', label: 'Camera and lens serial numbers' },
  copyright: { group: 'who', tier: 'red', label: 'Copyright notice', note: "Usually contains the photographer's name." },
  computer: { group: 'who', tier: 'red', label: 'Computer name', note: "Often contains the owner's name." },
  dates: { group: 'when', tier: 'amber', label: 'Dates and times' },
  camera: { group: 'device', tier: 'amber', label: 'Camera make and model' },
  software: { group: 'device', tier: 'amber', label: 'Editing software' },
  ids: { group: 'hidden', tier: 'red', label: 'Unique document ID', note: 'Can link copies of the picture back to the original file.' },
  thumbnail: { group: 'hidden', tier: 'red', label: 'Built-in preview image', note: 'Can still show the original, uncropped photo after cropping.' },
  makernote: { group: 'hidden', tier: 'red', label: 'Manufacturer notes (may include serial numbers)' },
  depth: { group: 'hidden', tier: 'red', label: 'Depth map or original picture details' },
  history: { group: 'hidden', tier: 'red', label: 'Edit history', note: 'Can list earlier versions, editing steps and file names, and a file name can hold a person\'s name.' },
  motion: { group: 'hidden', tier: 'amber', label: 'Motion Photo details', note: 'Points to the video clip stored after the picture.' },
  gainmap: { group: 'hidden', tier: 'amber', label: 'HDR gain map details', note: 'Describes the extra brightness image used on HDR screens.' },
  'gainmap-other': { group: 'hidden', tier: 'red', label: 'Unrecognised HDR gain map fields', note: 'Fields in the HDR gain map description that the gain map does not need, or numbers written with more digits than it uses. They may hold anything. Removing them keeps the gain map, with such a number rounded to the digits it uses.' },
  'container-extra': { group: 'hidden', tier: 'red', label: 'Extra fields in the list of parts after the image', note: 'Labels and other fields in the Container directory that no program needs to find the gain map or the video. Removing them keeps both.' },
  'technical-text': { group: 'hidden', tier: 'red', label: 'Unexpected text in technical details', note: 'A technical field that should hold a number or a fixed word holds something else. It can hold names or notes. Removing it keeps the picture unchanged.' },
  'device-text': { group: 'hidden', tier: 'red', label: 'Unexpected text in date or device details', note: 'A date, camera, lens, software or Motion Photo field holds text of a kind its specification does not give it, or extra parts (a language, a type, a qualifier, invisible characters). It can hold names or notes. Removing it keeps the picture unchanged.' },
  extended: { group: 'hidden', tier: 'red', label: 'Extra XMP data' },
  description: { group: 'hidden', tier: 'red', label: 'Title, description and keywords', note: 'Free text written by a person or an app. It can hold names, places or notes.' },
  hidden: { group: 'hidden', tier: 'red', label: 'Hidden text inside XMP', note: 'Comments and other text that XMP readers skip. It can still hold names or notes.' },
  other: { group: 'hidden', tier: 'red', label: 'Unrecognised XMP data', note: 'Data this tool does not recognise. It may hold anything, so it is removed by default.' },
  technical: { group: 'technical', tier: 'green', label: 'Technical details' },
};

const KEY_LISTS = {
  place: ['photoshop:City', 'photoshop:State', 'photoshop:Country', 'Iptc4xmpCore:Location', 'Iptc4xmpCore:CountryCode',
    'Iptc4xmpExt:LocationCreated', 'Iptc4xmpExt:LocationShown', 'Iptc4xmpCore:SubLocation', 'dc:coverage'],
  creator: ['dc:creator', 'photoshop:AuthorsPosition', 'Iptc4xmpCore:CreatorContactInfo', 'photoshop:CaptionWriter',
    'dc:contributor', 'dc:publisher', 'xmp:Author', 'pdf:Author'],
  owner: ['aux:OwnerName', 'exifEX:CameraOwnerName', 'exif:CameraOwnerName'],
  people: ['Iptc4xmpExt:PersonInImage', 'Iptc4xmpExt:PersonInImageWDetails', 'MP:RegionInfo', 'mwg-rs:Regions'],
  serial: ['aux:SerialNumber', 'aux:LensSerialNumber', 'exifEX:BodySerialNumber', 'exifEX:LensSerialNumber',
    'exif:BodySerialNumber', 'exif:LensSerialNumber', 'MicrosoftPhoto:CameraSerialNumber'],
  copyright: ['dc:rights', 'photoshop:Credit', 'photoshop:Source'],
  dates: ['xmp:CreateDate', 'xmp:ModifyDate', 'xmp:MetadataDate', 'photoshop:DateCreated', 'exif:DateTimeOriginal',
    'exif:DateTimeDigitized', 'tiff:DateTime', 'dc:date', 'Iptc4xmpCore:DateCreated', 'MicrosoftPhoto:DateAcquired',
    'GPano:FirstPhotoDate', 'GPano:LastPhotoDate'],
  camera: ['tiff:Make', 'tiff:Model', 'aux:Lens', 'aux:LensInfo', 'aux:LensID', 'aux:Firmware', 'exifEX:LensMake',
    'exifEX:LensModel', 'exifEX:LensSpecification', 'MicrosoftPhoto:LensManufacturer', 'MicrosoftPhoto:LensModel'],
  software: ['xmp:CreatorTool', 'tiff:Software', 'x:xmptk', 'pdf:Producer', 'GPano:CaptureSoftware', 'GPano:StitchingSoftware'],
  computer: ['tiff:HostComputer', 'exif:HostComputer', 'exifEX:HostComputer'],
  // The digests are of the original file's metadata: 128 free bits each, and a link back.
  ids: ['xmpMM:DocumentID', 'xmpMM:InstanceID', 'xmpMM:OriginalDocumentID', 'exif:ImageUniqueID', 'exifEX:ImageUniqueID',
    'photoshop:EmbeddedXMPDigest', 'photoshop:LegacyIPTCDigest', 'tiff:NativeDigest', 'exif:NativeDigest',
    'photoshop:DocumentAncestors', 'GCamera:BurstID', 'aux:ImageNumber', 'dc:identifier', 'xmp:Identifier', 'xmp:BaseURL',
    'xmpMM:LastURL', 'rdf:about'],
  thumbnail: ['xmp:Thumbnails'],
  history: ['xmpMM:History', 'xmpMM:DerivedFrom', 'xmpMM:Ingredients', 'xmpMM:Pantry', 'xmpMM:Manifest',
    'xmpMM:VersionID', 'xmpMM:Versions', 'photoshop:History', 'xmpMM:PreservedFileName', 'dc:source'],
  makernote: ['GCamera:HdrPlusMakernote', 'GCamera:hdrp_makernote'],
  description: ['dc:description', 'dc:title', 'dc:subject', 'photoshop:Headline', 'photoshop:Instructions',
    'photoshop:TransmissionReference', 'lr:hierarchicalSubject', 'xmp:Label', 'xmp:Nickname', 'dc:language', 'dc:type',
    'dc:relation', 'photoshop:Category', 'photoshop:SupplementalCategories', 'photoshop:Urgency', 'photoshop:TextLayers',
    'MicrosoftPhoto:LastKeywordXMP', 'MicrosoftPhoto:LastKeywordIPTC'],
  technical: ['photoshop:ColorMode', 'photoshop:ICCProfile', 'xmp:Rating', 'MicrosoftPhoto:Rating', 'dc:format',
    'photoshop:SidecarForExtension', 'GCamera:BurstPrimary'],
};
const KEY_OF = new Map();
for (const [k, list] of Object.entries(KEY_LISTS)) for (const name of list) KEY_OF.set(name, k);

// Properties nobody listed above are judged by their name, so a vendor's own GPS or
// serial field is still recognised; anything left is 'other', which is red.
function byName(local, value) {
  const n = local.toLowerCase();
  if (/gps|latitude|longitude|longtitude|altitude|geotag|coordinat/.test(n)) return 'gps';
  if (/location|city|country|province|address|street|postal|postcode|zipcode|^state$|sublocation|^place|landmark/.test(n)) return 'place';
  if (/serial/.test(n)) return 'serial';
  if (/owner/.test(n)) return 'owner';
  if (/host ?computer|computer ?name|host ?name|machine ?name/.test(n)) return 'computer';
  if (!/tool|software|version/.test(n) && /author|artist|creator|byline|by-line|photographer|composer|director|performer|publisher|contributor|e-?mail|phone|contact|website|^url$/.test(n)) return 'creator';
  if (/^(person|persons|people|faces?|names?)$|personinimage|peoplenames|facenames/.test(n)) return 'people';
  if (/uuid|guid|uniqueid|identifier|documentid|instanceid|imageid|^id$/.test(n)) return 'ids';
  if (/(^|[;,|]\s*)(people|persons?|faces?|names?)\s*[/|]/i.test(value || '')) return 'people';
  return null;
}

// ======================================================================================
// What a technical (green) field may hold. Green is kept by default, so a technical field
// stays only with a value of the form its specification gives: a number, a fraction, a
// Boolean, a fixed word, a list of those, or a known profile name. Free text, an
// unexpected structure or a field this tool does not know goes to its own red detail.

// A number of at most twelve digits (about the precision of the EXIF values these fields
// copy), or a fraction of two ten-digit integers as EXIF stores them.
const NUM_RE = /^[+-]?(?=\.?\d)(?:\d{0,12})(?:\.\d{0,12})?$/;
const numOk = (v) => NUM_RE.test(v) && v.replace(/[^0-9]/g, '').length <= 12;
const RATIONAL_RE = /^[+-]?\d{1,10}\/[+-]?\d{1,10}$/;
const isNumber = (v) => numOk(v) || RATIONAL_RE.test(v) || v === 'True' || v === 'False';
const inRange = (lo, hi) => (v) => numOk(v) && v.length <= 8 && Number(v) >= lo && Number(v) <= hi;
const intRange = (lo, hi) => (v) => /^-?\d{1,3}$/.test(v) && Number(v) >= lo && Number(v) <= hi;
const isBool = (v) => v === 'True' || v === 'False';
const oneOf = (list) => (v) => list.includes(v);
const DC_FORMATS = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif', 'image/tiff',
  'image/gif', 'image/bmp', 'image/jxl', 'image/x-adobe-dng', 'image/dng', 'image/x-canon-cr2', 'image/x-canon-cr3', 'image/x-nikon-nef',
  'image/x-sony-arw', 'image/x-fuji-raf', 'image/x-olympus-orf', 'image/x-panasonic-rw2', 'image/x-raw', 'application/vnd.adobe.photoshop',
  'image/vnd.adobe.photoshop', 'application/octet-stream'];
const RAW_EXTS = ['JPG', 'JPEG', 'TIF', 'TIFF', 'DNG', 'CR2', 'CR3', 'CRW', 'NEF', 'NRW', 'ARW', 'SR2', 'SRF', 'RAF', 'ORF', 'RW2', 'PEF',
  'SRW', 'X3F', '3FR', 'IIQ', 'MOS', 'ERF', 'KDC', 'DCR', 'MRW', 'RWL', 'HEIC', 'HEIF', 'PSD', 'PNG'];
// Rules by field name; exif, exifEX, tiff and aux fields not listed here hold numbers.
const TECH_RULES = {
  'xmp:Rating': inRange(-1, 5),
  'MicrosoftPhoto:Rating': intRange(0, 100),
  'photoshop:ColorMode': intRange(0, 9),
  'photoshop:ICCProfile': iccNameAllowed,
  'dc:format': oneOf(DC_FORMATS),
  'photoshop:SidecarForExtension': (v) => RAW_EXTS.includes(v.toUpperCase()),
  'GCamera:BurstPrimary': (v) => isBool(v) || /^\d{1,3}$/.test(v),
};
// Google's photo sphere fields (GPano), by their specification.
const GPANO = {
  UsePanoramaViewer: isBool, ExposureLockUsed: isBool, ProjectionType: oneOf(['equirectangular', 'cylindrical', 'rectilinear']),
  PoseHeadingDegrees: numOk, PosePitchDegrees: numOk, PoseRollDegrees: numOk,
  InitialViewHeadingDegrees: numOk, InitialViewPitchDegrees: numOk,
  InitialViewRollDegrees: numOk, InitialHorizontalFOVDegrees: numOk,
  InitialVerticalFOVDegrees: numOk, InitialCameraDolly: numOk,
  SourcePhotosCount: numOk, CroppedAreaImageWidthPixels: numOk,
  CroppedAreaImageHeightPixels: numOk, FullPanoWidthPixels: numOk,
  FullPanoHeightPixels: numOk, CroppedAreaLeftPixels: numOk,
  CroppedAreaTopPixels: numOk, LargestValidInteriorRectLeft: numOk,
  LargestValidInteriorRectTop: numOk, LargestValidInteriorRectWidth: numOk,
  LargestValidInteriorRectHeight: numOk,
};
// The only structures a technical field may have, with their field names.
const TECH_STRUCTS = { 'exif:Flash': ['Fired', 'Return', 'Mode', 'Function', 'RedEyeMode'], 'exif:CFAPattern': ['Columns', 'Rows', 'Values'] };

// The leaf values of a property, or null when its shape is not a plain value, a list of
// plain values, or (for a known structure) fields holding those.
function plainValues(el, fields, uri, depth = 0) {
  if (depth > 3) return null;
  const out = [];
  const resource = el.attrs.some((a) => { const q = qualify(el, a.name); return q.uri === RDF && q.local === 'parseType' && a.value === 'Resource'; });
  const isField = (node, name) => { const q = qualify(node, name); return !!fields && q.uri === uri && fields.includes(q.local); };
  for (const a of fieldAttrsOf(el)) {
    const q = qualify(el, a.name);
    if (q.uri === RDF && q.local === 'parseType' && a.value === 'Resource') continue;
    if (!isField(el, a.name)) return null;
    out.push(a.value);
  }
  const kids = elements(el);
  if (!onlyBlankText(el) && kids.length) return null;
  if (!kids.length) {
    if (!resource && !out.length) out.push(rawText(el));
    else if (!onlyBlankText(el)) return null;
    return out;
  }
  if (!resource && !out.length && kids.length === 1 && ['Seq', 'Bag', 'Alt'].some((k) => isRdfNode(kids[0], k))) {
    const list = kids[0];
    if (fieldAttrsOf(list).length || !onlyBlankText(list)) return null;
    for (const li of elements(list)) {
      if (!isRdfNode(li, 'li') || elements(li).length || fieldAttrsOf(li).length) return null;
      out.push(rawText(li));
    }
    return out;
  }
  if (!resource && !out.length && kids.length === 1 && isRdfNode(kids[0], 'Description')) return plainValues(kids[0], fields, uri, depth + 1);
  if (!resource && !isRdfNode(el, 'Description')) return null;
  for (const k of kids) {
    if (!isField(k, k.name)) return null;
    const v = plainValues(k, null, uri, depth + 1);
    if (!v) return null;
    out.push(...v);
  }
  return out;
}

// Whether a property tiered as technical holds what its specification allows.
// The values are tested as written: white space around a value is not part of any form.
// An EXIF copy has at most as many values as the EXIF field (Exif 3.0); the versions are
// four digits.
function technicalOk(p) {
  const exifLike = ['exif', 'exifEX', 'tiff', 'aux'].includes(p.prefix);
  const versions = exifLike && /^(?:ExifVersion|FlashpixVersion|InteroperabilityVersion)$/.test(p.local);
  const test = TECH_RULES[p.key] || (p.prefix === 'GPano' ? GPANO[p.local] : null)
    || (versions ? (v) => /^\d{4}$|^\d \d \d \d$/.test(v) : exifLike ? isNumber : null);
  if (!test) return false;
  const most = TECH_STRUCTS[p.key] ? TECH_STRUCTS[p.key].length : versions ? 1 : exifLike ? technicalCount(p.local) : 1;
  // Some writers put a short list in one value, separated by single spaces.
  const split = (list) => (most > 1 && !TECH_STRUCTS[p.key] ? list.flatMap((v) => v.split(' ')) : list);
  const vals = p.kind === 'attr' ? [p.value] : p.kind === 'elem' ? plainValues(p.node, TECH_STRUCTS[p.key] || null, p.uri) : null;
  if (!vals) return false;
  const parts = split(vals);
  return parts.length > 0 && parts.length <= most && parts.every((v) => test(v));
}

// What a date or device (amber) property may hold, kept by default since 0.0.3: a plain
// value, or a list of at most four, with no attribute of any kind on the property or its
// list items (no xml:lang, rdf:datatype, rdf:ID, qualifier or structure), each value of
// the form its field gives. A date is an XMP date (ISO 8601), an EXIF-style date, a time
// zone or fractions of a second; a camera, lens or software name is one short line of
// printable text (see deviceNameOk); a Motion Photo field is a number. Anything else is
// the red 'device-text' detail. A short, well-formed name cannot be told apart from a
// model name: that is shown, as amber.
const AMBER_XMP_KEYS = new Set(['dates', 'camera', 'software', 'motion']);
const XMP_DATE = /^\d{4}(?:-\d\d(?:-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)?)?)?)?$/;
const AMBER_VALUE = {
  dates: (v) => XMP_DATE.test(v) || /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/.test(v) || /^[+-]\d\d:\d\d$/.test(v) || /^\d{1,9}$/.test(v),
  camera: deviceNameOk,
  software: deviceNameOk,
  motion: (v) => /^-?\d{1,20}$/.test(v) || v === 'True' || v === 'False',
};
function amberXmpOk(p, key) {
  let vals;
  if (p.kind === 'attr') vals = [p.value];
  else if (p.kind === 'elem') {
    const el = p.node;
    if (fieldAttrsOf(el).length) return false;
    const kids = elements(el);
    if (kids.length > 1 || (kids.length === 1 && !['Seq', 'Bag', 'Alt'].some((k) => isRdfNode(kids[0], k)))) return false;
    vals = plainValues(el, null, p.uri);
    if (!vals || !vals.length || vals.length > 4) return false;
  } else return false;
  return vals.every((v) => AMBER_VALUE[key](trimWs(v)));
}

function rawKey(p) {
  if (p.kind === 'hidden') return 'hidden';
  const named = KEY_OF.get(p.key);
  if (named) return named;
  if ((p.prefix === 'exif' || p.prefix === 'exifEX') && p.local.startsWith('GPS')) return 'gps';
  if (p.prefix === 'xmpRights' || p.prefix === 'plus') return 'rights';
  if (p.prefix === 'mwg-rs') return 'people';
  if (p.prefix === 'crs') return 'history';
  if (p.prefix === 'GCamera' && /^(MotionPhoto|MicroVideo)/.test(p.local)) return 'motion';
  if (p.prefix === 'GImage' || p.prefix === 'GDepth') return 'depth';
  if (p.prefix === 'GPano') return 'technical';
  if (p.prefix === 'xmpGImg') return 'thumbnail';
  if (p.key === 'xmpNote:HasExtendedXMP') return 'extended';
  if (p.prefix === 'aux' && /AlreadyApplied$|^IsMerged|FocusDistance|LensDistort|FlashCompensation/.test(p.local)) return 'technical';
  if (p.prefix === 'exif' || p.prefix === 'exifEX' || p.prefix === 'tiff' || p.prefix === 'aux') {
    const k = keyForTagName(p.local);
    const map = {
      orientation: 'technical', resolution: 'technical', colour: 'technical', dimensions: 'technical',
      exposure: 'technical', format: 'technical', datetime: 'dates', timezone: 'dates', camera: 'camera',
      lens: 'camera', software: 'software', computer: 'computer', owner: 'owner', serial: 'serial', 'lens-serial': 'serial',
      'unique-id': 'ids', description: 'description', copyright: 'copyright', makernote: 'makernote',
      thumbnail: 'thumbnail', other: 'other', private: 'other',
    };
    if (map[k]) return map[k];
  }
  const guess = byName(p.local, p.value);
  if (guess) return guess;
  if (p.prefix === 'xmpMM') return 'history';
  if (p.prefix === 'photoshop' || p.prefix === 'dc') return 'description';
  return 'other';
}

function xmpCoord(v) {
  const m = /^\s*(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?\s*([NSEWnsew])\s*$/.exec(v || '');
  if (!m) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? { deg: Math.abs(n), dir: n < 0 ? '-' : '' } : null;
  }
  return { deg: +m[1] + +m[2] / 60 + (m[3] ? +m[3] / 3600 : 0), dir: m[4].toUpperCase() };
}

function describe(key, props) {
  const vals = (re) => props.filter((p) => re.test(p.local)).map((p) => p.value).filter(Boolean);
  if (key === 'gps') {
    const lat = xmpCoord(vals(/^gps ?latitude$|^latitude$/i)[0]);
    const lon = xmpCoord(vals(/^gps ?long(i|ti)tude$|^longitude$/i)[0]);
    const parts = [];
    const dir = (c, pos, neg) => (c.dir === '-' ? neg : c.dir || pos);
    if (lat && lon) parts.push(`${lat.deg.toFixed(4)} ${dir(lat, 'N', 'S')}, ${lon.deg.toFixed(4)} ${dir(lon, 'E', 'W')}`);
    const altRaw = vals(/altitude$/i)[0];
    if (altRaw) {
      const [a, b] = altRaw.split('/').map(Number);
      const alt = b ? a / b : a;
      if (Number.isFinite(alt)) parts.push(`altitude ${vals(/^GPSAltitudeRef$/)[0] === '1' ? '-' : ''}${Math.round(alt)} m`);
    }
    return clip(parts.join(', ') || `${props.length} GPS fields`);
  }
  if (key === 'technical' || key === 'motion' || key === 'gainmap' || key === 'container') {
    const names = [...new Set(props.map((p) => p.key))];
    return clip(names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '));
  }
  if (key === 'thumbnail') return clip(`${props.length} preview${props.length === 1 ? '' : 's'} stored as text`);
  if (key === 'other' || key === 'gainmap-other' || key === 'container-extra' || key === 'technical-text') {
    const names = [...new Set(props.map((p) => p.key))];
    const first = props.map((p) => p.value.trim()).find(Boolean);
    return clip(`${names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(', ')}${first ? `: ${first}` : ''}`);
  }
  const seen = new Set();
  const out = [];
  for (const p of props) {
    const v = p.value.trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return clip(out.join(', ') || props.map((p) => p.key).join(', '));
}

// Which bucket a property belongs to. Gain map fields need the allowlist (gainAllowed):
// anything else in the hdrgm, HDRGainMap, Container and Item namespaces is judged by its
// name first (a GPS or serial field is still GPS or a serial), then kept apart as
// unrecognised, which is red. In a gain map's own packet (carrier 'gainmap') a Container
// directory is not part of the gain map either.
function classify(p, i, allowed, dirIndex, carrier) {
  if (p.kind === 'hidden') return 'hidden';
  if (p.kind === 'sub') return byName(p.local, p.value) || 'container-extra';
  if (allowed.has(i)) return 'gainmap';
  if (isGainNs(p)) return byName(p.local, p.value) || 'gainmap-other';
  if (isContainerNs(p)) {
    if (i === dirIndex && carrier !== 'gainmap') return 'container';
    if (p.local === 'Directory') return 'container-extra';
    return byName(p.local, p.value) || 'container-extra';
  }
  // A property in a namespace this tool does not know is judged by its name only, never
  // by its prefix: a prefix such as "xmp" bound to some other address names nothing, and
  // the address itself is free text.
  if ((p.kind === 'attr' || p.kind === 'elem') && !NS[p.uri]) return byName(p.local, p.value) || 'other';
  const key = rawKey(p);
  // A technical field kept by default must hold what its specification allows.
  if (key === 'technical' && !technicalOk(p)) return byName(p.local, p.value) || 'technical-text';
  // So must a date or device field, which is kept by default too since 0.0.3.
  if (AMBER_XMP_KEYS.has(key) && !amberXmpOk(p, key)) return 'device-text';
  return key;
}

// Groups the properties of a parsed packet into items.
// ctx: { motionTier, gainMapTier, extended: { label, value, tier, note } | null,
//        carrier: 'photo' (default) | 'gainmap', gainMapCoupled: an HDR gain map follows
//        that goes with this description }
export function xmpItems(parsed, ctx = {}) {
  const buckets = new Map();
  const allowed = gainAllowed(parsed, ctx.carrier);
  const dir = directoryOf(parsed);
  const keys = parsed.props.map((p, i) => classify(p, i, allowed, dir ? dir.index : -1, ctx.carrier));
  const hasMotion = ctx.motionTier || keys.includes('motion');
  const hasGain = ctx.gainMapTier || keys.includes('gainmap');
  parsed.props.forEach((p, i) => {
    let key = keys[i];
    // The directory lists the gain map and the video; it goes with the gain map when there
    // is one (the scrub keeps it for a kept video when only the gain map goes).
    if (key === 'container') key = hasGain ? 'gainmap' : hasMotion ? 'motion' : 'other';
    if (key === 'extended' && !ctx.extended) key = 'other';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  });
  if (ctx.extended && !buckets.has('extended')) buckets.set('extended', []);
  const items = [];
  for (const [key, def] of Object.entries(XMP_ITEMS)) {
    const idx = buckets.get(key);
    if (!idx) continue;
    const props = idx.map((i) => parsed.props[i]);
    const item = { key, ...def, value: describe(key, props), props: idx };
    if (key === 'motion') item.tier = ctx.motionTier || 'amber';
    if (key === 'gainmap') item.tier = ctx.gainMapTier || 'amber';
    if (key === 'gainmap' && ctx.gainMapCoupled) item.note = `${def.note} Without it the gain map cannot be found, so removing it removes the gain map too.`;
    if (key === 'extended') Object.assign(item, ctx.extended);
    items.push(item);
  }
  return items;
}

// ======================================================================================
// Rewriting

// A carriage return is written as a reference, so a reader's line-end handling cannot turn
// it into a line feed.
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

// ======================================================================================
// The canonical form. Every packet this tool keeps is written again in one fixed form, so
// nothing in how it was written survives: no white space between nodes, no padding, no
// comments or processing instructions, prefixes and declarations as the namespace gives
// them, attributes in a fixed order, and the fields of a structure (whose order RDF does
// not define) sorted. A value keeps its text, without the white space around it, which no
// reader shows. The order of list items (rdf:li) is part of the value and stays.

const trimWs = (s) => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
// Whether an element's children keep their order: list items, and mixed text.
const ordered = (el) => elements(el).some((k) => isRdfNode(k, 'li')) || el.children.some((c) => c.name === undefined && !blank(c.text));
const attrName = (el, a) => `${canonName(el, a.name, true)}|${splitName(a.name)[0] ? nsUri(el, splitName(a.name)[0]) : ''}`;

// Serialises an element subtree in the canonical form: no comments, no processing
// instructions, no namespace declarations (they are gathered on the new node instead).
function serialise(el) {
  const name = canonName(el, el.name);
  const attrs = el.attrs.filter((a) => !isNsAttr(a)).map((a) => ` ${canonName(el, a.name, true)}="${escAttr(trimWs(a.value))}"`).sort().join('');
  if (!elements(el).length) {
    const t = trimWs(rawText(el));
    return t ? `<${name}${attrs}>${escText(t)}</${name}>` : `<${name}${attrs}/>`;
  }
  const parts = [];
  for (const c of el.children) {
    if (c.name !== undefined) parts.push(serialise(c));
    else if (!blank(c.text)) parts.push(escText(trimWs(c.text)));
  }
  if (!ordered(el)) parts.sort();
  return `<${name}${attrs}>${parts.join('')}</${name}>`;
}

// What a property element holds, as the canonical form keeps it: names with their
// namespaces, attribute values and text without the white space around them, structure
// fields in any order, list items in order. Two elements with the same model are written
// the same way, and a rewrite must keep the model of every kept property.
function modelOf(el, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('Too deeply nested');
  const name = `${canonName(el, el.name)}|${qualify(el, el.name).uri}`;
  const attrs = el.attrs.filter((a) => !isNsAttr(a)).map((a) => `${attrName(el, a)}=${trimWs(a.value)}`).sort();
  if (!elements(el).length) return JSON.stringify([name, attrs, trimWs(rawText(el))]);
  const parts = [];
  for (const c of el.children) {
    if (c.name !== undefined) parts.push(modelOf(c, depth + 1));
    else if (!blank(c.text)) parts.push(`#${trimWs(c.text)}`);
  }
  if (!ordered(el)) parts.sort();
  return JSON.stringify([name, attrs, parts]);
}

// The model of a packet's kept properties, one string per property, sorted; null when the
// packet holds something the canonical form cannot carry.
function packetModel(props) {
  const out = [];
  const about = new Set();
  for (const p of props) {
    if (p.kind === 'about') { about.add(trimWs(p.value)); continue; }
    if (p.kind === 'attr') { out.push(`attr|${attrName(p.node, p.attr)}=${trimWs(p.value)}`); continue; }
    if (p.kind === 'elem') { out.push(`elem|${modelOf(p.node)}`); continue; }
    if (p.kind === 'hidden') return null;
  }
  if (about.size > 1) return null;
  for (const a of about) out.push(`about|${a}`);
  return out.sort();
}

const WRAP_BEGIN = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>';
const WRAP_END = '<?xpacket end="w"?>';

// Writes the kept properties in the canonical form, without checking the result. Returns
// the text, or null when the kept properties cannot share one fresh node.
function writeCanonical(kept, compact) {
  const ns = new Map([['x', META], ['rdf', RDF]]);
  const declare = (prefix, uri) => {
    if (prefix === 'xml') return true;
    if (!uri) return !prefix;
    if (!prefix) return false;
    if (ns.has(prefix)) return ns.get(prefix) === uri;
    ns.set(prefix, uri);
    return true;
  };
  // Declares the prefix a kept name is written with (see canonName).
  const declareName = (el, name, attr) => {
    const [p] = splitName(name);
    if (attr && !p) return true;
    const [cp] = splitName(canonName(el, name, attr));
    return declare(cp, nsUri(el, p));
  };
  const walk = (el) => {
    if (!declareName(el, el.name, false)) return false;
    for (const a of el.attrs) {
      if (isNsAttr(a)) continue;
      if (!declareName(el, a.name, true)) return false;
    }
    return elements(el).every(walk);
  };
  let about = null;
  const attrs = new Map();
  const elems = [];
  for (const p of kept) {
    if (p.kind === 'about') {
      const v = trimWs(p.value);
      if (about !== null && about !== v) return null;
      about = v;
      continue;
    }
    if (p.kind === 'attr') {
      const [ap] = splitName(p.attr.name);
      if (!ap || !declareName(p.node, p.attr.name, true)) return null;
      const name = canonName(p.node, p.attr.name, true);
      // One node cannot hold the same attribute twice.
      if (attrs.has(name)) return null;
      attrs.set(name, ` ${name}="${escAttr(trimWs(p.value))}"`);
      continue;
    }
    if (p.kind === 'elem') {
      if (!walk(p.node)) return null;
      elems.push(serialise(p.node));
    }
  }
  const decl = [...ns].filter(([p]) => p !== 'x' && p !== 'rdf').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, u]) => ` xmlns:${p}="${escAttr(u)}"`).join('');
  const attrsText = [...attrs.keys()].sort().map((k) => attrs.get(k)).join('');
  const open = `<rdf:Description rdf:about="${escAttr(about || '')}"${decl}${attrsText}`;
  const body = elems.length ? `${open}>${elems.sort().join('')}</rdf:Description>` : `${open}/>`;
  const core = `<x:xmpmeta xmlns:x="${META}"><rdf:RDF xmlns:rdf="${RDF}">${body}</rdf:RDF></x:xmpmeta>`;
  return compact ? core : `${WRAP_BEGIN}${core}${WRAP_END}`;
}

// Writes a fresh packet holding only the properties whose indices are not in removeIdx,
// in the canonical form. Returns the new packet text, or null when it cannot be written or
// verified (the caller then drops the whole packet). `compact` leaves out the packet
// wrapper. dirPatch changes the Container directory: { index, drop: Set of entry numbers,
// length and padding: Map of entry number to the new value }. Fields of the directory that
// were removed (sub-properties) are left out of it, and a removed directory takes them along.
// add: attributes written with a fixed value, { key, name, node, value }, node being an
// element on which the name's prefix resolves.
//
// The result is checked three ways before it is trusted: read again, it must hold exactly
// the model of the kept properties (and the same directory entries); it must hold nothing
// hidden; and writing it again must give the same text, so the form carries nothing of
// the original's layout.
export function rewriteXmp(parsed, removeIdx, compact = false, dirPatch = null, add = []) {
  if (!parsed.ok) return null;
  const removed = new Set(removeIdx);
  parsed.props.forEach((p, i) => { if (p.kind === 'sub' && removed.has(p.parent)) removed.add(i); });
  const keptPairs = parsed.props.map((p, i) => [p, i]).filter(([p, i]) => !removed.has(i) && p.kind !== 'hidden');
  const nodeOf = new Map();
  for (const [p, i] of keptPairs) {
    if (!p.dir || !p.dir.primary) continue;
    const skip = new Set();
    const patch = new Map();
    // A removed field with a fixed value (a Mime the role does not use) gets that value.
    parsed.props.forEach((x, j) => { if (x.kind === 'sub' && x.parent === i && removed.has(j)) { if (x.fix !== undefined) patch.set(x.ref, x.fix); else skip.add(x.ref); } });
    if (dirPatch && dirPatch.index === i) {
      p.dir.entries.forEach((e, n) => {
        if (dirPatch.drop && dirPatch.drop.has(n)) { skip.add(e.li); return; }
        for (const [field, map] of [['Length', dirPatch.length], ['Padding', dirPatch.padding]]) {
          const f = e.fields[field];
          if (!f || !map || !map.has(n) || String(map.get(n)) === f.value) continue;
          patch.set(f.attr || f.el, map.get(n));
        }
      });
    }
    if (skip.size || patch.size) nodeOf.set(i, directoryClone(p.node, skip, patch));
  }
  const kept = [
    ...keptPairs.filter(([p]) => p.kind !== 'sub').map(([p, i]) => (nodeOf.has(i) ? { ...p, node: nodeOf.get(i), value: valueOf(nodeOf.get(i)) } : p)),
    ...add.map((a) => ({ key: a.key, kind: 'attr', attr: { name: a.name }, node: a.node, value: a.value })),
  ];
  let out;
  let expected;
  try {
    out = writeCanonical(kept, compact);
    if (out === null) return null;
    expected = packetModel(kept);
  } catch {
    return null;
  }
  if (!expected) return null;

  const check = parseXmp(out);
  if (!check.ok || check.opaque || check.props.some((p) => p.kind === 'hidden')) return null;
  let got;
  try { got = packetModel(check.props); } catch { return null; }
  if (!got || got.length !== expected.length || got.some((v, i) => v !== expected[i])) return null;
  // The same directory entries, read the way a gain map reader reads them.
  const dirs = (list) => list.filter((p) => p.kind === 'elem' && p.uri === CONTAINER_URI && p.local === 'Directory').map((p) => {
    const d = parseDirectory(p.node);
    return d.ok ? dirSig(d) : 'unreadable';
  }).sort();
  const wantDirs = dirs(kept);
  const gotDirs = dirs(check.props);
  if (wantDirs.length !== gotDirs.length || wantDirs.some((v, i) => v !== gotDirs[i])) return null;
  // Written again, the packet must not change: the form depends on nothing but the model.
  let again;
  try { again = writeCanonical(check.props.filter((p) => p.kind !== 'sub'), compact); } catch { return null; }
  if (again !== out) return null;
  return out;
}

// The canonical form of a whole packet with nothing removed, or null when it cannot be
// written and verified (the packet is then treated as unreadable).
export function canonicalXmp(parsed, compact = false) {
  if (!parsed || !parsed.ok || parsed.opaque) return null;
  return rewriteXmp(parsed, new Set(), compact);
}

// Pads a rewritten packet with spaces to an exact byte length, inside the packet wrapper
// when there is one, so a container whose size cannot change (HEIC) stays valid.
export function padXmp(text, byteLength) {
  const bytes = encodeUtf8(text);
  if (bytes.length > byteLength) return null;
  const pad = byteLength - bytes.length;
  if (!pad) return bytes;
  const endPi = text.lastIndexOf('<?xpacket end');
  const spaces = ' '.repeat(pad);
  const padded = endPi >= 0 ? text.slice(0, endPi) + spaces + text.slice(endPi) : text + spaces;
  const out = encodeUtf8(padded);
  return out.length === byteLength ? out : null;
}

// Adds the items of one packet to an ItemSet. `internal` is merged into each item's private
// data, so the container module knows which packet an item belongs to. A packet is only
// kept in the canonical form (see rewriteXmp), so one that cannot be written in it and
// verified is unreadable here, red, and never kept as it is. ctx.compact: the packet is
// written without the wrapper. When the canonical form differs from the packet as it is,
// set.normalise is set: keeping everything still changes the file.
export function addXmpItems(set, parsed, ctx, internal, byteSize) {
  const added = [];
  const canon = canonicalXmp(parsed, !!(ctx && ctx.compact));
  if (canon === null) {
    const id = set.add({
      id: 'xmp:packet', group: 'hidden', tier: 'red', label: 'XMP data that could not be read',
      value: `${byteSize} bytes`, source: 'XMP', note: 'It may hold anything, so removing it is the safe choice.',
    }, { ...internal, key: 'packet', props: [] });
    added.push({ id, key: 'packet', props: [] });
    set.normalise = true;
    return added;
  }
  if (canon !== parsed.text || encodeUtf8(canon).length !== byteSize) set.normalise = true;
  for (const it of xmpItems(parsed, ctx)) {
    const pub = { id: `xmp:${it.key}`, group: it.group, tier: it.tier, label: it.label, value: it.value, source: 'XMP' };
    // A second packet's gain map fields are a copy, never the one description a kept gain
    // map keeps, so they get an id of their own and are ticked like any amber detail.
    if (ctx.secondary && it.key === 'gainmap') Object.assign(pub, { id: 'xmp:gainmap-copy', label: 'Another copy of the HDR gain map details' });
    if (it.note) pub.note = it.note;
    const id = set.add(pub, { ...internal, key: it.key, props: it.props });
    added.push({ id, key: it.key, props: it.props });
  }
  return added;
}

export const XMP_HIDDEN_KEPT = 'Hidden text inside XMP was removed although it was not ticked: XMP is always written again in a standard form, which has no room for comments or other text that readers skip.';
export const XMP_UNREADABLE_KEPT = 'XMP data that could not be read was removed although it was not ticked: only XMP data that can be written again in a standard form is kept.';

// Decides what happens to one packet. Returns { action: 'drop' | 'rewrite', text, warning }.
// A packet is never kept as it is: what stays is written again in the canonical form,
// even when nothing in it goes. opts: { dirPatch (see rewriteXmp), rescue: property
// indices kept although their item goes, add (see rewriteXmp), also: property indices
// left out because add writes them again }.
export function planXmp(parsed, packetItems, remove, compact = false, opts = {}) {
  const gone = packetItems.filter((i) => remove.has(i.id));
  const patch = opts.dirPatch || null;
  const unreadable = packetItems.find((i) => i.key === 'packet');
  if (!parsed.ok || parsed.opaque || unreadable) {
    return { action: 'drop', warning: unreadable && !remove.has(unreadable.id) ? XMP_UNREADABLE_KEPT : undefined };
  }
  if (!packetItems.length || (gone.length === packetItems.length && !(opts.rescue && opts.rescue.size))) return { action: 'drop' };
  const idx = new Set(gone.flatMap((i) => i.props));
  for (const r of opts.rescue || []) idx.delete(r);
  // also: properties written again with a new value (they come back through add).
  for (const r of opts.also || []) idx.add(r);
  const text = rewriteXmp(parsed, idx, compact, patch, opts.add || []);
  if (text === null) {
    return { action: 'drop', warning: 'The XMP data could not be edited safely, so all of it was removed instead.' };
  }
  // Comments and other text readers skip cannot survive the canonical form.
  const hidden = packetItems.find((i) => i.key === 'hidden' && !remove.has(i.id));
  const warning = hidden ? XMP_HIDDEN_KEPT : undefined;
  return { action: 'rewrite', text, same: text === parsed.text, warning };
}

// Keeps only the properties a test accepts (for example the gain map's own hdrgm values).
// Returns the new packet text, or null when nothing is kept or it cannot be verified.
export function keepOnlyXmp(parsed, test, add = []) {
  if (!parsed.ok || parsed.opaque) return null;
  const remove = new Set();
  let keptAny = false;
  parsed.props.forEach((p, i) => { if (p.kind !== 'about' && p.kind !== 'hidden' && p.kind !== 'sub' && test(p, i)) keptAny = true; else remove.add(i); });
  return keptAny ? rewriteXmp(parsed, remove, true, null, add) : null;
}

// An empty but valid packet of an exact byte length, for containers whose size cannot change.
export function emptyXmp(byteLength) {
  const head = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/>';
  return padXmp(`${head}<?xpacket end="w"?>`, byteLength);
}

// Packets found in IRB resources and PNG text are sometimes UTF-16 or carry a BOM; this
// returns plain text.
export function xmpText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  return utf8(bytes);
}
