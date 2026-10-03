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

import { clip, encodeUtf8, utf8 } from './bytes.js?v=b373c219';
import { keyForTagName } from './tiff.js?v=05d71c42';

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
const blank = (s) => /^[\s\0﻿]*$/.test(s);

// Builds an element tree with source positions. Throws on malformed input, and on
// nesting deeper than any real packet needs (a crafted file must not exhaust the stack).
export function parseXml(s) {
  const root = { name: '#root', attrs: [], children: [], start: 0, end: s.length, parent: null, depth: 0, comments: [], pis: [] };
  let cur = root;
  let p = 0;
  const addText = (a, b) => { if (b > a) cur.children.push({ text: decodeEntities(s.slice(a, b)), start: a, end: b }); };
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
      cur.children.push({ text: s.slice(lt + 9, e), start: lt, end: e + 3 });
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
      attrs.push({ name: aname, value: decodeEntities(raw), start: wsStart, end: e + 1 });
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

// Parses an XMP packet. Returns { ok, text, props, hasRdf } where each prop is
// { key: 'prefix:Local', prefix, local, kind, value, start, end } and kind is 'attr',
// 'elem', 'about', 'toolkit' or 'hidden' (comments and stray text).
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
  for (const pi of root.pis) if (pi.target !== 'xpacket') hide(pi.text);

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
        if (q.uri === META && (q.local === 'xmptk' || q.local === 'xaptk')) {
          props.push({ key: 'x:xmptk', prefix: 'x', local: q.local, kind: 'toolkit', value: a.value, start: a.start, end: a.end, attr: a, node: w });
        } else hide(`${a.name}=${a.value}`);
      }
      for (const el of elements(w)) if (el !== rdf && !chain.includes(el)) hide(valueOf(el) || el.name);
    }
  }
  if (rdf) {
    outerText(rdf);
    for (const a of rdf.attrs) if (!isNsAttr(a)) hide(`${a.name}=${a.value}`);
    for (const d of elements(rdf)) {
      outerText(d);
      for (const a of d.attrs) {
        if (isNsAttr(a) || a.name.startsWith('xml:')) continue;
        const q = qualify(d, a.name);
        if (q.uri === RDF) {
          if ((q.local === 'about' || q.local === 'ID' || q.local === 'nodeID') && !blank(a.value)) {
            props.push({ key: 'rdf:about', prefix: 'rdf', local: q.local, kind: 'about', value: a.value, start: a.start, end: a.end, attr: a, node: d });
          }
          continue;
        }
        props.push({ key: `${q.prefix}:${q.local}`, prefix: q.prefix, local: q.local, kind: 'attr', value: a.value, start: a.start, end: a.end, attr: a, node: d });
      }
      for (const c of elements(d)) {
        const q = qualify(c, c.name);
        props.push({ key: `${q.prefix}:${q.local}`, prefix: q.prefix, local: q.local, kind: 'elem', value: valueOf(c), start: wsBefore(text, c.start), end: c.end, node: c });
      }
    }
  }
  if (hidden.length) props.push({ key: 'xml:hidden', prefix: 'xml', local: 'hidden', kind: 'hidden', value: hidden.join(' / '), start: -1, end: -1 });
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
  history: { group: 'hidden', tier: 'amber', label: 'Edit history', note: 'Can list earlier versions, editing steps and file names.' },
  motion: { group: 'hidden', tier: 'amber', label: 'Motion Photo details', note: 'Points to the video clip stored after the picture.' },
  gainmap: { group: 'hidden', tier: 'amber', label: 'HDR gain map details', note: 'Describes the extra brightness image used on HDR screens.' },
  extended: { group: 'hidden', tier: 'red', label: 'Extra XMP data' },
  description: { group: 'hidden', tier: 'amber', label: 'Title, description and keywords' },
  hidden: { group: 'hidden', tier: 'red', label: 'Hidden text inside XMP', note: 'Comments and other text that XMP readers skip. It can still hold names or notes.' },
  other: { group: 'hidden', tier: 'red', label: 'Unrecognised XMP data', note: 'Fields this tool does not recognise. They may hold anything, so they are removed by default.' },
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
    'exif:DateTimeDigitized', 'tiff:DateTime', 'dc:date', 'Iptc4xmpCore:DateCreated', 'MicrosoftPhoto:DateAcquired'],
  camera: ['tiff:Make', 'tiff:Model', 'aux:Lens', 'aux:LensInfo', 'aux:LensID', 'aux:Firmware', 'exifEX:LensMake',
    'exifEX:LensModel', 'exifEX:LensSpecification', 'MicrosoftPhoto:LensManufacturer', 'MicrosoftPhoto:LensModel'],
  software: ['xmp:CreatorTool', 'tiff:Software', 'x:xmptk', 'pdf:Producer'],
  computer: ['tiff:HostComputer', 'exif:HostComputer', 'exifEX:HostComputer'],
  ids: ['xmpMM:DocumentID', 'xmpMM:InstanceID', 'xmpMM:OriginalDocumentID', 'exif:ImageUniqueID', 'exifEX:ImageUniqueID',
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
    'photoshop:EmbeddedXMPDigest', 'photoshop:LegacyIPTCDigest', 'photoshop:SidecarForExtension', 'tiff:NativeDigest',
    'exif:NativeDigest', 'GCamera:BurstPrimary'],
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

