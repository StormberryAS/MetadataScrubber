// Engine tests for src/scrub-core.js. Run from the repository root with: node --test tests/
//
// Every picture is generated here (see core-fixtures.mjs). Each format is checked the same
// way: inspect() finds the planted items with the right tiers; scrubbing the red items
// removes them (checked with exiftool and by searching the bytes for planted strings);
// scrubbing every item leaves nothing but structure; decoded pixels never change; and
// exiftool -validate reports nothing new.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';

import * as core from '../src/scrub-core.js';
import { parseTiff, removeTiffKeys } from '../src/core/tiff.js';
import { addXmpItems, parseXmp, planXmp, rewriteXmp } from '../src/core/xmp.js';
import { walkJpeg } from '../src/core/jpeg.js';
import { ItemSet } from '../src/core/taxonomy.js';
import * as F from './core-fixtures.mjs';

const { PLANT } = F;

const contains = (bytes, s) => Buffer.from(bytes).includes(Buffer.from(s, 'latin1'));
const ids = (info) => info.items.map((i) => i.id);
const tierOf = (info, id) => info.items.find((i) => i.id === id)?.tier;
const reds = (info) => info.items.filter((i) => i.tier === 'red').map((i) => i.id);
const hasTag = (rows, group, tag) => rows.some((r) => (group instanceof RegExp ? group.test(r.group) : r.group === group) && r.tag === tag);

const PNG_IHDR = new Set(['ImageWidth', 'ImageHeight', 'BitDepth', 'ColorType', 'Compression', 'Filter', 'Interlace']);
const RIFF_STRUCT = new Set(['WebP_Flags', 'ImageWidth', 'ImageHeight', 'VP8Version', 'HorizontalScale', 'VerticalScale',
  'AlphaPreprocessing', 'AlphaFiltering', 'AlphaCompression']);

// exiftool rows that are metadata rather than structure.
function metadataLeft(rows, format) {
  return rows.filter((r) => {
    if (r.group === 'ExifTool' || r.group === 'System') return false;
    if (r.group === 'File') return r.tag === 'Comment' || r.tag === 'CurrentIPTCDigest' || (r.tag === 'ExifByteOrder' && format !== 'heic');
    if (r.group === 'Composite') return !['ImageSize', 'Megapixels'].includes(r.tag);
    if (format === 'png' && r.group === 'PNG') return !PNG_IHDR.has(r.tag);
    if (format === 'webp' && r.group === 'RIFF') return !RIFF_STRUCT.has(r.tag);
    if (format === 'heic' && (r.group === 'QuickTime' || r.group === 'Meta')) return false;
    return true;
  });
}

async function scrubTo(outName, bytes, removeIds) {
  const before = Buffer.from(bytes);
  const res = await core.scrub(bytes, removeIds);
  assert.ok(before.equals(Buffer.from(bytes)), 'the input buffer must not be changed');
  F.write(outName, res.bytes);
  return res;
}

function noNewWarnings(inName, outName) {
  const before = new Set(F.validate(F.path(inName)));
  const after = F.validate(F.path(outName)).filter((w) => !before.has(w));
  assert.deepEqual(after, [], `exiftool -validate reports new problems for ${outName}`);
}

function samePixels(...names) {
  const hashes = F.decodeHashes(names.map((n) => F.path(n)));
  for (const h of hashes) assert.ok(h, 'picture must decode');
  assert.equal(new Set(hashes).size, 1, `decoded pixels differ between ${names.join(', ')}`);
}

// Shared checks for one fixture: red default, then everything.
async function standardChecks(name, format, { redStrings = [], keptStrings = [], redTags = [], keptTags = [] }) {
  const input = F.read(name);
  const info = await core.inspect(input);
  assert.equal(info.format, format);
  for (const s of [...redStrings, ...keptStrings]) assert.ok(contains(input, s), `fixture should contain "${s}"`);

  const base = name.replace(/\.\w+$/, '');
  const ext = name.split('.').pop();
  const redOut = `${base}.out-red.${ext}`;
  const res = await scrubTo(redOut, input, reds(info));
  const out = F.read(redOut);
  const back = await core.inspect(out);
  assert.deepEqual(reds(back), [], `red items left in ${redOut}: ${reds(back).join(', ')}`);
  assert.equal(core.privacyWord(back.items), back.items.some((i) => i.tier === 'amber') ? 'public' : 'minimal');
  for (const s of redStrings) assert.ok(!contains(out, s), `"${s}" must be gone from ${redOut}`);
  for (const s of keptStrings) assert.ok(contains(out, s), `"${s}" must be kept in ${redOut}`);
  const rows = F.exifRead(F.path(redOut));
  for (const [g, t] of redTags) assert.ok(!hasTag(rows, g, t), `${g}:${t} must be gone from ${redOut}`);
  for (const [g, t] of keptTags) assert.ok(hasTag(rows, g, t), `${g}:${t} must be kept in ${redOut}`);
  samePixels(name, redOut);
  noNewWarnings(name, redOut);

  const allOut = `${base}.out-all.${ext}`;
  await scrubTo(allOut, input, ids(info));
  const outAll = F.read(allOut);
  const backAll = await core.inspect(outAll);
  assert.deepEqual(ids(backAll), [], `items left after removing everything: ${ids(backAll).join(', ')}`);
  assert.equal(core.privacyWord(backAll.items), 'clean');
  const left = metadataLeft(F.exifRead(F.path(allOut)), format);
  assert.deepEqual(left.map((r) => `${r.group}:${r.tag}`), [], `exiftool still sees metadata in ${allOut}`);
  for (const s of [...redStrings, ...keptStrings]) assert.ok(!contains(outAll, s), `"${s}" must be gone from ${allOut}`);
  samePixels(name, allOut);
  noNewWarnings(name, allOut);
  return { info, res, back };
}

// ======================================================================================

describe('contract basics', () => {
  test('detectFormat recognises the four formats and nothing else', () => {
    assert.equal(core.detectFormat(F.read(F.jpegFull())), 'jpeg');
    assert.equal(core.detectFormat(F.read(F.pngFull())), 'png');
    assert.equal(core.detectFormat(F.read(F.webpFull())), 'webp');
    assert.equal(core.detectFormat(F.read(F.heicExiftool())), 'heic');
    F.magick(['-size', '16x16', 'xc:red', F.path('x.gif')]);
    F.magick(['-size', '16x16', 'xc:red', F.path('x.tif')]);
    F.magick(['-size', '16x16', 'xc:red', F.path('x.avif')]);
    for (const n of ['x.gif', 'x.tif', 'x.avif']) assert.equal(core.detectFormat(F.read(n)), null, n);
    assert.equal(core.detectFormat(new Uint8Array([1, 2, 3])), null);
    assert.equal(core.detectFormat(new Uint8Array(0)), null);
  });

  test('inspect rejects unsupported files clearly', async () => {
    await assert.rejects(() => core.inspect(F.read('x.gif')), /not supported/);
  });

  test('GROUPS and TIERS are complete', () => {
    assert.deepEqual(core.GROUPS.map((g) => g.id), ['where', 'who', 'when', 'device', 'hidden', 'technical']);
    assert.deepEqual(core.GROUPS.map((g) => g.label), ['Where', 'Who', 'When', 'Device', 'Hidden extras', 'Technical']);
    for (const t of ['red', 'amber', 'green']) assert.ok(core.TIERS[t].label && core.TIERS[t].description);
  });

  test('privacyWord follows the tier rules', () => {
    assert.equal(core.privacyWord([]), 'clean');
    assert.equal(core.privacyWord([{ tier: 'green' }]), 'minimal');
    assert.equal(core.privacyWord([{ tier: 'green' }, { tier: 'amber' }]), 'public');
    assert.equal(core.privacyWord([{ tier: 'amber' }, { tier: 'red' }]), 'custom');
  });

  test('scrub with no ids returns an identical copy', async () => {
    const b = F.read(F.jpegFull());
    const res = await core.scrub(b, []);
    assert.ok(Buffer.from(res.bytes).equals(Buffer.from(b)));
    assert.notEqual(res.bytes, b);
  });

  test('item text has no em dashes or double hyphens', async () => {
    for (const n of [F.jpegFull(), F.jpegMotion(), F.pngFull(), F.webpFull(), F.heicExiftool()]) {
      const info = await core.inspect(F.read(n));
      for (const i of info.items) {
        for (const field of ['label', 'note']) {
          const v = i[field] || '';
          assert.ok(!v.includes('\u2014') && !v.includes('-' + '-'), `${i.id} ${field}: ${v}`);
        }
        assert.ok(i.value.length <= 80, `${i.id} value too long`);
        assert.ok(core.GROUPS.some((g) => g.id === i.group), `${i.id} group`);
        assert.ok(core.TIERS[i.tier], `${i.id} tier`);
      }
      assert.equal(new Set(ids(info)).size, info.items.length, 'ids must be unique');
    }
  });
});

// ======================================================================================

describe('TIFF engine, in place', () => {
  test('removing a tag shifts entries, rewrites the next pointer and zeroes freed bytes', () => {
    const t = F.tiffBlock({
      ifd0: [[0x010f, 2, 0, 'MakeAAAA'], [0x0131, 2, 0, 'SoftwareBBBB'], [0x013b, 2, 0, 'ArtistCCCC']],
    });
    const before = Buffer.from(t);
    const m = parseTiff(t);
    const ifd0 = m.ifds.ifd0;
    const artist = ifd0.entries.find((e) => e.tag === 0x013b);
    const software = ifd0.entries.find((e) => e.tag === 0x0131);
    const res = removeTiffKeys(m, new Set(['software']));
    assert.equal(res.empty, false);
    const after = Buffer.from(t);
    assert.equal(after.readUInt16BE(ifd0.offset), 2, 'count decremented');
    assert.equal(after.readUInt16BE(ifd0.offset + 2), 0x010f);
    assert.equal(after.readUInt16BE(ifd0.offset + 2 + 12), 0x013b, 'later entry shifted up');
    assert.equal(after.readUInt32BE(ifd0.offset + 2 + 24), 0, 'next pointer at new position');
    assert.ok(after.subarray(ifd0.offset + 2 + 24 + 4, ifd0.offset + 2 + 36 + 4).every((x) => x === 0), 'freed bytes zeroed');
    assert.ok(after.subarray(software.valueOffset, software.valueOffset + software.size).every((x) => x === 0), 'value zeroed');
    assert.ok(after.subarray(artist.valueOffset, artist.valueOffset + artist.size).equals(before.subarray(artist.valueOffset, artist.valueOffset + artist.size)), 'kept value untouched');
    assert.ok(!contains(after, 'SoftwareBBBB'));
    const again = parseTiff(t);
    assert.deepEqual(again.ifds.ifd0.entries.map((e) => e.tag), [0x010f, 0x013b]);
  });

  test('a value shared by a kept tag is not zeroed', () => {
    const t = F.tiffBlock({ ifd0: [[0x013b, 2, 22, 'SHARED:n'], [0x010e, 2, 22, 'SHARED:n']], shared: { n: 'Shared Name Plant 22\0\0' } });
    const m = parseTiff(t);
    removeTiffKeys(m, new Set(['owner']));
    const m2 = parseTiff(t);
    assert.deepEqual(m2.ifds.ifd0.entries.map((e) => e.tag), [0x010e]);
    assert.ok(contains(t, 'Shared Name Plant 22'));
  });

  test('removing the GPS item zeroes the whole GPS directory and drops its pointer', () => {
    const t = F.tiffBlock({ ifd0: [[0x010f, 2, 0, 'Make']], gps: [[0x0001, 2, 2, 'N'], [0x001c, 7, 14, Buffer.from('GPS-AREA-PLANT', 'latin1')]] });
    const m = parseTiff(t);
    const gps = m.ifds.gps;
    removeTiffKeys(m, new Set(['gps']));
    assert.ok(Buffer.from(t).subarray(gps.offset, gps.offset + 2 + gps.count * 12 + 4).every((x) => x === 0));
    assert.ok(!contains(t, 'GPS-AREA-PLANT'));
    const m2 = parseTiff(t);
    assert.equal(m2.ifds.gps, undefined);
    assert.deepEqual(m2.ifds.ifd0.entries.map((e) => e.tag), [0x010f]);
  });

  test('removing everything reports an empty block', () => {
    const t = F.tiffBlock({ ifd0: [[0x010f, 2, 0, 'Make']], exif: [[0x9003, 2, 0, '2026:09:14 10:15:23']] });
    const m = parseTiff(t);
    assert.equal(removeTiffKeys(m, new Set(['camera', 'datetime'])).empty, true);
  });
});

describe('XMP scanner', () => {
  const packet = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:e="http://ns.adobe.com/exif/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
  e:GPSLatitude="48,51.504N" e:GPSLongitude="2,17.67E" xmp:CreateDate="2026-09-14T10:15:23">
  <dc:creator><rdf:Seq><rdf:li>Alice &amp; Bob</rdf:li></rdf:Seq></dc:creator>
  <dc:title><rdf:Alt><rdf:li xml:lang="x-default">A title</rdf:li></rdf:Alt></dc:title>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

  test('reads attribute and element properties with odd prefixes', () => {
    const p = parseXmp(packet);
    assert.ok(p.ok);
    const keys = p.props.map((x) => x.key);
    assert.deepEqual(keys, ['exif:GPSLatitude', 'exif:GPSLongitude', 'xmp:CreateDate', 'dc:creator', 'dc:title']);
    assert.equal(p.props.find((x) => x.key === 'dc:creator').value, 'Alice & Bob');
  });

  test('rewrites a fresh packet from the kept properties and verifies it', () => {
    const p = parseXmp(packet.replace('<dc:title>', '<!-- Old owner: Carol -->\n  <dc:title>'));
    const hidden = p.props.findIndex((x) => x.kind === 'hidden');
    assert.ok(hidden >= 0, 'the comment is offered');
    const out = rewriteXmp(p, new Set([0, 1, 3]));
    assert.ok(out);
    const q = parseXmp(out);
    assert.deepEqual(q.props.map((x) => x.key), ['xmp:CreateDate', 'dc:title']);
    assert.ok(!out.includes('Alice') && !out.includes('48,51') && !out.includes('Carol'), 'removed values and comments are gone');
  });

  test('typed nodes, rdf:about and unmapped namespaces are all offered', () => {
    const t = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="uuid:ABOUT-PLANT" xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" drone-dji:GpsLatitude="+59.9" drone-dji:DroneSerialNumber="DRONE-PLANT" xmlns:v="http://example.com/v/" v:Mystery="MYSTERY-PLANT"/>
<photoshop:Thing rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:City="TYPED-CITY-PLANT"/>
</rdf:RDF></x:xmpmeta>`;
    const set = new ItemSet();
    addXmpItems(set, parseXmp(t), {}, {}, t.length);
    const tier = (id) => set.items.find((i) => i.id === id)?.tier;
    assert.equal(tier('xmp:gps'), 'red');
    assert.equal(tier('xmp:serial'), 'red');
    assert.equal(tier('xmp:place'), 'red');
    assert.equal(tier('xmp:ids'), 'red');
    assert.equal(tier('xmp:other'), 'red', 'unrecognised data is red');
  });

  test('a packet with no RDF root or too deep nesting is one red item', () => {
    for (const t of ['<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?}<x:xmpmeta xmlns:x="adobe:ns:meta/"><a>NAME</a></x:xmpmeta><?xpacket end="w"?>',
      `<x:xmpmeta xmlns:x="adobe:ns:meta/">${'<a>'.repeat(5000)}NAME${'</a>'.repeat(5000)}</x:xmpmeta>`]) {
      const set = new ItemSet();
      addXmpItems(set, parseXmp(t), {}, {}, t.length);
      assert.deepEqual(set.items.map((i) => `${i.tier}:${i.id}`), ['red:xmp:packet']);
    }
  });

  test('malformed XMP is reported as unreadable, not trusted', () => {
    assert.equal(parseXmp('<x:xmpmeta><rdf:RDF><rdf:Description a="1"></rdf:RDF>').ok, false);
  });

  test('a rewrite that cannot be verified drops the whole packet and says so', () => {
    // One prefix bound to two namespaces in two nodes cannot share one fresh node.
    const p = parseXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:a="http://ns.adobe.com/exif/1.0/" a:GPSLatitude="48,51.504N"/>
<rdf:Description rdf:about="" xmlns:a="http://ns.adobe.com/xap/1.0/" a:CreateDate="2026"/>
<rdf:Description rdf:about="" xmlns:a="http://purl.org/dc/elements/1.1/"><a:title>T</a:title></rdf:Description>
</rdf:RDF></x:xmpmeta>`);
    const items = [{ id: 'xmp:gps', props: [0] }, { id: 'xmp:dates', props: [1] }, { id: 'xmp:description', props: [2] }];
    const plan = planXmp(p, items, new Set(['xmp:gps']));
    assert.equal(plan.action, 'drop');
    assert.match(plan.warning, /could not be edited safely/);
  });
});

// ======================================================================================