function rawKey(p) {
  if (p.kind === 'hidden') return 'hidden';
  const named = KEY_OF.get(p.key);
  if (named) return named;
  if ((p.prefix === 'exif' || p.prefix === 'exifEX') && p.local.startsWith('GPS')) return 'gps';
  if (p.prefix === 'xmpRights' || p.prefix === 'plus') return 'rights';
  if (p.prefix === 'mwg-rs') return 'people';
  if (p.prefix === 'crs') return 'history';
  if (p.prefix === 'GCamera' && /^(MotionPhoto|MicroVideo)/.test(p.local)) return 'motion';
  if (p.prefix === 'Container') return 'container';
  if (p.prefix === 'hdrgm' || p.prefix === 'HDRGainMap') return 'gainmap';
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
      thumbnail: 'thumbnail', other: 'camera',
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
  if (key === 'other') {
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

// Groups the properties of a parsed packet into items.
// ctx: { motionTier, gainMapTier, extended: { label, value, tier, note } | null }
export function xmpItems(parsed, ctx = {}) {
  const buckets = new Map();
  const hasMotion = ctx.motionTier || parsed.props.some((p) => rawKey(p) === 'motion');
  const hasGain = ctx.gainMapTier || parsed.props.some((p) => rawKey(p) === 'gainmap');
  parsed.props.forEach((p, i) => {
    let key = rawKey(p);
    if (key === 'container') key = hasMotion ? 'motion' : hasGain ? 'gainmap' : 'other';
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
    if (key === 'extended') Object.assign(item, ctx.extended);
    items.push(item);
  }
  return items;
}

// ======================================================================================
// Rewriting

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

// Serialises an element subtree from the parsed tree: no comments, no processing
// instructions, no namespace declarations (they are gathered on the new node instead).
function serialise(el) {
  let attrs = '';
  for (const a of el.attrs) if (!isNsAttr(a)) attrs += ` ${a.name}="${escAttr(a.value)}"`;
  if (!el.children.length) return `<${el.name}${attrs}/>`;
  let inner = '';
  for (const k of el.children) inner += k.name === undefined ? escText(k.text) : serialise(k);
  return `<${el.name}${attrs}>${inner}</${el.name}>`;
}

// Writes a fresh packet holding only the properties whose indices are not in removeIdx.
// Returns the new packet text, or null when it cannot be written or verified (the caller
// then drops the whole packet). `compact` leaves out the packet wrapper and indentation.
export function rewriteXmp(parsed, removeIdx, compact = false) {
  if (!parsed.ok) return null;
  const kept = parsed.props.map((p, i) => [p, i]).filter(([p, i]) => !removeIdx.has(i) && p.kind !== 'hidden').map(([p]) => p);
  const ns = new Map([['x', META], ['rdf', RDF]]);
  const declare = (prefix, uri) => {
    if (prefix === 'xml') return true;
    if (!uri) return !prefix;
    if (ns.has(prefix)) return ns.get(prefix) === uri;
    ns.set(prefix, uri);
    return true;
  };
  const walk = (el) => {
    const [p] = splitName(el.name);
    if (!declare(p, nsUri(el, p))) return false;
    for (const a of el.attrs) {
      if (isNsAttr(a)) continue;
      const [ap] = splitName(a.name);
      if (ap && !declare(ap, nsUri(el, ap))) return false;
    }
    return elements(el).every(walk);
  };
  let about = '';
  let toolkit = '';
  const attrProps = [];
  const elemProps = [];
  for (const p of kept) {
    if (p.kind === 'about') { about = p.value; continue; }
    if (p.kind === 'toolkit') { toolkit = p.value; continue; }
    if (p.kind === 'attr') {
      const [ap] = splitName(p.attr.name);
      if (!ap || !declare(ap, nsUri(p.node, ap))) return null;
      attrProps.push(p);
      continue;
    }
    if (p.kind === 'elem') {
      if (!walk(p.node)) return null;
      elemProps.push(p);
    }
  }
  const nl = compact ? '' : '\n';
  const ind = (n) => (compact ? '' : ' '.repeat(n));
  const decl = [...ns].filter(([p]) => p !== 'x' && p !== 'rdf').map(([p, u]) => ` xmlns:${p}="${escAttr(u)}"`).join('');
  const attrsText = attrProps.map((p) => ` ${p.attr.name}="${escAttr(p.value)}"`).join('');
  const open = `<rdf:Description rdf:about="${escAttr(about)}"${decl}${attrsText}`;
  const body = elemProps.length
    ? `${open}>${nl}${elemProps.map((p) => ind(3) + serialise(p.node)).join(nl)}${nl}${ind(2)}</rdf:Description>`
    : `${open}/>`;
  const xmptk = toolkit ? ` x:xmptk="${escAttr(toolkit)}"` : '';
  const core = `<x:xmpmeta xmlns:x="${META}"${xmptk}>${nl}${ind(1)}<rdf:RDF xmlns:rdf="${RDF}">${nl}${ind(2)}${body}${nl}${ind(1)}</rdf:RDF>${nl}</x:xmpmeta>`;
  const out = compact ? core : `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n${core}\n<?xpacket end="w"?>`;

  const check = parseXmp(out);
  if (!check.ok || check.props.some((p) => p.kind === 'hidden')) return null;
  const sig = (list) => list.map((p) => `${p.key}\u0000${p.value}`).sort();
  const a = sig(kept);
  const b = sig(check.props);
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) return null;
  return out;
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
// data, so the container module knows which packet an item belongs to.
export function addXmpItems(set, parsed, ctx, internal, byteSize) {
  const added = [];
  if (!parsed.ok || parsed.opaque) {
    const id = set.add({
      id: 'xmp:packet', group: 'hidden', tier: 'red', label: 'XMP data that could not be read',
      value: `${byteSize} bytes`, source: 'XMP', note: 'It may hold anything, so removing it is the safe choice.',
    }, { ...internal, key: 'packet', props: [] });
    added.push({ id, key: 'packet', props: [] });
    return added;
  }
  for (const it of xmpItems(parsed, ctx)) {
    const pub = { id: `xmp:${it.key}`, group: it.group, tier: it.tier, label: it.label, value: it.value, source: 'XMP' };
    if (it.note) pub.note = it.note;
    const id = set.add(pub, { ...internal, key: it.key, props: it.props });
    added.push({ id, key: it.key, props: it.props });
  }
  return added;
}

// Decides what happens to one packet. Returns { action: 'keep' | 'drop' | 'rewrite', text, warning }.
export function planXmp(parsed, packetItems, remove, compact = false) {
  const gone = packetItems.filter((i) => remove.has(i.id));
  if (!gone.length) return { action: 'keep' };
  if (gone.length === packetItems.length || !parsed.ok || parsed.opaque || gone.some((i) => i.key === 'packet')) return { action: 'drop' };
  const idx = new Set(gone.flatMap((i) => i.props));
  if (!idx.size) return { action: 'keep' };
  const text = rewriteXmp(parsed, idx, compact);
  if (text === null) {
    return { action: 'drop', warning: 'The XMP data could not be edited safely, so all of it was removed instead.' };
  }
  return { action: 'rewrite', text };
}

// Keeps only the properties a test accepts (for example the gain map's own hdrgm values).
// Returns the new packet text, or null when nothing is kept or it cannot be verified.
export function keepOnlyXmp(parsed, test) {
  if (!parsed.ok || parsed.opaque) return null;
  const remove = new Set();
  let keptAny = false;
  parsed.props.forEach((p, i) => { if (p.kind !== 'about' && p.kind !== 'hidden' && test(p)) keptAny = true; else remove.add(i); });
  return keptAny ? rewriteXmp(parsed, remove, true) : null;
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