describe('JPEG', () => {
  test('full fixture: planted items, tiers, values', async () => {
    const info = await core.inspect(F.read(F.jpegFull()));
    assert.equal(info.width, 320);
    assert.equal(info.height, 240);
    assert.equal(info.orientation, 6);
    const expect = {
      'exif:gps': 'red', 'exif:owner': 'red', 'exif:serial': 'red', 'exif:lens-serial': 'red', 'exif:unique-id': 'red',
      'exif:thumbnail': 'red', 'exif:copyright': 'red', 'exif:computer': 'red', 'exif:datetime': 'amber', 'exif:timezone': 'amber',
      'exif:camera': 'amber', 'exif:lens': 'amber', 'exif:software': 'amber', 'exif:description': 'amber',
      'exif:orientation': 'green', 'exif:exposure': 'green', 'exif:resolution': 'green',
      'xmp:creator': 'red', 'xmp:place': 'red', 'xmp:ids': 'red', 'xmp:serial': 'red', 'xmp:gps': 'red', 'xmp:rights': 'red',
      'xmp:dates': 'amber', 'xmp:history': 'amber', 'xmp:software': 'amber', 'xmp:camera': 'amber', 'xmp:description': 'amber',
      'xmp:copyright': 'red', 'xmp:technical': 'green',
      'iptc:byline': 'red', 'iptc:place': 'red', 'iptc:contact': 'red', 'iptc:credit': 'red', 'iptc:copyright': 'red',
      'iptc:caption': 'amber', 'iptc:keywords': 'amber', 'iptc:dates': 'amber', 'iptc:instructions': 'amber',
      'icc:profile': 'green', 'jpeg:comment': 'amber', 'jpeg:jfif': 'green', 'jpeg:c2pa': 'amber', 'jpeg:adobe': 'green',
      'jpeg:app9:acmecam': 'red', 'jpeg:trailing:unknown': 'red', 'irb:thumbnail': 'red',
    };
    for (const [id, tier] of Object.entries(expect)) assert.equal(tierOf(info, id), tier, id);
    const v = (id) => info.items.find((i) => i.id === id).value;
    assert.equal(v('exif:gps'), '48.8584 N, 2.2945 E, altitude 35 m');
    assert.equal(v('exif:orientation'), 'Turned 90° clockwise');
    assert.equal(v('exif:datetime'), '2026-09-14 10:15:23');
    assert.equal(v('exif:camera'), PLANT.model);
    // The computer name is its own red item (decision of 2026-10-02); editing software stays amber.
    const item = (id) => info.items.find((i) => i.id === id);
    assert.deepEqual([item('exif:computer').label, item('exif:computer').group, v('exif:computer')], ['Computer name', 'who', PLANT.computer]);
    assert.deepEqual([item('exif:software').label, item('exif:software').group, v('exif:software')], ['Editing software', 'device', PLANT.software]);
    assert.match(v('exif:thumbnail'), /^160 × 120 pixels/);
    assert.match(v('icc:profile'), /Adobe RGB \(1998\)/);
    assert.match(v('jpeg:app9:acmecam'), /^ACMECAM/);
    assert.equal(v('exif:exposure'), '1/125 s, f/1.9, ISO 100, 6.8 mm');
    const c2pa = info.items.find((i) => i.id === 'jpeg:c2pa');
    assert.equal(c2pa.label, 'Content Credentials (C2PA)');
    assert.match(c2pa.note, /proof of where the image came from/);
    assert.equal(info.items.find((i) => i.id === 'exif:thumbnail').note, 'Can still show the original, uncropped photo after cropping.');
  });

  test('full fixture: red default, everything, pixels and validity', async () => {
    const { res } = await standardChecks(F.jpegFull(), 'jpeg', {
      redStrings: [PLANT.artist, PLANT.owner, PLANT.serial, PLANT.lensSerial, PLANT.uniqueId, PLANT.xmpCreator, PLANT.xmpCity,
        PLANT.xmpDocId, PLANT.xmpAuxSerial, PLANT.iptcByline, PLANT.iptcCity, PLANT.iptcContact, PLANT.unknownApp, PLANT.trailing,
        'GPS-AREA-PLANT', 'Xmp Rightsowner', PLANT.copyright, 'Iptc credit line', 'Iptc copyright notice', PLANT.computer],
      keptStrings: [PLANT.make, PLANT.software, PLANT.description, PLANT.comment, 'FakeCam C2PA PLANT'],
      redTags: [['GPS', 'GPSLatitude'], ['GPS', 'GPSAreaInformation'], ['IFD0', 'Artist'], ['ExifIFD', 'OwnerName'],
        ['ExifIFD', 'SerialNumber'], ['ExifIFD', 'LensSerialNumber'], ['ExifIFD', 'ImageUniqueID'], ['IFD1', 'ThumbnailImage'],
        ['XMP-dc', 'Creator'], ['XMP-photoshop', 'City'], ['XMP-xmpMM', 'DocumentID'], ['XMP-aux', 'SerialNumber'],
        ['XMP-exif', 'GPSLatitude'], ['XMP-xmpRights', 'Owner'], ['IPTC', 'By-line'], ['IPTC', 'City'], ['IPTC', 'Contact'],
        ['Photoshop', 'PhotoshopThumbnail'], ['IFD0', 'Copyright'], ['IPTC', 'Credit'], ['IPTC', 'CopyrightNotice'], ['IFD0', 'HostComputer']],
      keptTags: [['IFD0', 'Make'], ['IFD0', 'Software'], ['IFD0', 'Orientation'], ['ExifIFD', 'DateTimeOriginal'],
        ['ExifIFD', 'OffsetTimeOriginal'], ['XMP-xmp', 'CreateDate'], ['XMP-xmpMM', 'HistoryAction'],
        ['File', 'Comment'], ['ICC_Profile', 'ProfileDescription'], ['JUMBF', 'JUMDLabel'], ['Adobe', 'DCTEncodeVersion'],
        ['JFIF', 'JFIFVersion']],
    });
    assert.ok(res.warnings.some((w) => /Content Credentials were kept/.test(w)), 'warns that kept C2PA no longer verifies');
  });

  test('a comment holding FF D9 bytes does not end the walk early', async () => {
    const b = F.read(F.jpegFull());
    const w = walkJpeg(b);
    const eoi = w.segs.find((s) => s.kind === 'eoi');
    assert.ok(eoi);
    assert.equal(Buffer.from(b).subarray(eoi.end).toString('latin1').startsWith(PLANT.trailing), true);
  });

  test('progressive JPEG with little-endian EXIF and trailing data', async () => {
    const name = F.jpegProgressive();
    const b = F.read(name);
    assert.ok(walkJpeg(b).segs.filter((s) => s.kind === 'sos').length > 1, 'several scans');
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'jpeg:trailing:unknown'), 'red');
    await standardChecks(name, 'jpeg', {
      redStrings: [PLANT.artist, PLANT.serial, PLANT.trailing, 'GPS-AREA-PLANT'],
      keptStrings: [PLANT.make],
      redTags: [['GPS', 'GPSLatitude'], ['IFD0', 'Artist'], ['ExifIFD', 'SerialNumber']],
      keptTags: [['IFD0', 'Make'], ['ExifIFD', 'DateTimeOriginal'], ['File', 'ExifByteOrder']],
    });
    const out = F.read('progressive.out-red.jpg');
    assert.equal(walkJpeg(out).segs.filter((s) => s.kind === 'sos').length, walkJpeg(b).segs.filter((s) => s.kind === 'sos').length);
    assert.equal(out[out.length - 2], 0xff);
    assert.equal(out[out.length - 1], 0xd9, 'file now ends at EOI');
  });

  test('restart markers survive and pixels stay identical', async () => {
    const name = F.jpegRestart();
    const count = (buf) => { let n = 0; for (let i = 0; i + 1 < buf.length; i++) if (buf[i] === 0xff && buf[i + 1] >= 0xd0 && buf[i + 1] <= 0xd7) n++; return n; };
    const b = F.read(name);
    assert.ok(count(b) > 10);
    await standardChecks(name, 'jpeg', {
      redStrings: [PLANT.artist, PLANT.xmpCreator, 'GPS-AREA-PLANT'],
      redTags: [['GPS', 'GPSLatitude'], ['IFD0', 'Artist'], ['XMP-dc', 'Creator']],
    });
    assert.equal(count(F.read('restart.out-all.jpg')), count(b));
  });

  test('maker note offsets stay valid when kept, and the maker note goes when removed', async () => {
    const name = F.jpegMakernote();
    const b = F.read(name);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'exif:makernote'), 'red');
    assert.equal(info.items.find((i) => i.id === 'exif:makernote').label, 'Manufacturer notes (may include serial numbers)');
    // Keep the maker note, remove GPS, the owner name (shared bytes) and the preview.
    await scrubTo('makernote.keep.jpg', b, ['exif:gps', 'exif:owner', 'exif:thumbnail']);
    const rows = F.exifRead(F.path('makernote.keep.jpg'));
    const val = (g, t) => rows.find((r) => r.group === g && r.tag === t)?.value;
    assert.equal(val('Canon', 'OwnerName'), 'MAKERNOTE-OWNER-PLANT');
    assert.equal(val('Canon', 'CanonImageType'), 'Fake Canon Image Type');
    assert.equal(val('IFD0', 'ImageDescription'), 'Shared Name Plant 22', 'shared value kept for the kept tag');
    assert.equal(val('IFD0', 'Artist'), undefined);
    assert.ok(!hasTag(rows, 'GPS', 'GPSLatitude') && !hasTag(rows, 'IFD1', 'ThumbnailImage'));
    const keep = F.read('makernote.keep.jpg');
    assert.ok(!contains(keep, 'GPS-AREA-PLANT'));
    // The preview's JPEG bytes are zeroed, not just unlinked.
    const thumb = readFileSync(F.path('thumb.jpg'));
    assert.ok(!Buffer.from(keep).includes(thumb.subarray(200, 260)));
    assert.equal(keep.length, b.length, 'EXIF edited in place without moving anything');
    samePixels(name, 'makernote.keep.jpg');
    // Now the maker note itself.
    await scrubTo('makernote.gone.jpg', b, ['exif:makernote']);
    const gone = F.read('makernote.gone.jpg');
    assert.ok(!contains(gone, 'MAKERNOTE-OWNER-PLANT') && !contains(gone, 'Fake Canon Image Type'));
    assert.ok(!F.exifRead(F.path('makernote.gone.jpg')).some((r) => r.group === 'Canon'));
  });

  test('Motion Photo with an HDR gain map', async () => {
    const name = F.jpegMotion();
    const b = F.read(name);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'jpeg:trailing:motion-video'), 'red');
    assert.equal(info.items.find((i) => i.id === 'jpeg:trailing:motion-video').label, 'Hidden video clip (Motion Photo)');
    assert.equal(tierOf(info, 'jpeg:trailing:gain-map'), 'amber');
    assert.equal(tierOf(info, 'xmp:motion'), 'red', 'descriptor follows the video tier');
    assert.equal(tierOf(info, 'xmp:gainmap'), 'amber', 'descriptor follows the gain map tier');
    assert.ok(contains(b, 'VIDEO-PLANT-SECRET'));

    await scrubTo('motion.out-red.jpg', b, reds(info));
    const out = F.read('motion.out-red.jpg');
    assert.ok(!contains(out, 'VIDEO-PLANT-SECRET') && !contains(out, 'GCamera:MotionPhoto'));
    const rows = F.exifRead(F.path('motion.out-red.jpg'));
    assert.ok(!rows.some((r) => r.tag === 'MotionPhotoVideo'));
    assert.ok(hasTag(rows, 'XMP-hdrgm', 'Version'));
    // The MPF index must still point at the gain map, byte for byte.
    const start = Number(rows.find((r) => r.group === 'MPImage2' && r.tag === 'MPImageStart').value);
    const len = Number(rows.find((r) => r.group === 'MPImage2' && r.tag === 'MPImageLength').value);
    const gain = F.read('motion-gain-only.jpg');
    assert.equal(len, gain.length);
    assert.ok(Buffer.from(out).subarray(start, start + len).equals(Buffer.from(gain)), 'MPF offset fixed after the primary shrank');
    const primaryLen = Number(rows.find((r) => r.group === 'MPImage1' && r.tag === 'MPImageLength').value);
    assert.equal(primaryLen, start, 'MPF primary size updated');
    samePixels(name, 'motion.out-red.jpg');
    noNewWarnings(name, 'motion.out-red.jpg');

    // Removing the gain map takes the MPF index, the ISO marker and the hdrgm details too.
    await scrubTo('motion.no-gain.jpg', b, ['jpeg:trailing:gain-map']);
    const ng = F.read('motion.no-gain.jpg');
    const ngInfo = await core.inspect(ng);
    assert.ok(!ids(ngInfo).some((id) => /gain|mpf/.test(id)), ids(ngInfo).join(' '));
    assert.ok(!contains(ng, 'MPF\0') && !contains(ng, 'urn:iso:std:iso:ts:21496:-1') && !contains(ng, 'hdrgm:Version'));
    assert.ok(contains(ng, 'VIDEO-PLANT-SECRET'), 'video kept when only the gain map goes');
    samePixels(name, 'motion.no-gain.jpg');

    await standardChecks(name, 'jpeg', { redStrings: ['VIDEO-PLANT-SECRET'], redTags: [['XMP-GCamera', 'MotionPhoto']] });
    const all = F.read('motion.out-all.jpg');
    const w = walkJpeg(all);
    assert.equal(w.eoiEnd, all.length, 'nothing after the image');
  });

  test('Samsung trailer', async () => {
    const name = F.jpegSamsung();
    const info = await core.inspect(F.read(name));
    const item = info.items.find((i) => i.id === 'jpeg:trailing:samsung');
    assert.equal(item.tier, 'red');
    assert.equal(item.label, 'Hidden video clip and Samsung extra data');
    await standardChecks(name, 'jpeg', { redStrings: ['SAMSUNG-VIDEO-PLANT', 'SEFH', 'SEFT', 'MotionPhoto_Data'] });
  });

  test('Extended XMP with a hidden picture', async () => {
    const name = F.jpegExtended();
    const b = F.read(name);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'xmp:extended'), 'red');
    assert.match(info.items.find((i) => i.id === 'xmp:extended').value, /a second picture/);
    const { back } = await standardChecks(name, 'jpeg', {
      redStrings: ['EXTXMP-PLANT-SECRET', 'http://ns.adobe.com/xmp/extension/', PLANT.xmpCreator, 'HasExtendedXMP'],
      redTags: [['XMP-dc', 'Creator'], ['XMP-GImage', 'Data']],
      keptTags: [['XMP-xmp', 'CreateDate']],
    });
    assert.ok(ids(back).includes('xmp:dates'));
  });

  test('an XMP packet that cannot be parsed is offered as one red item and removed whole', async () => {
    const base = F.read(F.jpegRestart());
    const bad = F.jpegInsert(base, F.jpegSeg(0xe1, F.u8('http://ns.adobe.com/xap/1.0/\0', '<x:xmpmeta><rdf:RDF><rdf:Description BROKEN-PLANT="1"></x:xmpmeta>')));
    const info = await core.inspect(bad);
    const item = info.items.find((i) => i.id === 'xmp:packet');
    assert.equal(item.tier, 'red');
    const res = await core.scrub(bad, ['xmp:packet']);
    assert.ok(!contains(res.bytes, 'BROKEN-PLANT'));
  });
});

// ======================================================================================

describe('JPEG edge cases', () => {
  const base = () => {
    F.magick(['-size', '96x64', 'plasma:fractal', '-seed', '151', '-depth', '8', '-quality', '90', F.path('edge-base.jpg')]);
    return F.read('edge-base.jpg');
  };
  const replaceApp0 = (b, seg) => {
    const buf = Buffer.from(b);
    assert.equal(buf[3], 0xe0);
    const end = 4 + buf.readUInt16BE(4);
    return F.u8(buf.subarray(0, 2), seg, buf.subarray(end));
  };

  test('JFIF thumbnail is red and removed by rewriting APP0', async () => {
    const thumbPixels = Buffer.alloc(2 * 1 * 3, 0x7f);
    const b = replaceApp0(base(), F.jpegSeg(0xe0, F.u8('JFIF\0', [1, 2, 1, 0, 72, 0, 72, 2, 1], thumbPixels)));
    F.write('jfif-thumb.jpg', b);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'jpeg:jfif-thumbnail'), 'red');
    assert.equal(tierOf(info, 'jpeg:jfif'), 'green');
    await scrubTo('jfif-thumb.out.jpg', b, ['jpeg:jfif-thumbnail']);
    const out = F.read('jfif-thumb.out.jpg');
    assert.deepEqual(ids(await core.inspect(out)), ['jpeg:jfif']);
    assert.equal(out.length, b.length - 6);
    samePixels('jfif-thumb.jpg', 'jfif-thumb.out.jpg');
    noNewWarnings('jfif-thumb.jpg', 'jfif-thumb.out.jpg');
  });

  test('JFXX preview is red and dropped', async () => {
    const thumb = readFileSync(F.path('thumb.jpg'));
    const b = F.jpegInsert(base(), F.jpegSeg(0xe0, F.u8('JFXX\0', [0x10], thumb.subarray(0, 60000))));
    F.write('jfxx.jpg', b);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'jpeg:jfxx'), 'red');
    await scrubTo('jfxx.out.jpg', b, reds(info));
    assert.ok(!Buffer.from(F.read('jfxx.out.jpg')).includes(Buffer.from('JFXX\0', 'latin1')));
    samePixels('jfxx.jpg', 'jfxx.out.jpg');
  });

  test('MPF large thumbnail is treated as a red preview, and its index goes with it', async () => {
    const primary0 = base();
    const second = readFileSync(F.path('thumb.jpg'));
    const be32 = (v) => { const x = Buffer.alloc(4); x.writeUInt32BE(v); return x; };
    const be16 = (v) => { const x = Buffer.alloc(2); x.writeUInt16BE(v); return x; };
    const mpf = (size, off, size2) => F.u8('MPF\0', 'MM', [0, 42], be32(8), be16(3),
      be16(0xb000), be16(7), be32(4), '0100', be16(0xb001), be16(4), be32(1), be32(2), be16(0xb002), be16(7), be32(32), be32(50), be32(0),
      be32(0x20030000), be32(size), be32(0), be16(0), be16(0), be32(0x00010001), be32(size2), be32(off), be16(0), be16(0));
    let p = F.jpegInsert(primary0, F.jpegSeg(0xe2, mpf(0, 0, 0)));
    const at = Buffer.from(p).indexOf(Buffer.from('MPF\0', 'latin1')) + 4;
    p = F.jpegInsert(primary0, F.jpegSeg(0xe2, mpf(p.length, p.length - at, second.length)));
    const b = F.u8(p, second);
    F.write('mpf-preview.jpg', b);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'jpeg:trailing:preview'), 'red');
    await scrubTo('mpf-preview.out.jpg', b, reds(info));
    const out = F.read('mpf-preview.out.jpg');
    assert.equal(walkJpeg(out).eoiEnd, out.length);
    assert.ok(!Buffer.from(out).includes(Buffer.from('MPF\0', 'latin1')));
    samePixels('mpf-preview.jpg', 'mpf-preview.out.jpg');
  });

  test('a clip without an ftyp box is still found through the XMP length', async () => {
    const b = Buffer.from(F.read(F.jpegMotion()));
    const at = b.lastIndexOf(Buffer.from('ftypmp42', 'latin1'));
    b.write('xxxx', at, 'latin1');
    const info = await core.inspect(new Uint8Array(b));
    assert.equal(tierOf(info, 'jpeg:trailing:motion-video'), 'red');
    const res = await core.scrub(new Uint8Array(b), ['jpeg:trailing:motion-video']);
    assert.ok(!contains(res.bytes, 'VIDEO-PLANT-SECRET'));
  });

  test('CMYK JPEG keeps the Adobe marker it needs, even when everything is removed', async () => {
    F.magick(['-size', '64x48', 'plasma:fractal', '-seed', '161', '-colorspace', 'CMYK', '-quality', '90', F.path('cmyk.jpg')]);
    F.sh('exiftool', ['-q', '-q', '-overwrite_original', `-EXIF:Artist=${PLANT.artist}`, F.path('cmyk.jpg')]);
    const b = F.read('cmyk.jpg');
    const info = await core.inspect(b);
    assert.ok(!ids(info).includes('jpeg:adobe'), 'not offered, because removing it would change the colours');
    await scrubTo('cmyk.out.jpg', b, ids(info));
    const out = F.read('cmyk.out.jpg');
    assert.ok(contains(out, 'Adobe'));
    assert.ok(!contains(out, PLANT.artist));
    samePixels('cmyk.jpg', 'cmyk.out.jpg');
  });

  test('buildExif reads HEIC and PNG sources too', () => {
    F.buildHeic('custom-v1.heic', { ilocVersion: 1 });
    for (const n of ['custom-v1.heic', F.pngFull()]) {
      const payload = core.buildExif(F.read(n), ['exif:camera', 'exif:owner']);
      assert.ok(payload, n);
      assert.ok(contains(payload, PLANT.make) && contains(payload, PLANT.artist), n);
      assert.ok(!contains(payload, PLANT.serial), n);
    }
  });
});

describe('PNG', () => {
  test('full fixture: items and tiers', async () => {
    const info = await core.inspect(F.read(F.pngFull()));
    assert.equal(info.width, 160);
    const expect = {
      'exif:gps': 'red', 'exif:owner': 'red', 'exif:serial': 'red', 'exif:camera': 'amber', 'exif:datetime': 'amber',
      'xmp:creator': 'red', 'xmp:place': 'red', 'xmp:ids': 'red', 'xmp:dates': 'amber',
      'iptc:byline': 'red', 'iptc:credit': 'red',
      'png:author': 'red', 'png:copyright': 'red', 'png:dates': 'amber', 'png:software': 'amber', 'png:description': 'amber',
      'png:title': 'amber', 'png:comment': 'amber', 'png:notes': 'amber', 'png:time': 'amber', 'png:colour': 'green',
      'png:chunk:prvt': 'red', 'png:c2pa': 'amber', 'png:trailing': 'red',
    };
    for (const [id, tier] of Object.entries(expect)) assert.equal(tierOf(info, id), tier, id);
    assert.equal(info.items.find((i) => i.id === 'png:comment').value, 'ZTXT-PLANT-COMMENT', 'zTXt inflated');
    assert.equal(info.items.find((i) => i.id === 'png:notes').value, 'ITXT-PLANT-WARNING', 'compressed iTXt inflated');
    assert.equal(info.items.find((i) => i.id === 'png:c2pa').source, 'C2PA');
  });

  test('full fixture: red default, everything, pixels and validity', async () => {
    await standardChecks(F.pngFull(), 'png', {
      redStrings: [PLANT.owner, PLANT.xmpCreator, PLANT.xmpCity, PLANT.xmpDocId, 'PRVT-PLANT-SECRET', 'PNGTAIL-PLANT-SECRET', 'GPS-AREA-PLANT', PLANT.copyright],
      keptStrings: [PLANT.software, PLANT.description, 'FakeCam C2PA PLANT'],
      redTags: [['GPS', 'GPSLatitude'], ['IFD0', 'Artist'], ['ExifIFD', 'SerialNumber'], ['PNG', 'Author'], ['XMP-dc', 'Creator'],
        ['XMP-photoshop', 'City'], ['IPTC', 'By-line']],
      keptTags: [['IFD0', 'Make'], ['ExifIFD', 'DateTimeOriginal'], ['PNG', 'Software'], ['PNG', 'Comment'],
        ['XMP-xmp', 'CreateDate'], ['ICC_Profile', 'ProfileDescription']],
    });
    // Every chunk in the output has a correct CRC.
    for (const n of ['full.out-red.png', 'full.out-all.png']) {
      const b = Buffer.from(F.read(n));
      let p = 8;
      while (p < b.length) {
        const len = b.readUInt32BE(p);
        const { crc32 } = await import('node:zlib');
        assert.equal(crc32(b.subarray(p + 4, p + 8 + len)), b.readUInt32BE(p + 8 + len), `CRC of ${b.toString('latin1', p + 4, p + 8)}`);
        p += 12 + len;
      }
      assert.equal(p, b.length);
    }
  });

  test('ImageMagick raw profiles and exif: text copies', async () => {
    const name = F.pngRaw();
    const b = F.read(name);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'png:exif-text:gps'), 'red');
    assert.equal(info.items.find((i) => i.id === 'png:exif-text:gps').value, '48.8584 N, 2.2945 E');
    assert.equal(tierOf(info, 'png:exif-text:owner'), 'red');
    assert.ok(ids(info).some((id) => /^exif:serial/.test(id)), 'serial read from the compressed raw exif profile');
    assert.ok(ids(info).includes('iptc:byline') && ids(info).includes('iptc:place'));
    // Red only: the raw exif profile is rewritten without the serial but keeps the make.
    await scrubTo('raw.out-red.png', b, reds(info));
    const out = F.read('raw.out-red.png');
    const back = await core.inspect(out);
    assert.deepEqual(reds(back), []);
    assert.ok(back.items.some((i) => /^exif:camera/.test(i.id) && i.value === 'RawCam'), 'kept make survives in the rewritten profile');
    const rows = F.exifRead(F.path('raw.out-red.png'));
    assert.ok(!rows.some((r) => r.value.includes('RAWEXIF-PLANT-SERIAL')));
    assert.ok(rows.some((r) => r.tag === 'Make' && r.value === 'RawCam'), 'exiftool reads the rewritten raw profile');
    assert.ok(rows.some((r) => r.tag === 'Keywords' && r.value === 'Rawkeyword'), 'IPTC keywords kept in the rebuilt profile');
    assert.ok(!rows.some((r) => r.tag === 'Credit'), 'the credit line is red, so it goes');
    assert.ok(!rows.some((r) => r.tag === 'By-line'));
    samePixels(name, 'raw.out-red.png');
    noNewWarnings(name, 'raw.out-red.png');
    // The XMP and IPTC here are compressed, so exiftool checks them rather than a byte search.
    await standardChecks(name, 'png', {
      redStrings: [PLANT.artist],
      redTags: [['XMP-dc', 'Creator'], ['IPTC', 'By-line'], ['IPTC', 'City'], ['GPS', 'GPSLatitude'], ['ExifIFD', 'SerialNumber']],
    });
  });
});

// ======================================================================================

describe('WebP', () => {
  test('full fixture: items, flags and sizes', async () => {
    const name = F.webpFull();
    const info = await core.inspect(F.read(name));
    assert.equal(info.width, 160);
    assert.equal(info.height, 120);
    const expect = { 'exif:gps': 'red', 'exif:owner': 'red', 'exif:serial': 'red', 'exif:camera': 'amber', 'xmp:creator': 'red',
      'xmp:dates': 'amber', 'icc:profile': 'green', 'webp:chunk:prvt': 'red', 'webp:c2pa': 'amber', 'webp:trailing': 'red' };
    for (const [id, tier] of Object.entries(expect)) assert.equal(tierOf(info, id), tier, id);
    await standardChecks(name, 'webp', {
      redStrings: [PLANT.artist, PLANT.serial, PLANT.xmpCreator, 'PRVT-PLANT-ODD', 'WEBPTAIL-PLANT', 'GPS-AREA-PLANT'],
      keptStrings: [PLANT.make, 'FakeCam C2PA PLANT'],
      redTags: [['GPS', 'GPSLatitude'], ['IFD0', 'Artist'], ['XMP-dc', 'Creator'], ['RIFF', 'Unknown_prVt']],
      keptTags: [['IFD0', 'Make'], ['XMP-xmp', 'CreateDate'], ['ICC_Profile', 'ProfileDescription']],
    });
    for (const n of ['full.out-red.webp', 'full.out-all.webp']) {
      const b = Buffer.from(F.read(n));
      assert.equal(b.readUInt32LE(4), b.length - 8, 'RIFF size');
      const chunks = F.webpChunks(b);
      const flags = chunks.find((c) => c.type === 'VP8X').data[0];
      assert.equal(!!(flags & 0x20), chunks.some((c) => c.type === 'ICCP'), 'ICC flag');
      assert.equal(!!(flags & 0x08), chunks.some((c) => c.type === 'EXIF'), 'EXIF flag');
      assert.equal(!!(flags & 0x04), chunks.some((c) => c.type === 'XMP '), 'XMP flag');
    }
  });
});

// ======================================================================================

describe('HEIC', () => {
  test('exiftool-written HEIC', async () => {
    const name = F.heicExiftool();
    const b = F.read(name);
    const info = await core.inspect(b);
    assert.equal(info.orientation, 1, 'HEIC viewers ignore the EXIF rotation flag');
    assert.match(info.items.find((i) => i.id === 'exif:orientation').note, /does not turn the picture/);
    for (const [id, tier] of Object.entries({ 'exif:gps': 'red', 'exif:owner': 'red', 'exif:serial': 'red', 'exif:camera': 'amber', 'xmp:creator': 'red', 'xmp:place': 'red', 'xmp:dates': 'amber' })) {
      assert.equal(tierOf(info, id), tier, id);
    }
    await standardChecks(name, 'heic', {
      redStrings: [PLANT.artist, PLANT.serial, PLANT.xmpCreator, PLANT.xmpCity, 'GPS-AREA-PLANT'],
      keptStrings: [PLANT.make],
      redTags: [['GPS', 'GPSLatitude'], ['IFD0', 'Artist'], ['ExifIFD', 'SerialNumber'], ['XMP-dc', 'Creator']],
      keptTags: [['IFD0', 'Make'], ['ExifIFD', 'DateTimeOriginal'], ['XMP-xmp', 'CreateDate']],
    });
    for (const n of ['exiftool.out-red.heic', 'exiftool.out-all.heic']) assert.equal(F.read(n).length, b.length, 'HEIC size never changes');
  });

  const variants = [
    ['custom-v1.heic', { ilocVersion: 1 }, 'iloc v1, EXIF in idat, XMP in two extents'],
    ['custom-v0.heic', { ilocVersion: 0, baseSize: 0 }, 'iloc v0 without base offsets'],
    ['custom-v2.heic', { ilocVersion: 2, offSize: 8, lenSize: 8, baseSize: 8, idxSize: 4, infeVersion: 3, wideIds: true, ipmaLarge: true }, 'iloc v2, 64-bit fields, extent indices, infe v3'],
  ];
  for (const [name, opts, label] of variants) {
    test(`hand-built HEIC: ${label}`, async () => {
      const built = F.buildHeic(name, opts);
      const b = F.read(name);
      const info = await core.inspect(b);
      assert.equal(info.width, 160);
      assert.equal(info.height, 120);
      for (const [id, tier] of Object.entries({ 'exif:gps': 'red', 'exif:owner': 'red', 'exif:serial': 'red', 'xmp:creator': 'red', 'xmp:place': 'red', 'heic:thumbnail': 'red', 'icc:profile': 'green' })) {
        assert.equal(tierOf(info, id), tier, `${id} in ${name}`);
      }
      const { res } = await standardChecks(name, 'heic', {
        redStrings: [PLANT.artist, PLANT.serial, PLANT.xmpCreator, PLANT.xmpCity],
        keptStrings: [PLANT.make],
        redTags: [['GPS', 'GPSLatitude'], ['IFD0', 'Artist'], ['XMP-dc', 'Creator'], ['XMP-photoshop', 'City']],
        keptTags: [['IFD0', 'Make'], ['XMP-xmp', 'CreateDate'], ['ICC_Profile', 'ProfileDescription']],
      });
      assert.ok(res.warnings.some((w) => /blank|empty thumbnail/i.test(w)), 'warns about the blanked preview');
      const base = name.replace(/\.heic$/, '');
      for (const n of [`${base}.out-red.heic`, `${base}.out-all.heic`]) {
        const out = Buffer.from(F.read(n));
        assert.equal(out.length, b.length, 'size unchanged');
        assert.ok(out.subarray(...built.thumbRange).every((x) => x === 0), 'preview data zeroed');
        assert.ok(out.subarray(...built.primRange).equals(Buffer.from(b).subarray(...built.primRange)), 'picture data untouched');
      }
    });
  }
});

// ======================================================================================

describe('buildExif and insertExif', () => {
  const keep = ['exif:camera', 'exif:datetime', 'exif:orientation', 'exif:gps', 'exif:makernote', 'exif:thumbnail', 'exif:copyright', 'exif:software'];

  test('builds a fresh block with only kept simple tags and Orientation 1', async () => {
    const payload = core.buildExif(F.read(F.jpegFull()), keep);
    assert.ok(payload instanceof Uint8Array);
    const m = parseTiff(payload);
    const tags = (n) => (m.ifds[n] ? m.ifds[n].entries.map((e) => e.tag) : []);
    assert.ok(tags('ifd0').includes(0x010f) && tags('ifd0').includes(0x0110) && tags('ifd0').includes(0x8298));
    assert.ok(!tags('ifd0').includes(0x013b), 'artist not kept');
    assert.ok(tags('ifd0').includes(0x0131) && !tags('ifd0').includes(0x013c), 'editing software kept, computer name not');
    assert.ok(!tags('exif').includes(0x927c) && !m.ifds.ifd1, 'no maker note, no preview');
    assert.ok(tags('gps').includes(2));
    const o = m.ifds.ifd0.entries.find((e) => e.tag === 0x0112);
    assert.equal(m.r16(o.entryPos + 8), 1);
    assert.equal(core.buildExif(F.read(F.jpegFull()), ['xmp:creator', 'jpeg:comment']), null);
    assert.equal(core.buildExif(F.read(F.webpSimple()), keep), null);
  });

  for (const [format, make] of [['jpeg', 'fresh.jpg'], ['png', 'fresh.png'], ['webp', 'fresh.webp'], ['webp', 'fresh-lossy.webp']]) {
    test(`inserts into a freshly encoded ${make}`, async () => {
      const args = make === 'fresh.webp' ? ['-define', 'webp:lossless=true'] : [];
      F.magick(['-size', '120x90', 'plasma:fractal', '-seed', '141', '-depth', '8', ...args, F.path(make)]);
      const payload = core.buildExif(F.read(F.jpegFull()), keep);
      const out = core.insertExif(F.read(make), format, payload);
      const outName = make.replace('fresh', 'fresh.exif');
      F.write(outName, out);
      const rows = F.exifRead(F.path(outName));
      const val = (t) => rows.find((r) => r.tag === t)?.value;
      assert.equal(val('Make'), PLANT.make);
      assert.equal(val('Orientation'), '1');
      assert.ok(hasTag(rows, 'GPS', 'GPSLatitude'));
      assert.ok(!hasTag(rows, 'IFD0', 'Artist') && !hasTag(rows, 'IFD1', 'ThumbnailImage'));
      samePixels(make, outName);
      noNewWarnings(make, outName);
      const info = await core.inspect(out);
      assert.ok(ids(info).includes('exif:camera') && ids(info).includes('exif:gps'));
      if (format === 'webp') {
        const b = Buffer.from(out);
        assert.equal(b.readUInt32LE(4), b.length - 8);
        assert.ok(F.webpChunks(b).find((c) => c.type === 'VP8X').data[0] & 0x08);
      }
    });
  }
});

// ======================================================================================
// Hardening: data hidden where a scrubber may not look. Hand-built inputs, so these run
// in a moment; tests/audit.mjs covers the same ground far more widely.

describe('Hardening', () => {
  const H = (s) => `HARD-${s}-PLANT`;
  const le16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const le32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  const be32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  // Little-endian TIFF with free layout: dirs [{ name, entries: [{ tag, type, data | raw | ptr | blob, count }], next }].
  function tiffLE(dirs, blobs = {}) {
    const unit = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 129: 1 };
    const dataOf = (e) => (e.data === undefined ? null : typeof e.data === 'string' ? Buffer.from(`${e.data}\0`, 'utf8') : Buffer.from(e.data));
    const at = {};
    let p = 8;
    for (const d of dirs) {
      at[d.name] = p;
      p += 2 + d.entries.length * 12 + 4;
      for (const e of d.entries) { const v = dataOf(e); if (v && v.length > 4) p += v.length + (v.length & 1); }
    }
    for (const [k, v] of Object.entries(blobs)) { at[`blob:${k}`] = p; p += v.length + (v.length & 1); }
    const out = Buffer.alloc(p);
    out.write('II', 0, 'latin1'); out.writeUInt16LE(42, 2); out.writeUInt32LE(8, 4);
    for (const d of dirs) {
      let q = at[d.name];
      let data = q + 2 + d.entries.length * 12 + 4;
      out.writeUInt16LE(d.entries.length, q);
      q += 2;
      for (const e of d.entries) {
        const v = dataOf(e);
        out.writeUInt16LE(e.tag, q); out.writeUInt16LE(e.type, q + 2); out.writeUInt32LE((e.count ?? (v ? v.length / (unit[e.type] || 1) : 1)) >>> 0, q + 4);
        if (e.ptr) out.writeUInt32LE(at[e.ptr], q + 8);
        else if (e.blob) out.writeUInt32LE(at[`blob:${e.blob}`], q + 8);
        else if (v.length <= 4) v.copy(out, q + 8);
        else { out.writeUInt32LE(data, q + 8); v.copy(out, data); data += v.length + (v.length & 1); }
        q += 12;
      }
      out.writeUInt32LE(d.next ? at[d.next] : 0, q);
    }
    for (const [k, v] of Object.entries(blobs)) Buffer.from(v).copy(out, at[`blob:${k}`]);
    return out;
  }
  const exifSeg = (t) => F.jpegSeg(0xe1, F.u8('Exif\0\0', t));
  const xmpSeg = (text) => F.jpegSeg(0xe1, F.u8('http://ns.adobe.com/xap/1.0/\0', Buffer.from(text, 'utf8')));
  const GPS = (area) => [
    { tag: 0x0001, type: 2, data: 'N' }, { tag: 0x0002, type: 5, count: 3, data: Buffer.concat([le32(59), le32(1), le32(54), le32(1), le32(5008), le32(100)]) },
    { tag: 0x0003, type: 2, data: 'E' }, { tag: 0x0004, type: 5, count: 3, data: Buffer.concat([le32(10), le32(1), le32(45), le32(1), le32(792), le32(100)]) },
    { tag: 0x001c, type: 7, data: Buffer.from(`ASCII\0\0\0${area}`, 'latin1') },
  ];
  let base;
  const baseJpeg = () => {
    if (!base) { F.magick(['-size', '64x48', 'plasma:fractal', '-seed', '171', '-strip', '-quality', '88', F.path('hard-base.jpg')]); base = F.read('hard-base.jpg'); }
    return base;
  };
  // Scrubs with the default and with everything. Files are written for the checks that
  // need them (pixels, exiftool), except for damaged inputs that no tool can open anyway.
  async function defaultAndAll(name, b, { write = true } = {}) {
    const info = await core.inspect(b);
    const red = await core.scrub(b, reds(info));
    const all = await core.scrub(b, ids(info));
    if (write) {
      const ext = name.split('.').pop();
      F.write(name, b);
      F.write(name.replace(/\.\w+$/, `.out-red.${ext}`), red.bytes);
      F.write(name.replace(/\.\w+$/, `.out-all.${ext}`), all.bytes);
    }
    return { info, red: red.bytes, all: all.bytes, backRed: await core.inspect(red.bytes), backAll: await core.inspect(all.bytes) };
  }

  test('EXIF: UTF-8 names, GPS reached from the Exif IFD, a second preview and leftover bytes', async () => {
    const t1 = baseJpeg();
    const thumbA = F.u8(t1.subarray(0, 2), F.jpegSeg(0xfe, Buffer.from(H('PREVIEW1'))), t1.subarray(2));
    const thumbB = F.u8(t1.subarray(0, 2), F.jpegSeg(0xfe, Buffer.from(H('PREVIEW2'))), t1.subarray(2));
    const tiff = tiffLE([
      { name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Hardcam' }, { tag: 0x013b, type: 129, data: `Åse ${H('UTF8')}` }, { tag: 0x8769, type: 4, ptr: 'exif' }], next: 'ifd1' },
      { name: 'exif', entries: [{ tag: 0x8825, type: 4, ptr: 'gps' }, { tag: 0x9003, type: 2, data: '2026:09:14 10:15:23' }] },
      { name: 'gps', entries: GPS(H('GPSAREA')) },
      { name: 'ifd1', entries: [{ tag: 0x0201, type: 4, blob: 'a' }, { tag: 0x0202, type: 4, data: le32(thumbA.length + 40) }], next: 'ifd2' },
      { name: 'ifd2', entries: [{ tag: 0x0201, type: 4, blob: 'b' }, { tag: 0x0202, type: 4, data: le32(thumbB.length) }] },
    ], { a: thumbA, b: thumbB });
    const b = F.jpegInsert(baseJpeg(), exifSeg(F.u8(tiff, Buffer.from(`old ${H('ORPHAN')}`))));
    const { info, red, backRed } = await defaultAndAll('hard-exif.jpg', b);
    for (const [id, tier] of Object.entries({ 'exif:owner': 'red', 'exif:gps': 'red', 'exif:thumbnail': 'red', 'exif:leftover': 'red' })) assert.equal(tierOf(info, id), tier, id);
    assert.match(info.items.find((i) => i.id === 'exif:owner').value, /HARD-UTF8/);
    assert.match(info.items.find((i) => i.id === 'exif:thumbnail').value, /plus 1 more preview/);
    for (const s of ['UTF8', 'GPSAREA', 'PREVIEW1', 'PREVIEW2', 'ORPHAN']) assert.ok(!contains(red, H(s)), `${s} must be erased, not just unlinked`);
    assert.ok(!Buffer.from(red).includes(Buffer.concat([le32(59), le32(1), le32(54), le32(1)])), 'GPS rationals erased');
    assert.deepEqual(reds(backRed), []);
    assert.ok(backRed.items.some((i) => i.id === 'exif:camera'), 'the make is kept');
    samePixels('hard-exif.jpg', 'hard-exif.out-red.jpg');
  });

  test('EXIF: unknown tags and XMP or IPTC stored as EXIF tags are red', async () => {
    const iptc = F.u8([0x1c, 2, 80], [0, H('IPTCBYLINE').length], H('IPTCBYLINE'));
    const tiff = tiffLE([{ name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Hardcam' }, { tag: 0x02bc, type: 1, data: Buffer.from(`<x:xmpmeta xmlns:x="adobe:ns:meta/">${H('XMPINEXIF')}</x:xmpmeta>`) }, { tag: 0x83bb, type: 7, data: iptc }, { tag: 0xbeef, type: 2, data: H('PRIVATE') }] }]);
    const { info, red } = await defaultAndAll('hard-embedded.jpg', F.jpegInsert(baseJpeg(), exifSeg(tiff)));
    assert.equal(tierOf(info, 'exif:embedded'), 'red');
    assert.equal(tierOf(info, 'exif:private'), 'red');
    for (const s of ['IPTCBYLINE', 'XMPINEXIF', 'PRIVATE']) assert.ok(!contains(red, H(s)), s);
  });

  test('XMP: vendor names, comments, rdf:about and typed nodes do not survive the default', async () => {
    const text = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="uuid:${H('ABOUT')}" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" xmp:CreatorTool="Hardedit" xmp:CreateDate="2026-09-14" drone-dji:GpsLatitude="+59.913912" drone-dji:DroneSerialNumber="${H('DRONE')}">
<!-- Previous owner: ${H('COMMENT')} -->
</rdf:Description>
<photoshop:Thing rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:City="${H('TYPEDCITY')}"/>
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const { info, red, backRed } = await defaultAndAll('hard-xmp.jpg', F.jpegInsert(baseJpeg(), xmpSeg(text)));
    for (const id of ['xmp:ids', 'xmp:gps', 'xmp:serial', 'xmp:place', 'xmp:hidden']) assert.equal(tierOf(info, id), 'red', id);
    for (const s of ['ABOUT', 'DRONE', 'COMMENT', 'TYPEDCITY']) assert.ok(!contains(red, H(s)), s);
    assert.ok(!contains(red, '+59.913912'));
    assert.ok(contains(red, 'Hardedit') && contains(red, '2026-09-14'), 'amber XMP is kept in the fresh packet');
    assert.deepEqual(reds(backRed), []);
    noNewWarnings('hard-xmp.jpg', 'hard-xmp.out-red.jpg');
  });

  test('the computer name is red in EXIF, XMP and PNG text, and editing software stays amber', async () => {
    const tiff = tiffLE([{ name: 'ifd0', entries: [{ tag: 0x010f, type: 2, data: 'Hardcam' }, { tag: 0x0131, type: 2, data: 'Hardedit 1.0' }, { tag: 0x013c, type: 2, data: H('EXIFHOST') }] }]);
    const text = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmp:CreatorTool="Hardedit 2.0" tiff:HostComputer="${H('XMPHOST')}"/>
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const { info, red, backRed } = await defaultAndAll('hard-computer.jpg', F.jpegInsert(baseJpeg(), exifSeg(tiff), xmpSeg(text)));
    const item = (i, id) => i.items.find((x) => x.id === id);
    for (const id of ['exif:computer', 'xmp:computer']) assert.deepEqual([item(info, id)?.tier, item(info, id)?.group, item(info, id)?.label], ['red', 'who', 'Computer name'], id);
    for (const id of ['exif:software', 'xmp:software']) assert.deepEqual([item(info, id)?.tier, item(info, id)?.label], ['amber', 'Editing software'], id);
    assert.equal(item(info, 'exif:computer').value, H('EXIFHOST'));
    assert.equal(item(info, 'exif:software').value, 'Hardedit 1.0');
    for (const s of ['EXIFHOST', 'XMPHOST']) assert.ok(!contains(red, H(s)), s);
    assert.ok(contains(red, 'Hardedit 1.0') && contains(red, 'Hardedit 2.0'), 'editing software is kept');
    assert.deepEqual(reds(backRed), []);
    assert.ok(item(backRed, 'exif:software') && item(backRed, 'xmp:software'), 'the read-back still lists the editing software');
    samePixels('hard-computer.jpg', 'hard-computer.out-red.jpg');

    F.magick(['-size', '64x48', 'plasma:fractal', '-seed', '174', '-strip', `PNG24:${F.path('hard-computer-base.png')}`]);
    const png = F.read('hard-computer-base.png');
    const t = (k, v) => F.pngChunk('tEXt', F.u8(k, [0], v));
    const p = F.u8(png.subarray(0, png.length - 12), t('Host Computer', H('PNGHOST')), t('exif:HostComputer', H('PNGEXIFHOST')),
      t('Software', 'Hardedit 3.0'), png.subarray(png.length - 12));
    const r = await defaultAndAll('hard-computer.png', p);
    for (const id of ['png:computer', 'png:exif-text:computer']) assert.deepEqual([item(r.info, id)?.tier, item(r.info, id)?.label], ['red', 'Computer name'], id);
    assert.equal(item(r.info, 'png:software')?.tier, 'amber');
    for (const s of ['PNGHOST', 'PNGEXIFHOST']) assert.ok(!contains(r.red, H(s)), s);
    assert.ok(contains(r.red, 'Hardedit 3.0'), 'editing software is kept');
    assert.deepEqual(reds(r.backRed), []);
    samePixels('hard-computer-base.png', 'hard-computer.out-red.png');
  });

  test('JPEG: stray bytes, a DNL segment and JFIF padding are offered, and "Select all" still opens', async () => {
    const b0 = baseJpeg();
    const dqt = Buffer.from(b0).indexOf(Buffer.from([0xff, 0xdb]));
    const app0 = F.u8('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0], ` ${H('JFIFPAD')} `);
    const b = F.u8(b0.subarray(0, 2), F.jpegSeg(0xe0, app0), Buffer.from(`\0\0${H('STRAY')}\0`, 'latin1'),
      F.jpegSeg(0xdc, Buffer.from(`\0\0${H('DNL')}`, 'latin1')), b0.subarray(dqt));
    const { info, red, all, backAll } = await defaultAndAll('hard-segments.jpg', b);
    for (const id of ['jpeg:stray', 'jpeg:marker', 'jpeg:jfif-extra']) assert.equal(tierOf(info, id), 'red', id);
    for (const s of ['STRAY', 'DNL', 'JFIFPAD']) { assert.ok(!contains(red, H(s)), s); assert.ok(!contains(all, H(s)), s); }
    assert.deepEqual([...all.subarray(0, 3)], [0xff, 0xd8, 0xff], 'the file still starts like a JPEG');
    assert.deepEqual(ids(backAll), []);
    samePixels('hard-segments.jpg', 'hard-segments.out-all.jpg');
  });

  test('JPEG: a cut-off file offers its damaged end, and an empty result is still a JPEG', async () => {
    const full = F.jpegInsert(baseJpeg(), exifSeg(tiffLE([{ name: 'ifd0', entries: [{ tag: 0x013b, type: 2, data: H('CUTARTIST') }] }])));
    const at = Buffer.from(full).indexOf(Buffer.from(H('CUTARTIST'))) + 6;
    const { info, all } = await defaultAndAll('hard-cut.jpg', full.subarray(0, at), { write: false });
    assert.equal(tierOf(info, 'jpeg:damaged'), 'red');
    assert.ok(!contains(all, 'HARD-C'));
    const tiny = await core.scrub(new Uint8Array([0xff, 0xd8, 0xff, 0xe1]), ['jpeg:damaged']);
    assert.equal(core.detectFormat(tiny.bytes), 'jpeg');
    assert.deepEqual((await core.inspect(tiny.bytes)).items, []);
  });

  test('PNG: data in IEND, after a damaged chunk name, and at a cut-off end', async () => {
    F.magick(['-size', '64x48', 'plasma:fractal', '-seed', '172', '-strip', `PNG24:${F.path('hard-base.png')}`]);
    const png = F.read('hard-base.png');
    const head = png.subarray(0, png.length - 12);
    const text = (k, v) => F.pngChunk('tEXt', F.u8(k, [0], v));
    const cases = {
      'hard-iend.png': F.u8(head, F.pngChunk('IEND', Buffer.from(H('IEND')))),
      'hard-badtype.png': F.u8(head, be32(4), 'tE1t', 'abcd', be32(0), text('Author', H('AFTERBAD')), png.subarray(png.length - 12)),
      'hard-truncated.png': (() => { const t = text('Author', `${H('TRUNC')} and some more text`); return F.u8(head, t.subarray(0, t.length - 10)); })(),
      'hard-location.png': F.u8(head, text('Location', H('PLACE')), text('GPSLatitude', '59.913912'), png.subarray(png.length - 12)),
    };
    for (const [name, b] of Object.entries(cases)) {
      const { red, all, backRed } = await defaultAndAll(name, b);
      for (const out of [red, all]) {
        assert.ok(!contains(out, 'HARD-') && !contains(out, '59.913912'), `${name}: planted data left`);
        assert.ok(Buffer.from(out).subarray(-12).equals(Buffer.from(png.subarray(png.length - 12))), `${name}: ends with a clean IEND`);
      }
      assert.deepEqual(reds(backRed), [], name);
      samePixels('hard-base.png', name.replace('.png', '.out-red.png'));
    }
  });

  test('WebP: a cut-off last chunk is offered and removed', async () => {
    F.magick(['-size', '64x48', 'plasma:fractal', '-seed', '173', '-strip', '-define', 'webp:lossless=true', F.path('hard-base.webp')]);
    const w = Buffer.from(F.read('hard-base.webp'));
    const tiff = tiffLE([{ name: 'ifd0', entries: [{ tag: 0x013b, type: 2, data: H('WEBPCUT') }] }]);
    const body = Buffer.concat([Buffer.from('WEBP'), Buffer.from('VP8X'), le32(10), Buffer.from([0x08, 0, 0, 0, 63, 0, 0, 47, 0, 0]), w.subarray(12), Buffer.from('EXIF'), le32(tiff.length + 50), tiff]);
    const b = new Uint8Array(Buffer.concat([Buffer.from('RIFF'), le32(body.length), body]));
    const { info, red } = await defaultAndAll('hard-cut.webp', b, { write: false });
    assert.equal(tierOf(info, 'webp:damaged'), 'red');
    assert.ok(!contains(red, H('WEBPCUT')));
    assert.equal(Buffer.from(red).readUInt32LE(4), red.length - 8, 'RIFF size fixed');
  });

  test('Content Credentials that repeat the computer name are red', async () => {
    const box = (type, body) => Buffer.concat([be32(8 + body.length), Buffer.from(type), body]);
    const json = JSON.stringify({ 'tiff:HostComputer': H('C2PAHOST') });
    const jumb = box('jumb', Buffer.concat([box('jumd', Buffer.concat([Buffer.from('6332706100110010800000aa00389b71', 'hex'), Buffer.from([3]), Buffer.from('c2pa\0')])), box('json', Buffer.from(json))]));
    const b = F.jpegInsert(baseJpeg(), F.jpegSeg(0xeb, F.u8('JP', [0, 1], [0, 0, 0, 1], jumb)));
    const { info, red } = await defaultAndAll('hard-c2pa-host.jpg', b);
    const item = info.items.find((i) => i.id === 'jpeg:c2pa');
    assert.equal(item.tier, 'red');
    assert.match(item.value, /computer name/);
    assert.ok(!contains(red, H('C2PAHOST')));
  });

  test('Content Credentials that repeat the position or a serial are red', async () => {
    const json = JSON.stringify({ 'exif:GPSLatitude': '59,54.8346N', 'exif:BodySerialNumber': H('C2PASERIAL') });
    const box = (type, body) => Buffer.concat([be32(8 + body.length), Buffer.from(type), body]);
    const jumb = box('jumb', Buffer.concat([box('jumd', Buffer.concat([Buffer.from('6332706100110010800000aa00389b71', 'hex'), Buffer.from([3]), Buffer.from('c2pa\0')])), box('json', Buffer.from(json))]));
    const b = F.jpegInsert(baseJpeg(), F.jpegSeg(0xeb, F.u8('JP', [0, 1], [0, 0, 0, 1], jumb)));
    const { info, red } = await defaultAndAll('hard-c2pa.jpg', b);
    const item = info.items.find((i) => i.id === 'jpeg:c2pa');
    assert.equal(item.tier, 'red');
    assert.match(item.value, /location, serial number/);
    assert.ok(!contains(red, H('C2PASERIAL')));
  });

  test('thousands of repeated parts do not slow the engine down', async () => {
    const dup = exifSeg(tiffLE([{ name: 'ifd0', entries: [{ tag: 0x013b, type: 2, data: 'Dup' }] }]));
    const b = F.jpegInsert(baseJpeg(), ...Array.from({ length: 6000 }, () => dup));
    const t0 = performance.now();
    const info = await core.inspect(b);
    const out = await core.scrub(b, ids(info));
    const ms = performance.now() - t0;
    assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
    assert.ok(info.items.length < 40, `${info.items.length} items`);
    assert.ok(!contains(out.bytes, 'Dup'));
  });
});
