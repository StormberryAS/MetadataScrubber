// Engine tests for src/scrub-core.js. Run from the repository root with: node --test tests/
//
// Every picture is generated here (see core-fixtures.mjs). Each format is checked the same
// way: inspect() finds the planted items with the right tiers; scrubbing the red items
// removes them (checked with exiftool and by searching the bytes for planted strings);
// scrubbing every item leaves nothing but structure; decoded pixels never change; and
// exiftool -validate reports nothing new.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

import * as core from '../src/scrub-core.js';
import { parseTiff, removeTiffKeys } from '../src/core/tiff.js';
import { addXmpItems, canonicalXmp, parseXmp, planXmp, rewriteXmp } from '../src/core/xmp.js';
import { walkJpeg } from '../src/core/jpeg.js';
import { parseHeif } from '../src/core/heic.js';
import { cleanIcc, inspectIcc, md5 } from '../src/core/icc.js';
import { ItemSet } from '../src/core/taxonomy.js';
import { describeC2pa } from '../src/core/c2pa.js';
import { IPTC_ITEMS } from '../src/core/iptc.js';
import { TIFF_ITEMS } from '../src/core/tiff.js';
import { XMP_ITEMS } from '../src/core/xmp.js';
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

// XMP is only ever kept in the canonical form, so a kept JPEG (a gain map, say) is the same
// as its source apart from its XMP, whose properties are the same.
const XMP_HEAD = 'http://ns.adobe.com/xap/1.0/\0';
function sameButXmp(a, b) {
  const parts = (x) => {
    const w = walkJpeg(x);
    const segs = w.segs.filter((s) => !(s.kind === 'seg' && s.marker === 0xe1 && Buffer.from(x.subarray(s.dataStart, s.dataStart + XMP_HEAD.length)).toString('latin1') === XMP_HEAD));
    const xmp = w.segs.filter((s) => !segs.includes(s)).map((s) => canonicalXmp(parseXmp(Buffer.from(x.subarray(s.dataStart + XMP_HEAD.length, s.end)).toString('utf8')), true));
    return { body: Buffer.concat(segs.map((s) => Buffer.from(x.subarray(s.start, s.end)))), xmp };
  };
  const pa = parts(a);
  const pb = parts(b);
  return pa.body.equals(pb.body) && JSON.stringify(pa.xmp) === JSON.stringify(pb.xmp);
}

// An HEIC whose XMP was written again: the same boxes, nothing damaged, and every item that
// is not XMP holds what it held (or zeros, for what was removed).
function heicIntact(inBytes, outBytes, label) {
  const a = parseHeif(inBytes);
  const o = parseHeif(outBytes);
  assert.deepEqual(o.warnings, [], `${label}: the output reads without warnings`);
  assert.equal(o.top.map((x) => x.type).join(), a.top.map((x) => x.type).join(), `${label}: the same top-level boxes`);
  assert.equal(o.metaKids.map((x) => x.type).join(), a.metaKids.map((x) => x.type).join(), `${label}: the same boxes in meta`);
  const read = (b, it) => Buffer.concat((it.ranges || []).map(([s, e]) => Buffer.from(b.subarray(s, e))));
  for (const it of a.items.values()) {
    const it2 = o.items.get(it.id);
    assert.ok(it2, `${label}: item ${it.id} is still there`);
    if (it.contentType === 'application/rdf+xml') continue;
    const before = read(inBytes, it);
    const after = read(outBytes, it2);
    assert.equal(after.length, before.length, `${label}: item ${it.id} keeps its length`);
    // EXIF is edited in place by the TIFF engine; anything else is kept or zeroed.
    if (it.type === 'Exif') continue;
    assert.ok(after.equals(before) || after.every((x, i) => x === before[i] || x === 0), `${label}: item ${it.id} holds what it held`);
  }
  return o;
}

// Shared checks for one fixture: red only, then everything.
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

  test('scrub with no ids only writes XMP in the canonical form, then returns an identical copy', async () => {
    const b = F.read(F.jpegFull());
    const info = await core.inspect(b);
    assert.equal(info.normalise, true, 'the planted XMP is not in the canonical form');
    const res = await core.scrub(b, []);
    const back = await core.inspect(res.bytes);
    assert.deepEqual(back.items.map((i) => `${i.id}=${i.value}`), info.items.map((i) => `${i.id}=${i.value}`), 'nothing is removed');
    assert.equal(back.normalise, false);
    const again = await core.scrub(res.bytes, []);
    assert.ok(Buffer.from(again.bytes).equals(Buffer.from(res.bytes)));
    assert.notEqual(again.bytes, res.bytes);
    const png = F.read(F.pngFull());
    const p1 = (await core.scrub(png, [])).bytes;
    assert.ok(Buffer.from((await core.scrub(p1, [])).bytes).equals(Buffer.from(p1)), 'PNG: identical once canonical');
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
    assert.deepEqual(keys, ['exif:GPSLatitude', 'exif:GPSLongitude', 'xmp:CreateDate', 'dc:creator', 'dc:title', 'xml:hidden']);
    assert.equal(p.props.find((x) => x.key === 'dc:creator').value, 'Alice & Bob');
    // A prefix is a name the writer chooses: an unusual one for a known namespace is hidden
    // text of its own, and a rewrite writes the usual prefix.
    assert.equal(p.props.find((x) => x.kind === 'hidden').value, 'prefix e for exif');
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
    // One prefix bound to two unknown namespaces in two nodes cannot share one fresh node
    // (known namespaces are written with their usual prefixes, so they never clash).
    const p = parseXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="48,51.504N"/>
<rdf:Description rdf:about="" xmlns:a="http://example.com/one/" a:Thing="2026"/>
<rdf:Description rdf:about="" xmlns:a="http://example.com/two/"><a:title>T</a:title></rdf:Description>
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
      'exif:camera': 'amber', 'exif:lens': 'amber', 'exif:software': 'amber', 'exif:description': 'red',
      'exif:orientation': 'green', 'exif:exposure': 'green', 'exif:resolution': 'green',
      'xmp:creator': 'red', 'xmp:place': 'red', 'xmp:ids': 'red', 'xmp:serial': 'red', 'xmp:gps': 'red', 'xmp:rights': 'red',
      'xmp:dates': 'amber', 'xmp:history': 'red', 'xmp:software': 'amber', 'xmp:camera': 'amber', 'xmp:description': 'red',
      'xmp:copyright': 'red', 'xmp:technical': 'green',
      'iptc:byline': 'red', 'iptc:place': 'red', 'iptc:contact': 'red', 'iptc:credit': 'red', 'iptc:copyright': 'red',
      'iptc:caption': 'red', 'iptc:keywords': 'red', 'iptc:dates': 'amber', 'iptc:instructions': 'red',
      'icc:profile': 'green', 'jpeg:comment': 'red', 'jpeg:jfif': 'green', 'jpeg:c2pa': 'red', 'jpeg:adobe': 'green',
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
    // The colord profile's translated names and its long device description are not on the
    // list of well-known profile text, so they are a red detail of their own.
    assert.equal(tierOf(info, 'icc:text'), 'red');
    assert.match(v('jpeg:app9:acmecam'), /^ACMECAM/);
    assert.equal(v('exif:exposure'), '1/125 s, f/1.9, ISO 100, 6.8 mm');
    const c2pa = info.items.find((i) => i.id === 'jpeg:c2pa');
    assert.equal(c2pa.label, 'Content Credentials (C2PA)');
    assert.match(c2pa.note, /proof of where the image came from/);
    assert.equal(info.items.find((i) => i.id === 'exif:thumbnail').note, 'Can still show the original, uncropped photo after cropping.');
  });

  test('full fixture: red only, everything, pixels and validity', async () => {
    const { res } = await standardChecks(F.jpegFull(), 'jpeg', {
      redStrings: [PLANT.artist, PLANT.owner, PLANT.serial, PLANT.lensSerial, PLANT.uniqueId, PLANT.xmpCreator, PLANT.xmpCity,
        PLANT.xmpDocId, PLANT.xmpAuxSerial, PLANT.iptcByline, PLANT.iptcCity, PLANT.iptcContact, PLANT.unknownApp, PLANT.trailing,
        'GPS-AREA-PLANT', 'Xmp Rightsowner', PLANT.copyright, 'Iptc credit line', 'Iptc copyright notice', PLANT.computer,
        PLANT.description, PLANT.comment, 'FakeCam C2PA PLANT'],
      keptStrings: [PLANT.make, PLANT.software],
      redTags: [['GPS', 'GPSLatitude'], ['GPS', 'GPSAreaInformation'], ['IFD0', 'Artist'], ['ExifIFD', 'OwnerName'],
        ['ExifIFD', 'SerialNumber'], ['ExifIFD', 'LensSerialNumber'], ['ExifIFD', 'ImageUniqueID'], ['IFD1', 'ThumbnailImage'],
        ['XMP-dc', 'Creator'], ['XMP-photoshop', 'City'], ['XMP-xmpMM', 'DocumentID'], ['XMP-aux', 'SerialNumber'],
        ['XMP-exif', 'GPSLatitude'], ['XMP-xmpRights', 'Owner'], ['IPTC', 'By-line'], ['IPTC', 'City'], ['IPTC', 'Contact'],
        ['Photoshop', 'PhotoshopThumbnail'], ['IFD0', 'Copyright'], ['IPTC', 'Credit'], ['IPTC', 'CopyrightNotice'], ['IFD0', 'HostComputer'],
        ['XMP-xmpMM', 'HistoryAction'], ['File', 'Comment'], ['JUMBF', 'JUMDLabel']],
      keptTags: [['IFD0', 'Make'], ['IFD0', 'Software'], ['IFD0', 'Orientation'], ['ExifIFD', 'DateTimeOriginal'],
        ['ExifIFD', 'OffsetTimeOriginal'], ['XMP-xmp', 'CreateDate'],
        ['ICC_Profile', 'ProfileDescription'], ['Adobe', 'DCTEncodeVersion'],
        ['JFIF', 'JFIFVersion']],
    });
    // Content Credentials are red since 0.0.3 (review of 4 October 2026), so they go too.
    assert.ok(!res.warnings.some((w) => /Content Credentials were kept/.test(w)), 'no kept C2PA to warn about');
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
    // The gain map holds nothing but what it needs and an XMP toolkit name, which is never
    // listed or written (0.0.3), so there is no metadata detail inside it.
    assert.equal(tierOf(info, 'jpeg:trailing:gain-map:metadata'), undefined);

    await scrubTo('motion.out-red.jpg', b, reds(info).filter((id) => id !== 'jpeg:trailing:gain-map:metadata'));
    const out = F.read('motion.out-red.jpg');
    assert.ok(!contains(out, 'VIDEO-PLANT-SECRET') && !contains(out, 'GCamera:MotionPhoto'));
    const rows = F.exifRead(F.path('motion.out-red.jpg'));
    assert.ok(!rows.some((r) => r.tag === 'MotionPhotoVideo'));
    assert.ok(hasTag(rows, 'XMP-hdrgm', 'Version'));
    // The MPF index must still point at the gain map, byte for byte.
    const start = Number(rows.find((r) => r.group === 'MPImage2' && r.tag === 'MPImageStart').value);
    const len = Number(rows.find((r) => r.group === 'MPImage2' && r.tag === 'MPImageLength').value);
    // The same gain map, its XMP written in the canonical form.
    const gain = F.read('motion-gain-only.jpg');
    assert.ok(sameButXmp(out.subarray(start, start + len), gain), 'MPF offset fixed after the primary shrank');
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
      'png:author': 'red', 'png:copyright': 'red', 'png:dates': 'amber', 'png:software': 'amber', 'png:description': 'red',
      'png:title': 'red', 'png:comment': 'red', 'png:notes': 'red', 'png:time': 'amber', 'png:colour': 'green',
      'png:chunk:prvt': 'red', 'png:c2pa': 'red', 'png:trailing': 'red',
    };
    for (const [id, tier] of Object.entries(expect)) assert.equal(tierOf(info, id), tier, id);
    assert.equal(info.items.find((i) => i.id === 'png:comment').value, 'ZTXT-PLANT-COMMENT', 'zTXt inflated');
    assert.equal(info.items.find((i) => i.id === 'png:notes').value, 'ITXT-PLANT-WARNING', 'compressed iTXt inflated');
    assert.equal(info.items.find((i) => i.id === 'png:c2pa').source, 'C2PA');
  });

  test('full fixture: red only, everything, pixels and validity', async () => {
    await standardChecks(F.pngFull(), 'png', {
      redStrings: [PLANT.owner, PLANT.xmpCreator, PLANT.xmpCity, PLANT.xmpDocId, 'PRVT-PLANT-SECRET', 'PNGTAIL-PLANT-SECRET', 'GPS-AREA-PLANT', PLANT.copyright,
        PLANT.description, 'FakeCam C2PA PLANT'],
      keptStrings: [PLANT.software],
      redTags: [['GPS', 'GPSLatitude'], ['IFD0', 'Artist'], ['ExifIFD', 'SerialNumber'], ['PNG', 'Author'], ['XMP-dc', 'Creator'],
        ['XMP-photoshop', 'City'], ['IPTC', 'By-line'], ['PNG', 'Comment']],
      keptTags: [['IFD0', 'Make'], ['ExifIFD', 'DateTimeOriginal'], ['PNG', 'Software'],
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
    assert.ok(rows.some((r) => r.tag === 'DateCreated' && r.value === '2026:09:14'), 'the IPTC date (amber) is kept in the rebuilt profile');
    assert.ok(!rows.some((r) => r.tag === 'Keywords'), 'keywords are free text, so red, so they go');
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
      'xmp:dates': 'amber', 'icc:profile': 'green', 'webp:chunk:prvt': 'red', 'webp:c2pa': 'red', 'webp:trailing': 'red' };
    for (const [id, tier] of Object.entries(expect)) assert.equal(tierOf(info, id), tier, id);
    await standardChecks(name, 'webp', {
      redStrings: [PLANT.artist, PLANT.serial, PLANT.xmpCreator, 'PRVT-PLANT-ODD', 'WEBPTAIL-PLANT', 'GPS-AREA-PLANT', 'FakeCam C2PA PLANT'],
      keptStrings: [PLANT.make],
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
    // Only the XMP changes length (it is written in the canonical form); every other item
    // holds what it held, and the structure reads back cleanly.
    for (const n of ['exiftool.out-red.heic', 'exiftool.out-all.heic']) heicIntact(b, F.read(n), n);
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
        const o = heicIntact(b, out, n);
        const at = (id) => Buffer.concat(o.items.get(id).ranges.map(([s, e]) => out.subarray(s, e)));
        assert.ok(at(2).every((x) => x === 0), 'preview data zeroed');
        assert.ok(at(1).equals(Buffer.from(b).subarray(...built.primRange)), 'picture data untouched');
        // The XMP, spread over two extents with padding after it, is one extent now, in the
        // canonical form with no padding (or an empty packet, when all of it went).
        assert.equal(o.items.get(4).ranges.length, 1, 'the XMP item has one extent');
        const x = at(4).toString('utf8');
        if (n.includes('out-all')) assert.equal(x, '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
        // HEIC XMP is written without the packet wrapper, as Apple writes it.
        else assert.equal(canonicalXmp(parseXmp(x), true), x, 'the XMP is in the canonical form');
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

  test('JPEG: stray bytes, a DNL segment and JFIF padding are offered, and ticking every detail still opens', async () => {
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

// ======================================================================================
// The HDR gain map is kept by default (app.js defaultIds leaves an amber gain map and its
// amber description unticked). It may keep only what a gain map needs to render; anything
// else in or around it must be offered as its own detail and go when it is ticked.

const GAIN_OWN = new Set(['jpeg:trailing:gain-map', 'heic:gain-map', 'xmp:gainmap', 'exif:apple-hdr']);
const HDRGM_TAGS = new Set(['Version', 'GainMapMin', 'GainMapMax', 'Gamma', 'OffsetSDR', 'OffsetHDR', 'HDRCapacityMin', 'HDRCapacityMax', 'BaseRenditionIsHDR']);

// Every red and amber detail ticked, except an amber HDR gain map and its own amber
// details: what a user gets who ticks Amber and leaves the gain map unticked (the page's
// starting selection before 0.0.3; since 0.0.3 the page ticks red only, which the
// red-only checks cover). It is the stricter test: amber must go too, the gain map stays.
function redAmberIds(info) {
  const hdr = info.items.some((i) => (i.id === 'jpeg:trailing:gain-map' || i.id === 'heic:gain-map') && i.tier === 'amber');
  return info.items.filter((i) => i.tier !== 'green' && !(hdr && GAIN_OWN.has(i.id))).map((i) => i.id);
}

// The images an MPF index lists, read straight from the bytes: [{ index, offset, size }]
// with absolute offsets, or null without an index.
function mpfImages(bytes) {
  const b = Buffer.from(bytes);
  const w = walkJpeg(bytes);
  const s = w.segs.find((x) => x.kind === 'seg' && x.marker === 0xe2 && b.toString('latin1', x.dataStart, x.dataStart + 4) === 'MPF\0');
  if (!s) return null;
  const t = s.dataStart + 4;
  const le = b.toString('latin1', t, t + 2) === 'II';
  const r16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const r32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = t + r32(t + 4);
  for (let i = 0; i < r16(ifd); i++) {
    const e = ifd + 2 + i * 12;
    if (r16(e) !== 0xb002) continue;
    const at = t + r32(e + 8);
    return Array.from({ length: r32(e + 4) / 16 }, (_, k) => ({ index: k, size: r32(at + 16 * k + 4), offset: k ? t + r32(at + 16 * k + 8) : 0 }));
  }
  return [];
}

// The Container directory entries of the photo XMP: [{ semantic, length, padding }].
function directoryEntries(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  return [...text.matchAll(/<Container:Item\b([^>]*)>/g)].map((m) => {
    const at = (n) => { const x = new RegExp(`Item:${n}="([^"]*)"`).exec(m[1]); return x ? x[1] : null; };
    return { semantic: at('Semantic'), length: at('Length') === null ? null : Number(at('Length')), padding: at('Padding') === null ? null : Number(at('Padding')) };
  });
}

// The kept gain map is still found through MPF as a whole JPEG, the directory gives its
// length, its pixels are those of the input's gain map and its hdrgm values are unchanged.
function gainMapRenders(inName, outName) {
  const out = F.read(outName);
  const imgs = mpfImages(out);
  assert.ok(imgs && imgs.length === 2, `${outName}: an MPF index with two images`);
  assert.equal(imgs[0].size, walkJpeg(out).eoiEnd, `${outName}: MPF size of the photo`);
  const g = imgs[1];
  const sub = out.subarray(g.offset, g.offset + g.size);
  assert.ok(sub[0] === 0xff && sub[1] === 0xd8 && sub[2] === 0xff, `${outName}: the gain map entry starts with SOI`);
  const w = walkJpeg(sub);
  assert.ok(w && w.eoiEnd > 0 && w.eoiEnd <= g.size, `${outName}: the gain map ends inside its MPF size`);
  const dir = directoryEntries(out).find((e) => e.semantic === 'GainMap');
  assert.ok(dir, `${outName}: the directory still lists the gain map`);
  assert.equal(dir.length, g.size, `${outName}: Item:Length equals the gain map's MPF size`);
  const gOut = F.write(`${outName}.gain.jpg`, sub.subarray(0, w.eoiEnd));
  // The input's gain map: its companion file, or taken out of the input (named .out so the
  // audit does not judge it as a photo of its own).
  let gInName = `${inName}.gain.jpg`;
  if (!existsSync(F.path(gInName))) {
    const src = F.read(inName);
    const gi = mpfImages(src)[1];
    gInName = `${inName}.out-gain-in.jpg`;
    F.write(gInName, src.subarray(gi.offset, gi.offset + gi.size));
  }
  const hashes = F.decodeHashes([F.path(gInName), gOut]);
  assert.ok(hashes[0] && hashes[0] === hashes[1], `${outName}: the gain map's pixels are unchanged`);
  const hdrgm = (file) => F.exifRead(file).filter((r) => r.group === 'XMP-hdrgm' && HDRGM_TAGS.has(r.tag)).map((r) => `${r.tag}=${r.value}`).sort();
  const before = hdrgm(F.path(gInName)).filter((x) => !/CANARY|PLANT/.test(x));
  assert.deepEqual(hdrgm(gOut), before, `${outName}: the gain map's hdrgm values are unchanged`);
}

const P = PLANT.hdr;
const P2 = PLANT.hdr2;
const PA = PLANT.hdrAmber;
const CREATOR = `<dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Seq><rdf:li>${P}</rdf:li></rdf:Seq></dc:creator>`;
const int32 = (le, v) => { const x = Buffer.alloc(4); if (le) x.writeUInt32LE(v); else x.writeUInt32BE(v); return x; };
const mpfExtras = (le) => ({
  le, b004: 2,
  ids: F.u8(P.padEnd(32, '0'), [0], '0'.repeat(32), [0]),
  attr: [[0xb101, 4, 1, int32(le, 1)], [0xb2ee, 2, P2.length + 1, Buffer.from(`${P2}\0`, 'latin1')]],
});
// A small picture to hide after a gain map. The comment is added in memory only, so the file
// on disk (which the audit also reads) carries no planted string.
const hiddenJpeg = () => { F.magick(['-size', '16x16', 'xc:gray', '-strip', F.path('hdr-hidden.jpg')]); return F.jpegInsert(F.read('hdr-hidden.jpg'), F.jpegSeg(0xfe, `Ingrid ${P}`)); };

// name, builder options, the details that must be offered for what was hidden
const GAIN_VARIANTS = [
  ['hdrgm-extra', { photoAttrs: `hdrgm:CameraSerialNumber="${P}" hdrgm:GPSLatitude="59,24.5N ${P2}"` }, ['xmp:serial', 'xmp:gps']],
  ['item-label', { itemAttrs: `Item:Label="${P}" Item:URI="${P2}"` }, ['xmp:container-extra']],
  ['dir-child', { dirExtra: `<Container:Note>${P}</Container:Note>`, itemBody: `<Item:Comment>${P2}</Item:Comment>` }, ['xmp:container-extra']],
  ['apple-owner', { photoNs: 'xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/"', photoAttrs: `HDRGainMap:HDRGainMapVersion="65536" HDRGainMap:OwnerName="${P}"` }, ['xmp:owner']],
  ['version-text', { version: `1.0 ${P}` }, ['xmp:gainmap-other']],
  ['fake-prefix', { photoNs: 'xmlns:hdrgm2="http://example.invalid/hdrgm/"', photoAttrs: `hdrgm2:Gamma="1" hdrgm2:Mood="${P}"` }, ['xmp:other']],
  ['inner-hdrgm', { gainAttrs: `hdrgm:CameraSerialNumber="${P}"` }, ['jpeg:trailing:gain-map:metadata']],
  ['inner-seq-text', { gainBody: `<hdrgm:OffsetHDR><rdf:Seq><rdf:li>0.1</rdf:li><rdf:li>${P}</rdf:li><rdf:li>0.1</rdf:li></rdf:Seq></hdrgm:OffsetHDR>`, gainFields: 'hdrgm:Version="1.0" hdrgm:GainMapMax="2.3" hdrgm:HDRCapacityMax="2.3"' }, ['jpeg:trailing:gain-map:metadata']],
  ['inner-creator', { gainBody: CREATOR, gainToolkit: 'FakeXMP Core 1.0' }, ['jpeg:trailing:gain-map:metadata']],
  ['after-eoi', { gainToolkit: 'FakeXMP Core 1.0', after: `Ingrid ${P}` }, ['jpeg:trailing:gain-map:after']],
  ['bare-after-eoi', { after: P }, ['jpeg:trailing:gain-map:after']],
  ['after-jpeg', { after: 'JPEG' }, ['jpeg:trailing:gain-map:after']],
  ['mpf-tail', { mpf: { tail: ` ${P}` } }, ['jpeg:mpf:extra']],
  ['mpf-extras-le', { mpf: mpfExtras(true) }, ['jpeg:mpf:ids', 'jpeg:mpf:extra']],
  ['mpf-extras-be', { mpf: mpfExtras(false) }, ['jpeg:mpf:ids', 'jpeg:mpf:extra']],
  ['iso-tail', { photoIso: [F.u8(F.isoBlock({ full: false }), ` ${P}`)] }, ['jpeg:isogain:extra']],
  ['iso-second', { photoIso: [F.isoBlock({ full: false }), F.u8(F.isoBlock({ full: false }), P)] }, ['jpeg:isogain:extra']],
  ['iso-surplus', { photoIso: [F.u8(F.isoBlock({ channels: 3, common: true }), P)] }, ['jpeg:isogain:extra']],
  ['inner-iso', { gainIso: [F.u8(F.isoBlock({ full: false }), ` ${P}`)] }, ['jpeg:trailing:gain-map:metadata']],
  ['inner-mpf', { gainSegs: [F.jpegSeg(0xe2, F.mpfPayload({ entries: [[0, 0, 0]], tail: P }))] }, ['jpeg:trailing:gain-map:metadata']],
  ['semantic-name', { extraLi: `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="${P}" Item:Mime="image/${P2}" Item:Length="0"/></rdf:li>` }, ['xmp:container-extra']],
  ['mime-name', { gainMime: `image/${P}` }, ['xmp:container-extra']],
  ['inner-gpano', { companion: false, gainAttrs: `xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:Note="Ingrid ${PA}"` }, ['jpeg:trailing:gain-map:metadata']],
  ['inner-rating', { companion: false, gainAttrs: `xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="${PA}"` }, ['jpeg:trailing:gain-map:metadata']],
  ['inner-iccname', { companion: false, gainAttrs: `xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:ICCProfile="Ingrid ${PA}"` }, ['jpeg:trailing:gain-map:metadata']],
  ['gm-icc-text', { companion: false, gainSegs: [F.iccSegment(F.iccProfile({ desc: 'sRGB gain', cprt: `Copyright Ingrid ${PA}`, more: [['dmdd', `Model ${PA}`]] }))] }, ['jpeg:trailing:gain-map:colour-text']],
  ['iso-only-tail', { noVersion: true, noGainXmp: true, gainIso: [F.isoBlock({ channels: 1 })], photoIso: [F.u8(F.isoBlock({ full: false }), ` ${P}`)] }, ['jpeg:isogain:extra']],
  ['everything', { exif: true, photoAttrs: `hdrgm:CameraSerialNumber="${P2}"`, mpf: { ...mpfExtras(true), tail: ' tail' }, photoIso: [F.u8(F.isoBlock({ full: false }), 'xx')], gainBody: CREATOR, after: 'after' }, ['exif:owner', 'xmp:serial', 'jpeg:mpf:ids', 'jpeg:mpf:extra', 'jpeg:isogain:extra', 'jpeg:trailing:gain-map:metadata', 'jpeg:trailing:gain-map:after']],
];
const buildVariant = ([name, opts]) => F.gainMapJpeg(`gm-${name}.jpg`, opts.after === 'JPEG' ? { ...opts, after: hiddenJpeg() } : opts);

describe('HDR gain map kept', () => {
  test('only the fields a gain map needs are allowlisted, each with a value of the right form', async () => {
    const packet = (attrs, body = '', ns = '') => parseXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" ${ns} ${attrs}>${body}</rdf:Description></rdf:RDF></x:xmpmeta>`);
    const keysOf = (parsed) => {
      const set = new ItemSet();
      const out = {};
      for (const it of addXmpItems(set, parsed, { gainMapTier: 'amber' }, {}, 0)) for (const i of it.props) out[parsed.props[i].key + (parsed.props[i].kind === 'sub' ? '(sub)' : '')] = it.key;
      return out;
    };
    const dir = '<Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="1000" Item:Padding="0"/></rdf:li></rdf:Seq></Container:Directory>';
    const seq = (n) => `<hdrgm:Gamma><rdf:Seq>${'<rdf:li>1</rdf:li>'.repeat(n)}</rdf:Seq></hdrgm:Gamma>`;
    const all = keysOf(packet('hdrgm:Version="1.0" hdrgm:GainMapMin="-0.5" hdrgm:GainMapMax="2.3" hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR=".015625" hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="2.3e0" hdrgm:BaseRenditionIsHDR="False" HDRGainMap:HDRGainMapVersion="65536" HDRGainMap:HDRGainMapHeadroom="3.5"', seq(3) + dir));
    assert.deepEqual([...new Set(Object.values(all))], ['gainmap'], JSON.stringify(all));
    assert.equal(keysOf(packet('hdrgm:Version="1.0"', seq(2)))['hdrgm:Gamma'], 'gainmap-other', 'an rdf:Seq of two');
    assert.equal(keysOf(packet(`hdrgm:Version="1.0" hdrgm:Gamma="${'1'.repeat(12)}.${'0'.repeat(12)}e1234"`))['hdrgm:Gamma'], 'gainmap-other', 'a number with too many exponent digits');
    assert.equal(keysOf(packet(`hdrgm:Version="1.0" hdrgm:Gamma="${'1'.repeat(40)}"`))['hdrgm:Gamma'], 'gainmap-other', 'a number of 40 characters');
    assert.equal(keysOf(packet('hdrgm:Version="1.0 x"'))['hdrgm:Version'], 'gainmap-other', 'text in the version');
    assert.equal(keysOf(packet('hdrgm:Version="1.0" hdrgm:BaseRenditionIsHDR="false "'))['hdrgm:BaseRenditionIsHDR'], 'gainmap-other');
    assert.equal(keysOf(packet('hdrgm:Version="1.0"', '<hdrgm:Gamma xml:lang="en">1</hdrgm:Gamma>'))['hdrgm:Gamma'], 'gainmap-other', 'an attribute on the field');
    const twice = keysOf(packet('hdrgm:Version="1.0" hdrgm:Gamma="1"', '<hdrgm:Gamma>1</hdrgm:Gamma>'));
    assert.equal(twice['hdrgm:Gamma'], 'gainmap-other', 'a field given twice: the second copy is not allowlisted');
    const named = keysOf(packet('hdrgm:Version="1.0" hdrgm:GPSLatitude="59,24.5N" hdrgm:CameraSerialNumber="X1" HDRGainMap:OwnerName="Ingrid" hdrgm:Mood="calm"'));
    assert.equal(named['hdrgm:GPSLatitude'], 'gps');
    assert.equal(named['hdrgm:CameraSerialNumber'], 'serial');
    assert.equal(named['HDRGainMap:OwnerName'], 'owner');
    assert.equal(named['hdrgm:Mood'], 'gainmap-other');
    const extras = keysOf(packet('hdrgm:Version="1.0"', dir.replace('Item:Padding="0"', 'Item:Padding="0" Item:Label="Ingrid" Item:URI="x" Item:GPSAltitude="12"')));
    assert.equal(extras['Container:Directory'], 'gainmap');
    assert.equal(extras['Item:Label(sub)'], 'container-extra');
    assert.equal(extras['Item:URI(sub)'], 'container-extra');
    assert.equal(extras['Item:GPSAltitude(sub)'], 'gps', 'a field in the directory is judged by its name');
    const badDir = keysOf(packet('hdrgm:Version="1.0"', dir.replace(/rdf:Seq/g, 'rdf:Bag')));
    assert.equal(badDir['Container:Directory'], 'container-extra', 'a directory of another shape is not allowlisted');
    const fake = keysOf(packet('hdrgm2:Version="1.0"', '', 'xmlns:hdrgm2="http://example.invalid/"'));
    assert.notEqual(fake['hdrgm2:Version'], 'gainmap', 'the namespace URI decides, not the prefix');
  });

  test('every hidden extra is offered, goes with the starting selection, and the kept gain map still renders', async () => {
    for (const v of GAIN_VARIANTS) {
      const [label, , expect] = v;
      const name = buildVariant(v);
      const b = F.read(name);
      assert.ok(contains(b, P) || contains(b, P2) || contains(b, PA) || label === 'after-jpeg' || label === 'everything', `${label}: plant present`);
      const info = await core.inspect(b);
      assert.equal(tierOf(info, 'jpeg:trailing:gain-map'), 'amber', `${label}: the gain map is plausible and amber`);
      for (const id of expect) assert.ok(['red', 'amber'].includes(tierOf(info, id)), `${label}: ${id} offered (${ids(info).join(' ')})`);
      const out = `gm-${label}.out-start.jpg`;
      const res = await scrubTo(out, b, redAmberIds(info));
      assert.ok(!res.warnings.some((w) => /gain map/i.test(w)), `${label}: ${res.warnings.join(' / ')}`);
      const o = F.read(out);
      for (const s of [P, P2, PA, 'Ingrid']) assert.ok(!contains(o, s), `${label}: "${s}" must be gone`);
      const back = await core.inspect(o);
      const left = back.items.filter((i) => i.tier !== 'green').map((i) => i.id).sort();
      assert.deepEqual(left, ['jpeg:trailing:gain-map', 'xmp:gainmap'], `${label}: read-back`);
      assert.equal(core.privacyWord(back.items), 'public', label);
      gainMapRenders(name, out);
      samePixels(name, out);
      // Loaded again, the starting selection ticks nothing, so the file stays as it is.
      assert.deepEqual(redAmberIds(back), [], `${label}: nothing ticked on the result`);
    }
  });

  test('every hidden extra can also go on its own, keeping everything else', async () => {
    for (const v of GAIN_VARIANTS.filter(([l]) => l !== 'everything')) {
      const [label, , expect] = v;
      const name = `gm-${label}.jpg`;
      const b = F.read(name);
      const out = `gm-${label}.out-one.jpg`;
      const res = await scrubTo(out, b, expect);
      assert.ok(!res.warnings.some((w) => /gain map/i.test(w)), `${label}: ${res.warnings.join(' / ')}`);
      for (const s of [P, P2, PA]) assert.ok(!contains(F.read(out), s), `${label}: "${s}" must be gone`);
      gainMapRenders(name, out);
    }
  });

  test('the directory length follows the cleaned gain map, and zero padding stays right', async () => {
    const name = F.gainMapJpeg('gm-numbers.jpg', { exif: true, gainBody: CREATOR, gainToolkit: 'FakeXMP Core 1.0' });
    const b = F.read(name);
    const info = await core.inspect(b);
    await scrubTo('gm-numbers.out.jpg', b, redAmberIds(info));
    const out = F.read('gm-numbers.out.jpg');
    const g = mpfImages(out)[1];
    assert.ok(g.size < F.read(`${name}.gain.jpg`).length, 'the gain map was cleaned');
    assert.equal(directoryEntries(out).find((e) => e.semantic === 'GainMap').length, g.size);
    gainMapRenders(name, 'gm-numbers.out.jpg');
    noNewWarnings(name, 'gm-numbers.out.jpg');

    const pad = F.gainMapJpeg('gm-padding.jpg', { lead: 32, after: Buffer.alloc(64), padding: [32, 0], gainBody: CREATOR });
    const pb = F.read(pad);
    const pinfo = await core.inspect(pb);
    assert.ok(!ids(pinfo).some((id) => /after|padding/.test(id)), `zero bytes are not hidden data: ${ids(pinfo).join(' ')}`);
    await scrubTo('gm-padding.out.jpg', pb, redAmberIds(pinfo));
    const po = F.read('gm-padding.out.jpg');
    const pg = mpfImages(po)[1];
    assert.equal(pg.offset - walkJpeg(po).eoiEnd, 32, 'the zero bytes before the gain map stay');
    assert.deepEqual(directoryEntries(po).map((e) => [e.semantic, e.padding]), [['Primary', 32], ['GainMap', 0]]);
    gainMapRenders(pad, 'gm-padding.out.jpg');
  });

  test('ISO 21496-1: the forms the standard defines stay, anything else is offered and cut exactly', async () => {
    const good = [F.isoBlock({ full: false }), F.isoBlock({ channels: 1, common: true }), F.isoBlock({ channels: 3, common: true }), F.isoBlock({ channels: 1 }), F.isoBlock({ channels: 3 })];
    const bad = [F.u8(F.isoBlock({ full: false }), 'X'), F.isoBlock({ flags: 0x81 }), F.isoBlock({ minVersion: 1 }), F.isoBlock({ channels: 3 }).subarray(0, 50)];
    for (const [n, p] of good.entries()) {
      const photo = await core.inspect(F.read(F.gainMapJpeg(`gm-iso-ok-${n}.jpg`, { photoIso: [p] })));
      assert.ok(!ids(photo).includes('jpeg:isogain:extra'), `allowed form ${n} in the photo`);
      const inner = await core.inspect(F.read(F.gainMapJpeg(`gm-iso-inner-ok-${n}.jpg`, { gainIso: [p] })));
      assert.ok(!ids(inner).includes('jpeg:trailing:gain-map:metadata'), `allowed form ${n} in the gain map`);
    }
    for (const [n, p] of [...bad, null].entries()) {
      const photoIso = p ? [p] : [F.isoBlock({ full: false }), F.isoBlock({ full: false })];
      const photo = await core.inspect(F.read(F.gainMapJpeg(`gm-iso-bad-${n}.jpg`, { photoIso })));
      assert.equal(tierOf(photo, 'jpeg:isogain:extra'), 'red', `bad form ${n} in the photo`);
      const inner = await core.inspect(F.read(F.gainMapJpeg(`gm-iso-inner-bad-${n}.jpg`, { gainIso: photoIso })));
      assert.equal(tierOf(inner, 'jpeg:trailing:gain-map:metadata'), 'red', `bad form ${n} in the gain map`);
    }
    // Surplus after a full block is cut to exactly the block, in the photo and the gain map.
    const block = F.isoBlock({ channels: 3, common: true });
    const name = F.gainMapJpeg('gm-iso-cut.jpg', { photoIso: [F.u8(block, 'SURPLUS')], gainIso: [F.u8(block, 'SURPLUS')] });
    const b = F.read(name);
    await scrubTo('gm-iso-cut.out.jpg', b, redAmberIds(await core.inspect(b)));
    const out = F.read('gm-iso-cut.out.jpg');
    const isoSegs = (bytes) => walkJpeg(bytes).segs.filter((s) => s.kind === 'seg' && s.marker === 0xe2 && Buffer.from(bytes.subarray(s.dataStart, s.dataStart + 28)).toString('latin1') === F.ISO_ID).map((s) => Buffer.from(bytes.subarray(s.dataStart, s.end)));
    assert.deepEqual(isoSegs(out), [Buffer.from(F.u8(F.ISO_ID, block))], 'photo segment cut to the block');
    const g = mpfImages(out)[1];
    assert.deepEqual(isoSegs(out.subarray(g.offset, g.offset + g.size)), [Buffer.from(F.u8(F.ISO_ID, block))], 'gain map segment cut to the block');
    assert.ok(!contains(out, 'SURPLUS'));
    gainMapRenders(name, 'gm-iso-cut.out.jpg');
    // A gain map with no XMP is still recognised by a full ISO block of its own.
    const isoOnly = await core.inspect(F.read(F.gainMapJpeg('gm-iso-only.jpg', { noGainXmp: true, gainIso: [F.isoBlock({ channels: 1 })] })));
    assert.equal(tierOf(isoOnly, 'jpeg:trailing:gain-map'), 'amber');
  });

  test('MPF: image IDs, layout details and unexplained data are separate, and the rebuilt index is valid', async () => {
    for (const le of [true, false]) {
      const name = F.gainMapJpeg(`gm-mpf-${le ? 'le' : 'be'}.jpg`, { mpf: { ...mpfExtras(le), tail: ` ${P}` } });
      const b = F.read(name);
      const info = await core.inspect(b);
      assert.equal(tierOf(info, 'jpeg:mpf:ids'), 'red');
      assert.equal(tierOf(info, 'jpeg:mpf:layout'), 'green');
      assert.equal(tierOf(info, 'jpeg:mpf:extra'), 'red');
      const out = `gm-mpf-${le ? 'le' : 'be'}.out.jpg`;
      await scrubTo(out, b, redAmberIds(info));
      const rows = F.exifRead(F.path(out));
      assert.ok(!hasTag(rows, 'MPF0', 'ImageUIDList') && hasTag(rows, 'MPF0', 'TotalFrames') && hasTag(rows, 'MPF0', 'MPIndividualNum'), JSON.stringify(rows.filter((r) => r.group === 'MPF0')));
      assert.ok(!contains(F.read(out), P) && !contains(F.read(out), P2));
      assert.equal(Buffer.from(F.read(out)).toString('latin1').includes(le ? 'MPF\0II' : 'MPF\0MM'), true, 'byte order kept');
      gainMapRenders(name, out);
      noNewWarnings(name, out);
      const out2 = `gm-mpf-${le ? 'le' : 'be'}.out-layout.jpg`;
      await scrubTo(out2, b, [...redAmberIds(info), 'jpeg:mpf:layout']);
      const rows2 = F.exifRead(F.path(out2));
      assert.ok(!hasTag(rows2, 'MPF0', 'TotalFrames') && !hasTag(rows2, 'MPF0', 'MPIndividualNum'));
      gainMapRenders(name, out2);
      const back = await core.inspect(F.read(out2));
      assert.ok(!ids(back).some((id) => /^jpeg:mpf/.test(id)), ids(back).join(' '));
    }
  });

  test('a second picture that is not plausibly a gain map is red, with its description', async () => {
    const cases = [
      ['colour full size, no gain map data', { noGainXmp: true, gain: { size: '320x240', colour: true } }],
      ['larger than the photo', { gain: { size: '400x300' } }],
      ['only a version-only ISO segment', { noGainXmp: true, gainIso: [F.isoBlock({ full: false })] }],
      ['hdrgm without GainMapMax or HDRCapacityMax', { gainFields: 'hdrgm:Version="1.0" hdrgm:Gamma="1"' }],
    ];
    for (const [label, opts] of cases) {
      const info = await core.inspect(F.read(F.gainMapJpeg(`gm-not-${cases.findIndex((c) => c[0] === label)}.jpg`, opts)));
      assert.ok(!ids(info).includes('jpeg:trailing:gain-map'), `${label}: ${ids(info).join(' ')}`);
      assert.equal(tierOf(info, 'jpeg:trailing:mpf-image'), 'red', label);
      assert.equal(tierOf(info, 'xmp:gainmap'), 'red', `${label}: the description follows`);
    }
  });

  test('Motion Photo with a gain map: the directory keeps exactly the parts that stay', async () => {
    const b = F.read(F.jpegMotion());
    const info = await core.inspect(b);
    await scrubTo('motion.gm-red.jpg', b, reds(info));
    const red = F.read('motion.gm-red.jpg');
    assert.deepEqual(directoryEntries(red).map((e) => e.semantic), ['Primary', 'GainMap']);
    assert.equal(directoryEntries(red)[1].length, mpfImages(red)[1].size);
    await scrubTo('motion.gm-start.jpg', b, redAmberIds(info));
    const start = F.read('motion.gm-start.jpg');
    assert.deepEqual(directoryEntries(start).map((e) => e.semantic), ['Primary', 'GainMap']);
    assert.equal(directoryEntries(start)[1].length, mpfImages(start)[1].size, 'length of the cleaned gain map');
    await scrubTo('motion.gm-none.jpg', b, ['jpeg:trailing:gain-map']);
    const none = F.read('motion.gm-none.jpg');
    const d = directoryEntries(none);
    assert.deepEqual(d.map((e) => e.semantic), ['Primary', 'MotionPhoto'], 'the video keeps its directory');
    assert.equal(d[1].length, none.length - walkJpeg(none).eoiEnd, 'the video length');
  });

  test('a gain map that cannot be kept safely is removed, with a warning', async () => {
    // The MPF index points inside the photo, so after any change it cannot be made to
    // point at the gain map; the final check catches it.
    const name = F.gainMapJpeg('gm-broken.jpg', { exif: true, mpf: { offset: 64 } });
    const b = F.read(name);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'jpeg:trailing:gain-map'), 'amber');
    const res = await scrubTo('gm-broken.out.jpg', b, redAmberIds(info));
    assert.ok(res.warnings.some((w) => /could not be kept safely/.test(w)), res.warnings.join(' / '));
    const back = await core.inspect(F.read('gm-broken.out.jpg'));
    assert.ok(!ids(back).some((id) => /gain|mpf/.test(id)), ids(back).join(' '));
    assert.equal(core.privacyWord(back.items), 'minimal');
    samePixels(name, 'gm-broken.out.jpg');
  });

  test('the photo keeps what points a reader to the kept gain map', async () => {
    const xmpOf = (bytes) => Buffer.from(bytes).toString('utf8');
    // A malformed hdrgm:Version goes as an unrecognised field and is written again as 1.0.
    let out = F.read('gm-version-text.out-start.jpg');
    assert.match(xmpOf(out), /hdrgm:Version="1\.0"/, 'hdrgm:Version written again');
    assert.ok(!contains(out, P));
    // Kept on purpose (unticked), it stays as it is, and so does the gain map.
    const vt = F.read('gm-version-text.jpg');
    const keepIds = redAmberIds(await core.inspect(vt)).filter((id) => id !== 'xmp:gainmap-other');
    const vtRes = await scrubTo('gm-version-text.out-kept.jpg', vt, keepIds);
    assert.ok(!vtRes.warnings.length, vtRes.warnings.join(' / '));
    assert.ok(ids(await core.inspect(F.read('gm-version-text.out-kept.jpg'))).includes('jpeg:trailing:gain-map'));
    assert.ok(contains(F.read('gm-version-text.out-kept.jpg'), P));
    // A Mime the gain map entry does not use is replaced by image/jpeg, not left out.
    out = F.read('gm-mime-name.out-start.jpg');
    assert.deepEqual(directoryEntries(out).map((e) => e.semantic), ['Primary', 'GainMap']);
    assert.match(xmpOf(out), /Item:Mime="image\/jpeg" Item:Semantic="GainMap"/);
    // An entry that stands for no part goes with the starting selection.
    out = F.read('gm-semantic-name.out-start.jpg');
    assert.deepEqual(directoryEntries(out).map((e) => e.semantic), ['Primary', 'GainMap']);
    // An ISO 21496-1 only picture: the photo's segment is cut to its version, not dropped.
    out = F.read('gm-iso-only-tail.out-start.jpg');
    const iso = walkJpeg(out).segs.filter((x) => x.kind === 'seg' && x.marker === 0xe2 && Buffer.from(out.subarray(x.dataStart, x.dataStart + 28)).toString('latin1') === F.ISO_ID);
    assert.equal(iso.length, 1, 'one ISO segment in the photo');
    assert.deepEqual(Buffer.from(out.subarray(iso[0].dataStart + 28, iso[0].end)), Buffer.from([0, 0, 0, 0]));
  });

  test('the HDR gain map details and the gain map go together', async () => {
    const name = 'gm-hdrgm-extra.jpg';
    const b = F.read(name);
    // Ticking only the description takes the gain map along, so no gain map is left that
    // readers could no longer find.
    const res = await scrubTo('gm-desc-only.jpg', b, ['xmp:gainmap']);
    assert.ok(!res.warnings.length, res.warnings.join(' / '));
    const back = await core.inspect(F.read('gm-desc-only.jpg'));
    assert.ok(!ids(back).some((id) => /gain-map|mpf|isogain|xmp:gainmap/.test(id)), ids(back).join(' '));
    assert.ok(!contains(F.read('gm-desc-only.jpg'), 'hdrgm:Version'));
    samePixels(name, 'gm-desc-only.jpg');
  });

  test('numbers as a single-precision value prints them are kept byte for byte; more digits are not', async () => {
    // Nine significant digits, or exactly the double a single-precision value prints as.
    const float = '2.321928024291992';
    const name = F.gainMapJpeg('gm-long.jpg', { gainFields: `hdrgm:Version="1.0" hdrgm:GainMapMin="0.0000152587890625" hdrgm:GainMapMax="${float}" hdrgm:Gamma="1" hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="2.32192809" hdrgm:BaseRenditionIsHDR="False"`, gainToolkit: 'FakeXMP Core 1.0' });
    const b = F.read(name);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'jpeg:trailing:gain-map'), 'amber');
    await scrubTo('gm-long.out.jpg', b, redAmberIds(info));
    const out = F.read('gm-long.out.jpg');
    const g = mpfImages(out)[1];
    const text = Buffer.from(out.subarray(g.offset, g.offset + g.size)).toString('latin1');
    for (const f of [`hdrgm:GainMapMax="${float}"`, 'hdrgm:HDRCapacityMax="2.32192809"', 'hdrgm:GainMapMin="0.0000152587890625"']) assert.ok(text.includes(f), f);
    gainMapRenders(name, 'gm-long.out.jpg');
    // A double's seventeen digits, or a number outside the field's range, can spell text:
    // the field is then a red detail and goes, while the gain map stays. A number in range
    // is written again with the nine digits a reader keeps of it.
    for (const [n, value, again] of [['digits', '2.321928094887362', 'hdrgm:GainMapMax="2.32192809"'], ['range', '65115116114105100.32072111108109', null]]) {
      const odd = F.gainMapJpeg(`gm-number-${n}.jpg`, { gainFields: `hdrgm:Version="1.0" hdrgm:GainMapMax="${value}" hdrgm:HDRCapacityMax="2.3"` });
      const i2 = await core.inspect(F.read(odd));
      assert.equal(tierOf(i2, 'jpeg:trailing:gain-map:metadata'), 'red', `${n}: ${ids(i2).join(' ')}`);
      await scrubTo(`gm-number-${n}.out.jpg`, F.read(odd), redAmberIds(i2));
      const o2 = F.read(`gm-number-${n}.out.jpg`);
      assert.ok(!contains(o2, value), `${n}: the number is gone`);
      if (again) assert.ok(contains(o2, again), `${n}: written again rounded`);
      assert.ok(ids(await core.inspect(o2)).includes('jpeg:trailing:gain-map'), `${n}: the gain map stays`);
    }
  });

  test("the gain map's colour profile: green when it can be read, its text a red detail", async () => {
    const own = F.iccProfile({ desc: 'sRGB IEC61966-2.1', cprt: 'No copyright, use freely' });
    const name = F.gainMapJpeg('gm-icc-same.jpg', { photoSegs: [F.iccSegment(own)], gainSegs: [F.iccSegment(own)] });
    const info = await core.inspect(F.read(name));
    assert.equal(tierOf(info, 'jpeg:trailing:gain-map:colour'), 'green');
    assert.equal(info.items.find((i) => i.id === 'icc:profile').value, 'sRGB IEC61966-2.1');
    assert.ok(!ids(info).includes('icc:text') && !ids(info).includes('jpeg:trailing:gain-map:colour-text'), 'well-known text only');
    const other = await core.inspect(F.read('gm-gm-icc-text.jpg'));
    // A profile other than the photo's is green too: an ISO 21496-1 gain map may be applied
    // in its own colour space. Its text is the red detail, rewritten in place by default.
    const colour = other.items.find((i) => i.id === 'jpeg:trailing:gain-map:colour');
    assert.equal(colour.tier, 'green');
    const text = other.items.find((i) => i.id === 'jpeg:trailing:gain-map:colour-text');
    assert.equal(text.tier, 'red');
    assert.ok(text.value.includes(`copyright: Copyright Ingrid ${PA}`), text.value);
    const out = F.read('gm-gm-icc-text.out-start.jpg');
    assert.ok(!contains(out, PA) && contains(out, 'ICC_PROFILE'), 'the text goes, the profile stays');
  });

  test('Galaxy Motion Photo with a gain map: the video entry follows the Samsung trailer', async () => {
    const name = F.jpegMotionSamsung();
    const b = F.read(name);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'jpeg:trailing:gain-map'), 'amber');
    assert.equal(tierOf(info, 'jpeg:trailing:samsung'), 'red');
    assert.ok(!ids(info).includes('xmp:container-extra'), 'the video entry stands for the trailer');
    await scrubTo('motion-samsung.start.jpg', b, redAmberIds(info));
    const start = F.read('motion-samsung.start.jpg');
    assert.deepEqual(directoryEntries(start).map((e) => e.semantic), ['Primary', 'GainMap'], 'the trailer went, and its entry with it');
    assert.equal(directoryEntries(start)[1].length, mpfImages(start)[1].size);
    assert.equal(start.length, mpfImages(start)[1].offset + mpfImages(start)[1].size, 'nothing after the gain map');
    // Kept, the trailer keeps its entry as it was: it still counts from the end of the file.
    await scrubTo('motion-samsung.keep.jpg', b, redAmberIds(info).filter((id) => id !== 'jpeg:trailing:samsung'));
    const keep = F.read('motion-samsung.keep.jpg');
    const d = directoryEntries(keep);
    assert.deepEqual(d.map((e) => e.semantic), ['Primary', 'GainMap', 'MotionPhoto']);
    const sef = Buffer.from(keep).indexOf(Buffer.from([0, 0, 0x30, 0x0a, 16, 0, 0, 0]));
    assert.equal(keep.length - d[2].length, sef, 'the video entry still starts at the trailer');
    assert.equal(d[1].length, mpfImages(keep)[1].size);
  });

  test('rebuilding the multi-picture index for its IDs also leaves out its unexplained data', async () => {
    const b = F.read('gm-mpf-le.jpg');
    await scrubTo('gm-mpf-le.ids-only.jpg', b, ['jpeg:mpf:ids']);
    const back = await core.inspect(F.read('gm-mpf-le.ids-only.jpg'));
    assert.ok(!ids(back).includes('jpeg:mpf:ids') && !ids(back).includes('jpeg:mpf:extra') && ids(back).includes('jpeg:mpf:layout'), ids(back).join(' '));
    gainMapRenders('gm-mpf-le.jpg', 'gm-mpf-le.ids-only.jpg');
  });

  test('item text has no em dashes or double hyphens (gain map details)', async () => {
    for (const v of GAIN_VARIANTS) {
      const info = await core.inspect(F.read(`gm-${v[0]}.jpg`));
      for (const i of info.items) {
        for (const field of ['label', 'note']) {
          const t = i[field] || '';
          assert.ok(!t.includes('—') && !t.includes('-' + '-'), `${i.id} ${field}: ${t}`);
        }
        assert.ok(i.value.length <= 80, `${i.id} value too long`);
        assert.ok(core.GROUPS.some((g) => g.id === i.group) && core.TIERS[i.tier], i.id);
      }
      assert.equal(new Set(ids(info)).size, info.items.length, 'ids must be unique');
    }
  });
});

// ======================================================================================
// Green keeps only what the specifications define (0.0.3). A colour profile's text and a
// technical XMP field are green and kept by default, so free text in them is a red detail
// of its own; and an iPhone HDR JPEG keeps exactly what Apple's gain map needs.

const G = PLANT.green;
const TEXT_TYPES = new Set(['desc', 'text', 'mluc', 'dict', 'utf8', 'utf16', 'zut8']);
// The tags a colour engine reads to convert colours (ICC.1, sections 9.2 and 10).
const COLOUR_TAGS = new Set(['rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC', 'kTRC', 'wtpt', 'bkpt', 'chad', 'chrm', 'lumi', 'cicp',
  'A2B0', 'A2B1', 'A2B2', 'B2A0', 'B2A1', 'B2A2', 'D2B0', 'D2B1', 'D2B2', 'D2B3', 'B2D0', 'B2D1', 'B2D2', 'B2D3', 'gamt', 'meas', 'view', 'tech']);
// Every colour tag keeps its offset and its bytes; only private tags may go.
function colourTagsSame(before, after, label) {
  const a = F.iccTags(before);
  const b = F.iccTags(after);
  for (const [sig, t] of Object.entries(a)) {
    if (TEXT_TYPES.has(t.type)) continue;
    if (!b[sig]) { assert.ok(!COLOUR_TAGS.has(sig), `${label}: colour tag ${sig} kept`); continue; }
    assert.equal(b[sig].off, t.off, `${label}: colour tag ${sig} at the same offset`);
    assert.ok(Buffer.from(b[sig].data).equals(Buffer.from(t.data)), `${label}: colour tag ${sig} byte for byte the same`);
  }
}
const withByte = (p, at, v) => { const c = Buffer.from(p); c[at] = v; return new Uint8Array(c); };
const createHashHex = (b) => createHash('md5').update(b).digest('hex');
// Whether Pillow's colour engine (LittleCMS) opens a profile file.
function spawnSyncPy(file) {
  const r = spawnSync('python3', ['-c', 'import sys\nfrom PIL import ImageCms\nImageCms.ImageCmsProfile(sys.argv[1])', file], { encoding: 'utf8' });
  return r.status === 0 ? { ok: true } : { ok: false, error: r.stderr.trim().split('\n').pop() };
}
// A planted string as Latin-1 or as UTF-16 (mluc text).
const hasPlant = (bytes, s) => contains(bytes, s) || Buffer.from(bytes).includes(Buffer.from(s, 'utf16le').swap16());

describe('Green keeps only what the specifications define', () => {
  test('a colour profile: well-known text is clean; other text, hidden bytes and private tags are not', () => {
    const clean = (p) => inspectIcc(new Uint8Array(p));
    assert.ok(clean(F.iccProfile({ desc: 'sRGB IEC61966-2.1', cprt: 'Copyright (c) 1998 Hewlett-Packard Company', more: [['dmnd', 'IEC http://www.iec.ch'], ['dmdd', 'IEC 61966-2.1 Default RGB colour space - sRGB']] })).clean);
    assert.ok(clean(F.iccProfileV4()).clean, 'Display P3, Copyright Apple Inc., 2017');
    assert.ok(clean(F.iccProfileV4({ desc: 'Display P3 Gamut with sRGB Transfer', cprt: 'Google Inc. 2022' })).clean, 'libultrahdr');
    assert.ok(clean(F.iccProfileV4({ desc: 'sRGB', cprt: 'Copyright International Color Consortium, 2015' })).clean);
    const free = (p) => { const i = clean(p); assert.ok(i.ok, 'readable'); return i.free.map((f) => `${f.sig}=${f.text}`).join(' / '); };
    assert.match(free(F.iccProfile({ desc: 'sRGB IEC61966-2.1', cprt: `Copyright Astrid ${G}` })), /^cprt=Copyright Astrid GREEN-TEXT-PLANT$/);
    assert.match(free(F.iccProfileV4({ desc: `Astrid ${G}` })), /^desc=Astrid/);
    assert.match(free(F.iccProfileV4({ dmnd: `Maker ${G}` })), /^dmnd=Maker/);
    assert.match(free(F.iccProfileV4({ records: [['nbNO', `Astrid ${G}`]] })), /^desc=Astrid/, 'a second language record');
    assert.match(free(F.iccProfile({ more: [['CNRY', G]] })), /CNRY=GREEN/, 'a private text tag');
    assert.match(free(F.iccProfileV4({ cprt: 'Copyright Apple Inc., 1066' })), /cprt/, 'a year outside the list');
    // Bytes the structure does not use: inside a description's ScriptCode area.
    const p = F.iccProfile({ desc: 'sRGB IEC61966-2.1' });
    const d = F.iccTags(p).desc;
    assert.match(free(withByte(p, d.off + d.len - 5, 0x41)), /desc=hidden bytes/);
    // A private tag of a colour type, a reserved header byte, a profile ID that is not the
    // checksum, and bytes no tag uses.
    const priv = Buffer.from(F.iccProfile({ desc: 'sRGB' }));
    const at = priv.indexOf(Buffer.from('wtpt'), 128);
    priv.write('ZZZZ', at, 'latin1');
    assert.deepEqual(clean(priv).extra, ['tag ZZZZ that most colour engines ignore']);
    assert.deepEqual(clean(withByte(F.iccProfile({ desc: 'sRGB' }), 110, 0x41)).extra, ['reserved header bytes']);
    assert.deepEqual(clean(withByte(F.iccProfile({ desc: 'sRGB' }), 90, 0x41)).extra, ['a profile ID that is not its checksum']);
    const gap = Buffer.concat([Buffer.from(F.iccProfile({ desc: 'sRGB' })), Buffer.from('Astrid!!')]);
    gap.writeUInt32BE(gap.length, 0);
    assert.deepEqual(clean(gap).extra, ['bytes no tag uses']);
    // Unreadable: a tag past the end, a text tag overlapping a colour tag.
    const past = Buffer.from(F.iccProfile({ desc: 'sRGB' }));
    past.writeUInt32BE(5000, 132 + 4);
    assert.equal(clean(past).ok, false);
    const over = Buffer.from(F.iccProfile({ desc: 'sRGB' }));
    const t = F.iccTags(over);
    over.writeUInt32BE(t.wtpt.off - 4, 132 + 12 + 4);
    over.writeUInt32BE(12, 132 + 12 + 8);
    assert.equal(clean(over).ok, false, 'the copyright overlaps the white point');
  });

  test('a colour profile rewritten: same size, every colour tag byte for byte, the ID right, and LittleCMS opens it', () => {
    const dirty = [
      F.iccProfile({ desc: `Astrid ${G}`, cprt: `Copyright ${G}`, more: [['dmnd', `Maker ${G}`], ['CNRY', G]] }),
      F.iccProfileV4({ desc: `Astrid ${G}`, cprt: `Copyright ${G}`, dmnd: `Maker ${G}`, records: [['nbNO', G]] }),
      withByte(F.iccProfile({ desc: 'sRGB IEC61966-2.1' }), 110, 0x41),
    ];
    const system = ['sRGB.icc', 'AdobeRGB1998.icc', 'ProPhotoRGB.icc', 'Bluish.icc', 'FOGRA39L_coated.icc'].map((n) => `/usr/share/color/icc/colord/${n}`).filter(existsSync).map((f) => new Uint8Array(readFileSync(f)));
    for (const [n, p] of [...dirty, ...system].entries()) {
      const out = cleanIcc(p);
      assert.ok(out, `profile ${n}: rewritten`);
      assert.equal(out.length, p.length, `profile ${n}: same size`);
      const again = inspectIcc(out);
      assert.ok(again.ok && again.clean, `profile ${n}: nothing left to clean`);
      assert.ok(!Buffer.from(out).includes(Buffer.from(G)) && !Buffer.from(out).includes(Buffer.from(G, 'utf16le').swap16()), `profile ${n}: the plant is gone`);
      colourTagsSame(p, out, `profile ${n}`);
      const id = Buffer.from(out.subarray(84, 100));
      if (id.some((x) => x)) {
        const c = Buffer.from(out); c.fill(0, 44, 48); c.fill(0, 64, 68); c.fill(0, 84, 100);
        assert.ok(Buffer.from(md5(c)).equals(id), `profile ${n}: the profile ID is its MD5`);
        assert.equal(createHashHex(c), id.toString('hex'), `profile ${n}: MD5 agrees with node:crypto`);
      }
      const file = F.write(`icc-clean-${n}.out.icc`, out);
      const r = spawnSyncPy(file);
      assert.ok(r.ok, `profile ${n}: LittleCMS opens it (${r.error || ''})`);
    }
  });

  test('text in a colour profile in JPEG, PNG, WebP and HEIC: red, rewritten by default, colours unchanged', async () => {
    const prof = F.iccProfileV4({ desc: `Astrid ${G}`, cprt: `Copyright Astrid ${G}`, dmnd: `Maker ${G}` });
    F.write('icc-text.icc', prof);
    F.magick(['-size', '96x64', 'plasma:fractal', '-seed', '141', '-depth', '8', '-strip', '-quality', '90', F.path('icc-base.jpg')]);
    F.write('icc-text.jpg', F.jpegInsert(F.read('icc-base.jpg'), F.iccSegment(prof)));
    F.magick(['-size', '96x64', 'plasma:fractal', '-seed', '142', '-depth', '8', '-strip', `PNG24:${F.path('icc-base.png')}`]);
    F.write('icc-text.png', F.pngInsertBefore(F.read('icc-base.png'), 'IDAT', F.pngChunk('iCCP', F.u8(`Astrid ${G}`, [0, 0], zlib.deflateSync(Buffer.from(prof))))));
    F.magick(['-size', '96x64', 'plasma:fractal', '-seed', '143', '-depth', '8', '-strip', '-quality', '80', F.path('icc-text.webp')]);
    F.exiftoolWrite(F.path('icc-text.webp'), [`-ICC_Profile<=${F.path('icc-text.icc')}`]);
    F.buildHeic('icc-text.heic', { iccBytes: prof });
    for (const name of ['icc-text.jpg', 'icc-text.png', 'icc-text.webp', 'icc-text.heic']) {
      const b = F.read(name);
      assert.ok(hasPlant(b, G), `${name}: plant present`);
      const info = await core.inspect(b);
      assert.equal(tierOf(info, 'icc:text'), 'red', `${name}: ${ids(info).join(' ')}`);
      assert.equal(tierOf(info, name.endsWith('.png') ? 'png:colour' : 'icc:profile'), 'green', name);
      assert.ok(info.items.find((i) => i.id === 'icc:text').value.includes(G), `${name}: the text is shown`);
      const out = name.replace(/\.(\w+)$/, '.out-start.$1');
      const res = await scrubTo(out, b, redAmberIds(info));
      assert.deepEqual(res.warnings.filter((w) => /colour profile/.test(w)), [], name);
      const o = F.read(out);
      assert.ok(!hasPlant(o, G), `${name}: the plant is gone`);
      const back = await core.inspect(o);
      assert.ok(!ids(back).includes('icc:text'), `${name}: read back ${ids(back).join(' ')}`);
      const icc = F.iccOf(F.path(out));
      assert.ok(icc.ok, `${name}: the profile still opens (${icc.error || ''})`);
      assert.ok(!hasPlant(icc.bytes, G) && !hasPlant(icc.bytes, 'Astrid'), `${name}: nothing planted in the profile`);
      colourTagsSame(prof, icc.bytes, name);
      if (name.endsWith('.heic')) heicIntact(b, o, name);
      samePixels(name, out);
    }
  });

  test('a colour profile that cannot be read is offered whole, as red', async () => {
    const bad = Buffer.from(F.iccProfile({ desc: 'sRGB' }));
    bad.writeUInt32BE(5000, 132 + 4);
    F.write('icc-bad.jpg', F.jpegInsert(F.read('icc-base.jpg'), F.iccSegment(bad)));
    const info = await core.inspect(F.read('icc-bad.jpg'));
    assert.equal(tierOf(info, 'icc:unreadable'), 'red');
    assert.ok(!ids(info).includes('icc:profile'));
    await scrubTo('icc-bad.out-start.jpg', F.read('icc-bad.jpg'), redAmberIds(info));
    assert.ok(!contains(F.read('icc-bad.out-start.jpg'), 'ICC_PROFILE'));
  });

  test('technical XMP fields: numbers and fixed words stay green, anything else is red', () => {
    const keyOf = (attrs, body = '') => {
      const parsed = parseXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" ${attrs}>${body}</rdf:Description></rdf:RDF></x:xmpmeta>`);
      const set = new ItemSet();
      const out = {};
      for (const it of addXmpItems(set, parsed, {}, {}, 0)) for (const i of it.props) out[parsed.props[i].key] = it.key;
      return Object.values(out)[0];
    };
    const cases = [
      ['xmp:Rating="5"', 'technical'], ['xmp:Rating="-1"', 'technical'], [`xmp:Rating="Astrid ${G}"`, 'technical-text'], ['xmp:Rating="7"', 'technical-text'],
      ['photoshop:ICCProfile="sRGB IEC61966-2.1"', 'technical'], [`photoshop:ICCProfile="Astrid ${G}"`, 'technical-text'],
      ['photoshop:ColorMode="3"', 'technical'], ['photoshop:ColorMode="RGB"', 'technical-text'],
      ['dc:format="image/jpeg"', 'technical'], ['dc:format="image/astrid"', 'technical-text'],
      // A digest of the original metadata is 128 free bits and links back to the original.
      ['photoshop:EmbeddedXMPDigest="0123456789ABCDEF0123456789abcdef"', 'ids'], ['tiff:NativeDigest="256,257;0123456789ABCDEF0123456789abcdef"', 'ids'],
      ['GPano:ProjectionType="equirectangular"', 'technical'], [`GPano:ProjectionType="${G}"`, 'technical-text'],
      ['GPano:PoseHeadingDegrees="12.5"', 'technical'], [`GPano:PoseHeadingDegrees="12.5 ${G}"`, 'technical-text'],
      [`GPano:Note="${G}"`, 'technical-text'], ['GPano:UsePanoramaViewer="True"', 'technical'],
      ['GPano:FirstPhotoDate="2026-09-14T10:15:23"', 'dates'], [`GPano:CaptureSoftware="${G}"`, 'software'],
      ['exif:FNumber="19/10"', 'technical'], [`exif:FNumber="${G}"`, 'technical-text'], [`exif:SpectralSensitivity="${G}"`, 'technical-text'],
    ];
    for (const [attrs, want] of cases) assert.equal(keyOf(attrs), want, attrs);
    const elems = [
      ['<exif:ISOSpeedRatings><rdf:Seq><rdf:li>100</rdf:li></rdf:Seq></exif:ISOSpeedRatings>', 'technical'],
      [`<exif:ISOSpeedRatings><rdf:Seq><rdf:li>${G}</rdf:li></rdf:Seq></exif:ISOSpeedRatings>`, 'technical-text'],
      ['<exif:Flash rdf:parseType="Resource"><exif:Fired>False</exif:Fired><exif:Return>0</exif:Return><exif:Mode>2</exif:Mode></exif:Flash>', 'technical'],
      [`<exif:Flash rdf:parseType="Resource"><exif:Fired>False</exif:Fired><exif:Note>${G}</exif:Note></exif:Flash>`, 'technical-text'],
      ['<exif:Flash exif:Fired="False" exif:Mode="2"/>', 'technical'],
      [`<xmp:Rating><rdf:Description><xmp:Who>${G}</xmp:Who></rdf:Description></xmp:Rating>`, 'technical-text'],
    ];
    for (const [body, want] of elems) assert.equal(keyOf('', body), want, body);
  });

  test('technical EXIF fields and PNG chunks: numbers and the defined forms stay green, anything else is red', async () => {
    F.magick(['-size', '64x48', 'plasma:fractal', '-seed', '151', '-depth', '8', '-strip', '-quality', '90', F.path('green-exif-base.jpg')]);
    const tiff = F.tiffBlock({
      ifd0: [[0x010f, 2, 0, 'Fakecam'], [0x011a, 5, 1, [72, 1]]],
      exif: [[0x829d, 2, 0, `Astrid ${G}`], [0x8824, 2, 0, `Astrid Holmvik ${G}`], [0xa20c, 7, 0, Buffer.from(`Names ${G}`)], [0x9000, 7, 4, Buffer.from('0232')],
        [0x9101, 7, 4, Buffer.from([1, 2, 3, 0])], [0x829a, 5, 1, [1, 125]], [0xea1c, 7, 0, Buffer.concat([Buffer.from([0x1c, 0xea]), Buffer.alloc(30)])]],
    });
    F.write('green-exif.jpg', F.jpegInsert(F.read('green-exif-base.jpg'), F.jpegSeg(0xe1, F.u8('Exif\0\0', tiff))));
    const info = await core.inspect(F.read('green-exif.jpg'));
    const t = info.items.find((i) => i.id === 'exif:technical-text');
    assert.ok(t && t.tier === 'red' && t.group === 'hidden', ids(info).join(' '));
    assert.match(t.value, /FNumber, SpectralSensitivity, SpatialFrequencyResponse/);
    assert.equal(tierOf(info, 'exif:exposure'), 'green', 'ExposureTime stays green');
    assert.equal(tierOf(info, 'exif:format'), 'green', 'ExifVersion, ComponentsConfiguration and zero Padding stay green');
    await scrubTo('green-exif.out-start.jpg', F.read('green-exif.jpg'), redAmberIds(info));
    const out = F.read('green-exif.out-start.jpg');
    assert.ok(!contains(out, G), 'the text is gone');
    const back = await core.inspect(out);
    assert.deepEqual(back.items.filter((i) => i.tier !== 'green').map((i) => i.id), []);
    assert.equal(back.items.find((i) => i.id === 'exif:exposure').value, '1/125 s');
    // Re-saving (crop, resize) rebuilds EXIF from the kept details: the text does not come along.
    const rebuilt = core.buildExif(F.read('green-exif.jpg'), new Set(info.items.filter((i) => i.tier !== 'red').map((i) => i.id)));
    assert.ok(rebuilt && !contains(rebuilt, G), 'buildExif leaves the text out');
    // PNG: colour and display chunks of the wrong size, a pCAL with a name, an exif: text
    // copy holding text; a well-formed gAMA and pHYs stay green.
    F.magick(['-size', '64x48', 'plasma:fractal', '-seed', '152', '-depth', '8', '-strip', `PNG24:${F.path('green-png-base.png')}`]);
    const png = F.pngInsertBefore(F.read('green-png-base.png'), 'IDAT',
      F.pngChunk('gAMA', F.u8([0, 0, 0xb1, 0x8f])), F.pngChunk('pHYs', F.u8([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])),
      F.pngChunk('cHRM', F.u8(Buffer.alloc(32), `Astrid ${G}`)), F.pngChunk('pCAL', F.u8(`Astrid ${G}`, [0], Buffer.alloc(12))),
      F.pngChunk('tEXt', F.u8('exif:FNumber', [0], `Holmvik ${G}`)));
    F.write('green-png.png', png);
    const pi = await core.inspect(F.read('green-png.png'));
    assert.equal(tierOf(pi, 'png:technical-text'), 'red', ids(pi).join(' '));
    assert.equal(tierOf(pi, 'png:exif-text:technical-text'), 'red', ids(pi).join(' '));
    assert.equal(tierOf(pi, 'png:colour'), 'green');
    assert.equal(tierOf(pi, 'png:phys'), 'green');
    await scrubTo('green-png.out-start.png', F.read('green-png.png'), redAmberIds(pi));
    const po = F.read('green-png.out-start.png');
    assert.ok(!contains(po, G) && contains(po, 'gAMA') && contains(po, 'pHYs'));
    // Pillow refuses the input's malformed chunks; the output decodes to the base picture.
    samePixels('green-png-base.png', 'green-png.out-start.png');
  });

  test('technical XMP text in a picture: offered red, removed by default, the rest of the packet stays', async () => {
    const xmp = Buffer.from(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" xmp:Rating="Astrid ${G}" photoshop:ICCProfile="Holmvik ${G}" photoshop:ColorMode="3" GPano:ProjectionType="${G}" GPano:PoseHeadingDegrees="12.5"/></rdf:RDF></x:xmpmeta>`);
    F.write('green-xmp.jpg', F.jpegInsert(F.read('icc-base.jpg'), F.jpegSeg(0xe1, F.u8('http://ns.adobe.com/xap/1.0/\0', xmp))));
    const info = await core.inspect(F.read('green-xmp.jpg'));
    const t = info.items.find((i) => i.id === 'xmp:technical-text');
    assert.ok(t && t.tier === 'red' && t.group === 'hidden', ids(info).join(' '));
    assert.equal(tierOf(info, 'xmp:technical'), 'green');
    await scrubTo('green-xmp.out-start.jpg', F.read('green-xmp.jpg'), redAmberIds(info));
    const out = F.read('green-xmp.out-start.jpg');
    assert.ok(!contains(out, G) && !contains(out, 'Astrid') && !contains(out, 'Holmvik'));
    assert.ok(contains(out, 'photoshop:ColorMode="3"') && contains(out, 'GPano:PoseHeadingDegrees="12.5"'), 'the numbers stay');
    const back = await core.inspect(out);
    assert.deepEqual(back.items.filter((i) => i.tier !== 'green').map((i) => i.id), []);
  });

  // The two numbers the way Skia reads them (SkExif::get_maker_note_hdr_headroom): the
  // MakerNote starts with "Apple iOS\0\0\x01MM" and holds a big-endian directory at 14.
  function appleNumbers(bytes) {
    const b = Buffer.from(bytes);
    const at = b.indexOf(Buffer.from('Apple iOS\0\0\x01MM', 'latin1'));
    if (at < 0) return null;
    const n = b.readUInt16BE(at + 14);
    const out = { count: n };
    for (let i = 0; i < n; i++) {
      const q = at + 16 + i * 12;
      const tag = b.readUInt16BE(q);
      if (b.readUInt16BE(q + 2) !== 10) continue;
      const off = at + b.readUInt32BE(q + 8);
      out[tag] = b.readInt32BE(off) / b.readInt32BE(off + 4);
    }
    return out;
  }

  test('iPhone HDR JPEG: the gain map, its apdi label and the two HDR numbers stay; nothing else', async () => {
    const name = F.appleHdrJpeg('apple-hdr.jpg', { gainBody: `\n   <apdi:NativeFormat>1278226488</apdi:NativeFormat>\n   <apdi:StoredFormat>${G}</apdi:StoredFormat>` });
    const b = F.read(name);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'jpeg:trailing:gain-map'), 'amber', ids(info).join(' '));
    assert.equal(tierOf(info, 'exif:makernote'), 'red');
    const hdr = info.items.find((i) => i.id === 'exif:apple-hdr');
    assert.deepEqual([hdr.tier, hdr.value, hdr.group], ['amber', 'Headroom 5.86 (maker note values 1.02 and 0.0064)', 'hidden']);
    assert.equal(tierOf(info, 'jpeg:trailing:gain-map:metadata'), 'red', 'the extra apdi fields');
    assert.ok(!redAmberIds(info).includes('exif:apple-hdr') && redAmberIds(info).includes('exif:makernote'));
    const res = await scrubTo('apple-hdr.out-start.jpg', b, redAmberIds(info));
    assert.deepEqual(res.warnings, []);
    const out = F.read('apple-hdr.out-start.jpg');
    assert.ok(!contains(out, PLANT.appleNote) && !contains(out, G), 'the MakerNote text and the extra apdi field are gone');
    const back = await core.inspect(out);
    assert.deepEqual(back.items.filter((i) => i.tier !== 'green').map((i) => `${i.tier}:${i.id}`).sort(), ['amber:exif:apple-hdr', 'amber:jpeg:trailing:gain-map']);
    assert.equal(core.privacyWord(back.items), 'public');
    assert.deepEqual(redAmberIds(back), [], 'nothing is ticked on the result');
    // The MakerNote holds the two numbers only, as Skia reads them.
    assert.deepEqual(appleNumbers(out), { count: 2, 33: 1.02, 48: 0.0064 });
    // The gain map is whole, its pixels are the same, and its XMP keeps exactly the version
    // and the apdi label Chrome requires.
    const imgs = mpfImages(out);
    assert.equal(imgs[0].size, walkJpeg(out).eoiEnd);
    const gm = out.subarray(imgs[1].offset, imgs[1].offset + imgs[1].size);
    const gin = mpfImages(b)[1];
    F.write('apple-hdr.out-gm-in.jpg', b.subarray(gin.offset, gin.offset + gin.size));
    F.write('apple-hdr.out-gm.jpg', gm);
    const [h1, h2] = F.decodeHashes([F.path('apple-hdr.out-gm-in.jpg'), F.path('apple-hdr.out-gm.jpg')]);
    assert.ok(h1 && h1 === h2, 'the gain map pixels are unchanged');
    const x = F.exifRead(F.path('apple-hdr.out-gm.jpg')).filter((r) => /^XMP-/.test(r.group)).map((r) => `${r.tag}=${r.value}`).sort();
    assert.deepEqual(x, ['AuxiliaryImageType=urn:com:apple:photo:2020:aux:hdrgainmap', 'HDRGainMapVersion=65536']);
    samePixels(name, 'apple-hdr.out-start.jpg');
    // Removing the HDR numbers takes the gain map along, and the reverse.
    for (const extra of ['exif:apple-hdr', 'jpeg:trailing:gain-map']) {
      const o = `apple-hdr.out-${extra.replace(/\W+/g, '-')}.jpg`;
      await scrubTo(o, b, [...redAmberIds(info), extra]);
      const rb = await core.inspect(F.read(o));
      assert.ok(!ids(rb).includes('jpeg:trailing:gain-map') && !ids(rb).includes('exif:apple-hdr') && !ids(rb).includes('exif:makernote'), `${extra}: ${ids(rb).join(' ')}`);
      assert.equal(appleNumbers(F.read(o)), null);
    }
    // Keeping the whole MakerNote keeps it as it was.
    await scrubTo('apple-hdr.out-keep-note.jpg', b, redAmberIds(info).filter((id) => id !== 'exif:makernote'));
    assert.ok(contains(F.read('apple-hdr.out-keep-note.jpg'), PLANT.appleNote));
  });

  test('iPhone HDR JPEG: any other apdi value is not kept, and no HDR numbers without tag 33', async () => {
    // Without Apple's exact label no reader finds the gain map, so the second picture is an
    // extra picture (red) and no HDR numbers are offered.
    const wrong = F.appleHdrJpeg('apple-wrong.jpg', { auxType: `urn:com:apple:photo:2020:aux:hdrgainmap ${G}` });
    const info = await core.inspect(F.read(wrong));
    assert.ok(!ids(info).includes('jpeg:trailing:gain-map') && !ids(info).includes('exif:apple-hdr'), ids(info).join(' '));
    assert.ok(info.items.some((i) => i.id.startsWith('jpeg:trailing:') && i.tier === 'red'), ids(info).join(' '));
    await scrubTo('apple-wrong.out-start.jpg', F.read(wrong), redAmberIds(info));
    const out = F.read('apple-wrong.out-start.jpg');
    assert.ok(!contains(out, G) && !contains(out, 'AuxiliaryImageType'));
    const no33 = F.appleHdrJpeg('apple-no33.jpg', { note: { maker33: [0, 0] } });
    const i2 = await core.inspect(F.read(no33));
    assert.ok(!ids(i2).includes('exif:apple-hdr'), 'a zero denominator is not a number');
  });

  test('item text has no em dashes or double hyphens (green free text and Apple)', async () => {
    for (const name of ['icc-text.jpg', 'icc-text.png', 'icc-text.webp', 'icc-text.heic', 'icc-bad.jpg', 'green-xmp.jpg', 'green-exif.jpg', 'green-png.png', 'apple-hdr.jpg', 'apple-wrong.jpg']) {
      const info = await core.inspect(F.read(name));
      for (const i of info.items) {
        for (const field of ['label', 'note']) {
          const t = i[field] || '';
          assert.ok(!t.includes('—') && !t.includes('-' + '-'), `${i.id} ${field}: ${t}`);
        }
        assert.ok(i.value.length <= 80, `${name} ${i.id} value too long: ${i.value}`);
      }
    }
  });
});

// ======================================================================================
// What the fourth review found: channels through details kept by default. Each probe
// carries a name ("Astrid Holmvik") in a place the default selection used to keep: inside
// colour tags and the profile header, in the type and count of EXIF numbers, in XMP prefixes,
// declarations, the packet wrapper, xml attributes, white space and numbers, and in decoder
// tables no scan uses. With the default selection every one must go, the result must read
// back with nothing red, and kept colour data and gain maps must stay as they were.

const NAME = 'Astrid Holmvik';
const nameIn = (bytes) => contains(bytes, 'Astrid') || contains(bytes, 'Holmvik') || Buffer.from(bytes).includes(Buffer.from('Astrid', 'utf16le').swap16());
// The bytes a colour engine reads in each kept colour tag are the same before and after.
function colourUsedSame(before, after, label) {
  const a = inspectIcc(new Uint8Array(before));
  assert.ok(a.ok, `${label}: the input profile reads`);
  for (const t of a.tags) {
    if (t.kind !== 'keep') continue;
    for (const [s, e] of t.used) assert.ok(Buffer.from(after.subarray(s, e)).equals(Buffer.from(before.subarray(s, e))), `${label}: colour tag ${t.sig} unchanged`);
  }
}
function profileOpens(p, label) {
  const r = spawnSyncPy(F.write(`${label}.icc`, p));
  assert.ok(r.ok, `${label}: LittleCMS opens it (${r.error || ''})`);
}
// Puts a profile into a JPEG, a PNG, a WebP and a HEIC, scrubs each with the default
// selection, and checks the name is gone, the colours stay and the result reads back clean.
async function iccInFormats(tag, prof) {
  F.write(`${tag}.icc`, prof);
  if (!existsSync(F.path('icc-base.jpg'))) F.magick(['-size', '96x64', 'plasma:fractal', '-seed', '141', '-depth', '8', '-strip', '-quality', '90', F.path('icc-base.jpg')]);
  if (!existsSync(F.path('icc-base.png'))) F.magick(['-size', '96x64', 'plasma:fractal', '-seed', '142', '-depth', '8', '-strip', `PNG24:${F.path('icc-base.png')}`]);
  F.write(`${tag}.jpg`, F.jpegInsert(F.read('icc-base.jpg'), F.iccSegment(prof)));
  F.write(`${tag}.png`, F.pngInsertBefore(F.read('icc-base.png'), 'IDAT', F.pngChunk('iCCP', F.u8('ICC Profile', [0, 0], zlib.deflateSync(Buffer.from(prof))))));
  F.magick(['-size', '96x64', 'plasma:fractal', '-seed', '143', '-depth', '8', '-strip', '-quality', '80', F.path(`${tag}.webp`)]);
  F.exiftoolWrite(F.path(`${tag}.webp`), [`-ICC_Profile<=${F.path(`${tag}.icc`)}`]);
  F.buildHeic(`${tag}.heic`, { iccBytes: prof });
  for (const name of [`${tag}.jpg`, `${tag}.png`, `${tag}.webp`, `${tag}.heic`]) {
    const b = F.read(name);
    assert.ok(nameIn(b) || name.endsWith('.png'), `${name}: the name is planted`);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'icc:text'), 'red', `${name}: ${ids(info).join(' ')}`);
    const out = name.replace(/\.(\w+)$/, '.out-start.$1');
    const res = await scrubTo(out, b, redAmberIds(info));
    assert.deepEqual(res.warnings.filter((w) => /colour|XMP|gain/i.test(w)), [], name);
    const o = F.read(out);
    assert.ok(!nameIn(o), `${name}: the name is gone`);
    const back = await core.inspect(o);
    assert.deepEqual(back.items.filter((i) => i.tier !== 'green').map((i) => i.id), [], `${name}: read back`);
    const icc = F.iccOf(F.path(out));
    assert.ok(icc.ok, `${name}: the profile still opens (${icc.error || ''})`);
    assert.ok(!nameIn(icc.bytes), `${name}: the name is gone from the profile`);
    colourUsedSame(prof, icc.bytes, name);
    if (name.endsWith('.heic')) heicIntact(b, o, name);
    samePixels(name, out);
  }
}

describe('Review 4: free channels through details kept by default', () => {
  const plant = Buffer.from(`${NAME}, 12 Fjordveien, Bergen`, 'latin1');
  const base = () => F.ICC_BASE_TAGS();
  const withTag = (sig, bytes) => base().map(([s, d]) => [s, s === sig ? bytes : d]);
  const para = F.u8('para', [0, 0, 0, 0], [0, 0, 0, 0], [0, 2, 0x33, 0x33]);

  test('colour tags keep only the bytes a colour engine reads, and only the types their signature takes', () => {
    const cases = {
      'curv-tail': withTag('rTRC', F.u8('curv', [0, 0, 0, 0], [0, 0, 0, 1], [2, 0x33], plant)),
      'targ-ui08': [...base(), ['targ', F.u8('ui08', [0, 0, 0, 0], plant)]],
      'cprt-ui08': withTag('cprt', F.u8('ui08', [0, 0, 0, 0], plant)),
      'wtpt-extra': withTag('wtpt', F.u8(F.iccXyz(0.9642, 1, 0.8249), plant)),
      'calt-dtim': [...base(), ['calt', F.u8('dtim', [0, 0, 0, 0], 'AstridHolmvk')]],
      'chad-extra': [...base(), ['chad', F.u8('sf32', [0, 0, 0, 0], ...[1.0478, 0.0229, -0.0501, 0.0295, 0.9905, -0.0171, -0.0092, 0.0151, 0.7521].map((v) => { const x = Buffer.alloc(4); x.writeInt32BE(Math.round(v * 65536)); return x; }), plant)]],
      'tag-reserved': withTag('rXYZ', F.u8('XYZ Astr', F.iccXyz(0.5151, 0.2412, -0.0011).subarray(8))),
      'para-reserved': withTag('rTRC', F.u8('para', [0, 0, 0, 0], [0, 0], 'Hm', [0, 2, 0x33, 0x33])),
      'view-text': [...base(), ['view', F.u8('view', [0, 0, 0, 0], plant.subarray(0, 24), [0, 0, 0, 1])]],
      'xyz-text': withTag('bXYZ', F.u8('XYZ ', [0, 0, 0, 0], plant.subarray(0, 12))),
    };
    for (const [n, tags] of Object.entries(cases)) {
      const p = F.iccBuild({ tags });
      const i = inspectIcc(p);
      if (n === 'xyz-text') { assert.equal(i.ok, false, 'a colour value far outside its range is not read'); continue; }
      assert.ok(i.ok && !i.clean, `${n}: offered (${JSON.stringify(i.extra)})`);
      const c = cleanIcc(p);
      assert.ok(c && c.length === p.length, `${n}: rewritten in place`);
      assert.ok(!nameIn(c) && !contains(c, 'Astr') && !contains(c, 'Hm'), `${n}: the name is gone`);
      assert.ok(inspectIcc(c).clean, `${n}: nothing left to clean`);
      colourUsedSame(p, c, n);
      profileOpens(c, `icc-r4-${n}`);
    }
    // Real profiles stay clean: the HP sRGB measurement tag (40 bytes) and well-formed
    // measurement and viewing condition tags.
    const hpMeas = F.u8('meas', Buffer.alloc(23), [2], Buffer.alloc(11), [2]);
    const view = F.u8('view', [0, 0, 0, 0], ...[19.6445, 20.3718, 16.8089, 3.92889, 4.07439, 3.36179].map((v) => { const x = Buffer.alloc(4); x.writeInt32BE(Math.round(v * 65536)); return x; }), [0, 0, 0, 1]);
    assert.ok(inspectIcc(F.iccBuild({ tags: [...base(), ['meas', hpMeas], ['view', view]] })).clean);
    assert.ok(inspectIcc(F.iccBuild({ tags: withTag('rTRC', para) })).clean);
  });

  test('the profile header holds no free text', () => {
    const cases = {
      maker: { 48: `${NAME}\0\0` },
      date: { 24: 'Holmvik-Astr' },
      cmm: { 4: 'Astr' }, creator: { 80: 'Holm' }, platform: { 40: 'Holm' },
      intent: { 64: 'vik!' }, version: { 10: 'AH' }, flags: { 44: 'Astr' },
      illuminant: { 68: 'AstridHolmvk' },
    };
    for (const [n, header] of Object.entries(cases)) {
      const p = F.iccBuild({ header });
      const i = inspectIcc(p);
      assert.ok(i.ok && !i.clean && i.extra.some((x) => x.startsWith('header fields')), `${n}: ${JSON.stringify(i.extra)}`);
      const c = cleanIcc(p);
      assert.ok(c && !contains(c, 'Astr') && !contains(c, 'Holm') && !contains(c, 'vik!') && !contains(c, 'AH'), `${n}: the text is gone`);
      assert.ok(inspectIcc(c).clean, n);
      colourUsedSame(p, c, n);
      profileOpens(c, `icc-r4-header-${n}`);
    }
    // Registered values stay: Apple's CMM and platform, a real date, the ICC's own sRGB2014
    // vendor attribute bit, a relative colorimetric intent.
    const ok = F.iccBuild({ header: { 4: 'appl', 24: '\x07\xe6\0\x01\0\x01\0\0\0\0\0\0', 40: 'APPL', 48: 'APPL', 59: '\x01', 67: '\x01', 80: 'appl' } });
    assert.ok(inspectIcc(ok).clean, JSON.stringify(inspectIcc(ok).extra));
  });

  test('a name in the header or in a colour tag goes in JPEG, PNG, WebP and HEIC, the colours stay', async () => {
    await iccInFormats('icc-r4-header', F.iccBuild({ header: { 48: `${NAME}\0\0` } }));
    await iccInFormats('icc-r4-curv', F.iccBuild({ tags: withTag('rTRC', F.u8('curv', [0, 0, 0, 0], [0, 0, 0, 1], [2, 0x33], plant)) }));
  });

  test('profile text: language codes, the codes of a version 2 description, white space, and text that cannot be read', () => {
    const mlucMany = (records) => {
      const head = [Buffer.from('mluc', 'latin1'), Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)];
      head[2].writeUInt32BE(records.length); head[3].writeUInt32BE(12);
      const s16 = Buffer.from('sRGB', 'utf16le').swap16();
      const at = 16 + 12 * records.length;
      for (const code of records) { const r = Buffer.alloc(12); r.write(code, 0, 'latin1'); r.writeUInt32BE(s16.length, 4); r.writeUInt32BE(at, 8); head.push(r); }
      return F.u8(...head, s16);
    };
    const desc2 = (ascii, { lang = 0, uni = '', code = 0, script = '' } = {}) => {
      const u = Buffer.from(uni, 'utf16le').swap16();
      const parts = [Buffer.from('desc\0\0\0\0', 'latin1'), Buffer.alloc(4), Buffer.from(`${ascii}\0`, 'latin1'), Buffer.alloc(4), Buffer.alloc(4), u, Buffer.alloc(2), Buffer.from([script.length]), Buffer.alloc(67)];
      parts[1].writeUInt32BE(ascii.length + 1);
      if (typeof lang === 'string') parts[3].write(lang, 0, 'latin1');
      parts[4].writeUInt32BE(uni.length);
      parts[6].writeUInt16BE(code);
      Buffer.from(script, 'latin1').copy(parts[8]);
      return F.u8(...parts);
    };
    const dirty = {
      'mluc-codes': withTag('desc', mlucMany(['asTR', 'idHO', 'lmVI', 'ksEE'])),
      'mluc-twice': withTag('desc', mlucMany(['enUS', 'enUS'])),
      'desc-lang': withTag('desc', desc2('sRGB', { lang: 'Astr', uni: 'sRGB' })),
      'desc-script': withTag('desc', desc2('sRGB', { code: 0x4148 })),
      'mluc-unicode-space': withTag('desc', F.iccMluc('sRGB   　')),
      'desc-tabs': withTag('desc', desc2('sRGB \t \t\t  \t')),
    };
    for (const [n, tags] of Object.entries(dirty)) {
      const p = F.iccBuild({ tags });
      const i = inspectIcc(p);
      assert.ok(i.ok && !i.clean, `${n}: offered`);
      const c = cleanIcc(p);
      assert.ok(c && inspectIcc(c).clean, `${n}: cleaned`);
      assert.ok(!contains(c, 'Astr') && !contains(c, 'asTR') && !contains(c, 'AH') && !contains(c, 'sRGB \t'), `${n}: nothing left`);
    }
    assert.ok(inspectIcc(F.iccBuild({ tags: withTag('cprt', F.u8('text\0\0\0\0', 'Copyright 2009 Artifex Software Inc      \0')) })).clean, 'trailing ASCII spaces only');
    // A description whose structure does not fit is text that cannot be read: the profile
    // stays readable and green, and that tag is overwritten.
    const over = Buffer.from(desc2('Display P3', { uni: 'Display P3' }));
    over.writeUInt32BE(60, 12 + 11 + 4);
    const p = F.iccBuild({ tags: withTag('desc', new Uint8Array(over)) });
    const i = inspectIcc(p);
    assert.ok(i.ok && i.free.some((f) => f.text === 'text that could not be read'), JSON.stringify(i.free));
    assert.ok(cleanIcc(p), 'rewritten');
    // A declared size larger than the data is read as the data's size and written again.
    const big = F.iccBuild({ size: 4000 });
    assert.ok(inspectIcc(big).ok && !inspectIcc(big).clean);
    assert.equal(Buffer.from(cleanIcc(big)).readUInt32BE(0), big.length);
    // A named-colour profile is a list of names, not a colour space.
    assert.equal(inspectIcc(F.iccBuild({ header: { 12: 'nmcl' } })).ok, false);
  });

  test('JPEG colour profile segments count 1 to n of n', async () => {
    const prof = Buffer.from(F.iccBuild());
    const seg = (n, total, part) => F.jpegSeg(0xe2, F.u8('ICC_PROFILE\0', [n, total], part));
    F.write('icc-r4-numbers.jpg', F.jpegInsert(F.read('icc-base.jpg'), seg(1, 7, prof.subarray(0, 300)), seg(2, 7, prof.subarray(300))));
    const info = await core.inspect(F.read('icc-r4-numbers.jpg'));
    assert.equal(tierOf(info, 'icc:text'), 'red', ids(info).join(' '));
    await scrubTo('icc-r4-numbers.out-start.jpg', F.read('icc-r4-numbers.jpg'), redAmberIds(info));
    const out = Buffer.from(F.read('icc-r4-numbers.out-start.jpg'));
    const at = [];
    for (let p = out.indexOf('ICC_PROFILE\0'); p >= 0; p = out.indexOf('ICC_PROFILE\0', p + 1)) at.push([out[p + 12], out[p + 13]]);
    assert.deepEqual(at, [[1, 2], [2, 2]]);
    assert.ok(Buffer.from(F.iccOf(F.path('icc-r4-numbers.out-start.jpg')).bytes).equals(prof), 'the profile itself is the same');
  });

  test('technical EXIF fields have the type and number of values the specification gives', async () => {
    if (!existsSync(F.path('green-exif-base.jpg'))) F.magick(['-size', '64x48', 'plasma:fractal', '-seed', '151', '-depth', '8', '-strip', '-quality', '90', F.path('green-exif-base.jpg')]);
    const text = Buffer.from(`${NAME}, 12 Fjordveien, Bergen!!!`, 'latin1');
    const cases = {
      'xres-rational': { ifd0: [[0x011a, 5, 5, text.subarray(0, 40)]] },
      'fnumber-short': { exif: [[0x829d, 3, 19, Buffer.concat([text.subarray(0, 38)])]] },
      transfer: { ifd0: [[0x012d, 3, 768, Buffer.concat(Array(48).fill(text.subarray(0, 32)))]] },
      'pixelx-long': { le: true, exif: [[0xa002, 4, 10, text.subarray(0, 40)]] },
      double: { exif: [[0x9204, 12, 1, text.subarray(0, 8)]] },
      'inline-pad': { ifd0: [[0x0112, 3, 1, Buffer.from([0, 1, 0x41, 0x48])]] },
    };
    for (const [n, dirs] of Object.entries(cases)) {
      const name = `exif-r4-${n}.jpg`;
      F.write(name, F.jpegInsert(F.read('green-exif-base.jpg'), F.jpegSeg(0xe1, F.u8('Exif\0\0', F.tiffBlock(dirs)))));
      const info = await core.inspect(F.read(name));
      assert.equal(tierOf(info, 'exif:technical-text'), 'red', `${n}: ${ids(info).join(' ')}`);
      await scrubTo(name.replace('.jpg', '.out-start.jpg'), F.read(name), redAmberIds(info));
      const o = F.read(name.replace('.jpg', '.out-start.jpg'));
      // 'AH' is two bytes, so it is looked for only before the picture data (the first SOS):
      // the base picture is random plasma, and its compressed bytes can hold 'AH' by chance.
      const head = Buffer.from(o).subarray(0, Buffer.from(o).indexOf(Buffer.from([0xff, 0xda])));
      assert.ok(!contains(o, 'Astrid') && !contains(o, 'Holm') && !contains(head, 'AH'), `${n}: the name is gone`);
      assert.deepEqual((await core.inspect(o)).items.filter((i) => i.tier !== 'green').map((i) => i.id), [], n);
      const rebuilt = core.buildExif(F.read(name), new Set(info.items.filter((i) => i.tier === 'green').map((i) => i.id)));
      assert.ok(!rebuilt || !contains(rebuilt, 'Astrid'), `${n}: a re-save leaves it out`);
    }
    // Forms real devices write stay green: Microsoft's Padding header, an iPhone's composite
    // exposure times, a version written as text with a NUL, three component codes.
    const real = F.tiffBlock({ exif: [[0xea1c, 7, 0, Buffer.concat([Buffer.from([0x1c, 0xea, 0, 0, 0, 8]), Buffer.alloc(2054)])],
      [0xa462, 7, 0, Buffer.alloc(58, 1)], [0x9000, 2, 5, Buffer.from('0220\0', 'latin1')], [0x9101, 7, 3, Buffer.from([1, 2, 3])]] });
    F.write('exif-r4-real.jpg', F.jpegInsert(F.read('green-exif-base.jpg'), F.jpegSeg(0xe1, F.u8('Exif\0\0', real))));
    const ri = await core.inspect(F.read('exif-r4-real.jpg'));
    assert.ok(!ids(ri).includes('exif:technical-text'), ids(ri).join(' '));
  });

  test('XMP: prefixes, declarations, the packet wrapper, xml attributes, white space and numbers are not free', async () => {
    if (!existsSync(F.path('green-exif-base.jpg'))) F.magick(['-size', '64x48', 'plasma:fractal', '-seed', '151', '-depth', '8', '-strip', '-quality', '90', F.path('green-exif-base.jpg')]);
    const RDF = 'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"';
    const XMPNS = 'xmlns:xmp="http://ns.adobe.com/xap/1.0/"';
    const pkt = ({ begin = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>', desc = `rdf:about="" ${XMPNS} xmp:Rating="3"`, body = '', between = '\n' } = {}) =>
      `${begin}\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ${RDF}>${between}<rdf:Description ${desc}>${body}</rdf:Description>${between}</rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
    const exifNs = 'xmlns:exif="http://ns.adobe.com/exif/1.0/"';
    const cases = {
      prefix: pkt({ desc: 'rdf:about="" xmlns:Astrid_Holmvik="http://ns.adobe.com/xap/1.0/" Astrid_Holmvik:Rating="3"' }),
      'li-prefix': pkt({ desc: `rdf:about="" ${exifNs}`, body: '<exif:ISOSpeedRatings><Astrid.Holmvik:Seq xmlns:Astrid.Holmvik="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><Astrid.Holmvik:li>100</Astrid.Holmvik:li></Astrid.Holmvik:Seq></exif:ISOSpeedRatings>' }),
      'xml-attr': pkt({ desc: `rdf:about="" ${XMPNS} xml:note="${NAME}" xmp:Rating="3"` }),
      'unused-ns': pkt({ desc: `rdf:about="" ${XMPNS} xmlns:n="urn:${NAME}" xmp:Rating="3"` }),
      'xpacket-id': pkt({ begin: `<?xpacket begin="﻿" id="${NAME}"?>` }),
      'xml-lang': pkt({ desc: `rdf:about="" ${XMPNS}`, body: '<xmp:Rating xml:lang="x-Astrid-Holmvik">3</xmp:Rating>' }),
      'alt-lang': pkt({ desc: 'rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"', body: `<photoshop:ICCProfile><rdf:Alt><rdf:li xml:lang="${NAME}">sRGB IEC61966-2.1</rdf:li></rdf:Alt></photoshop:ICCProfile>` }),
      'rdf-attr': pkt({ desc: `rdf:about="" rdf:Astrid="Holmvik" ${XMPNS} xmp:Rating="3"` }),
      'typed-node': pkt({ desc: `rdf:about="" ${XMPNS} xmp:Rating="3"` }).replace('</rdf:RDF>', '<Astrid:Holmvik xmlns:Astrid="urn:x" rdf:about=""/></rdf:RDF>'),
      cdata: pkt({ desc: `rdf:about="" ${XMPNS}`, body: '<xmp:Rating><![CDATA[3]]></xmp:Rating>' }).replace('</rdf:RDF>', '<!-- --></rdf:RDF>'),
      'char-ref': pkt({ desc: `rdf:about="" ${XMPNS} xmp:Rating="&#0000000000000051;"` }),
      'ws-value': pkt({ desc: `rdf:about="" ${XMPNS} xmp:Rating="3    "` }),
      'ws-about': pkt({ desc: `rdf:about="   " ${XMPNS} xmp:Rating="3"` }),
      'ws-between': pkt({ between: '\n   　 \n' }),
      'number-list': pkt({ desc: `rdf:about="" ${exifNs}`, body: `<exif:FNumber><rdf:Seq>${[...'Astrid Holmvik'].map((c) => `<rdf:li>${c.charCodeAt(0)}</rdf:li>`).join('')}</rdf:Seq></exif:FNumber>` }),
      'long-number': pkt({ desc: 'rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:PoseHeadingDegrees="65115116114105.100321"' }),
      digest: pkt({ desc: 'rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:LegacyIPTCDigest="417374726964486F6C6D76696B212121"' }),
    };
    for (const [n, text] of Object.entries(cases)) {
      const name = `xmp-r4-${n}.jpg`;
      F.write(name, F.jpegInsert(F.read('green-exif-base.jpg'), F.jpegSeg(0xe1, F.u8('http://ns.adobe.com/xap/1.0/\0', Buffer.from(text, 'utf8')))));
      const info = await core.inspect(F.read(name));
      assert.ok(info.items.some((i) => i.tier === 'red'), `${n}: something red (${info.items.map((i) => `${i.tier}:${i.id}`).join(' ')})`);
      await scrubTo(name.replace('.jpg', '.out-start.jpg'), F.read(name), redAmberIds(info));
      const o = Buffer.from(F.read(name.replace('.jpg', '.out-start.jpg')));
      const ot = o.toString('utf8');
      assert.ok(!/Astrid|Holmvik|[ - 　]|65115116|417374/.test(ot), `${n}: nothing left`);
      const back = await core.inspect(o);
      assert.deepEqual(back.items.filter((i) => i.tier !== 'green').map((i) => i.id), [], `${n}: read back`);
    }
    // A plain packet in the usual form stays as it is.
    F.write('xmp-r4-plain.jpg', F.jpegInsert(F.read('green-exif-base.jpg'), F.jpegSeg(0xe1, F.u8('http://ns.adobe.com/xap/1.0/\0', Buffer.from(pkt(), 'utf8')))));
    const plain = await core.inspect(F.read('xmp-r4-plain.jpg'));
    assert.deepEqual(plain.items.map((i) => `${i.tier}:${i.id}`).filter((x) => x.includes('xmp')), ['green:xmp:technical']);
  });

  test('HDR: a name in a prefix, an xml attribute, a declaration or a number around a kept gain map goes, and the gain map stays', async () => {
    const HDRGM = 'http://ns.adobe.com/hdr-gain-map/1.0/';
    const RDFU = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
    const fields = (p) => `${p}:Version="1.0" ${p}:GainMapMin="0" ${p}:GainMapMax="2.3" ${p}:Gamma="1" ${p}:OffsetSDR="0.015625" ${p}:OffsetHDR="0.015625" ${p}:HDRCapacityMin="0" ${p}:HDRCapacityMax="2.3" ${p}:BaseRenditionIsHDR="False"`;
    const APPLE = 'xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/" xmlns:apdi="http://ns.apple.com/pixeldatainfo/1.0/"';
    const appleBody = (apdi = 'apdi', extra = '') => `   <HDRGainMap:HDRGainMapVersion>65536</HDRGainMap:HDRGainMapVersion>\n   <${apdi}:AuxiliaryImageType${extra}>urn:com:apple:photo:2020:aux:hdrgainmap</${apdi}:AuxiliaryImageType>`;
    const cases = {
      'photo-prefix': () => F.gainMapJpeg('gm-r4-photo-prefix.jpg', { companion: false, noVersion: true, photoNs: `xmlns:Astrid_Holmvik="${HDRGM}"`, photoAttrs: 'Astrid_Holmvik:Version="1.0"' }),
      'item-prefix': () => F.gainMapJpeg('gm-r4-item-prefix.jpg', { companion: false, photoNs: 'xmlns:Astrid.Holmvik="http://ns.google.com/photos/1.0/container/item/"', itemAttrs: 'Astrid.Holmvik:Padding="0"' }),
      'photo-xml-attr': () => F.gainMapJpeg('gm-r4-photo-xml-attr.jpg', { companion: false, photoAttrs: `xml:note="${NAME}"` }),
      'photo-unused-ns': () => F.gainMapJpeg('gm-r4-photo-unused-ns.jpg', { companion: false, photoNs: `xmlns:n="urn:${NAME}"` }),
      'gain-prefix': () => F.gainMapJpeg('gm-r4-gain-prefix.jpg', { companion: false, gainXmp: { ns: `xmlns:Astrid_Holmvik="${HDRGM}"`, attrs: fields('Astrid_Holmvik') } }),
      'gain-xml-attr': () => F.gainMapJpeg('gm-r4-gain-xml-attr.jpg', { companion: false, gainXmp: { ns: `xmlns:hdrgm="${HDRGM}" xml:note="${NAME}"`, attrs: fields('hdrgm') } }),
      'gain-seq-prefix': () => F.gainMapJpeg('gm-r4-gain-seq-prefix.jpg', { companion: false, gainXmp: { ns: `xmlns:hdrgm="${HDRGM}"`, attrs: fields('hdrgm').replace(' hdrgm:GainMapMax="2.3"', ''), body: `<hdrgm:GainMapMax><Astrid_Holmvik:Seq xmlns:Astrid_Holmvik="${RDFU}"><Astrid_Holmvik:li>2.3</Astrid_Holmvik:li></Astrid_Holmvik:Seq></hdrgm:GainMapMax>` } }),
      'apple-prefix': () => F.appleHdrJpeg('gm-r4-apple-prefix.jpg', { gainXmp: { ns: `${APPLE} xmlns:Astrid_Holmvik="http://ns.apple.com/pixeldatainfo/1.0/"`, body: appleBody('Astrid_Holmvik') } }),
      'apple-unused-ns': () => F.appleHdrJpeg('gm-r4-apple-unused-ns.jpg', { gainXmp: { ns: `${APPLE} xmlns:n="urn:${NAME}"`, body: appleBody() } }),
      'apple-xml-lang': () => F.appleHdrJpeg('gm-r4-apple-xml-lang.jpg', { gainXmp: { ns: APPLE, body: appleBody('apdi', ` xml:lang="x-${NAME.replace(' ', '-')}"`) } }),
    };
    for (const [n, make] of Object.entries(cases)) {
      const name = make();
      const b = F.read(name);
      assert.ok(nameIn(b), `${n}: planted`);
      const info = await core.inspect(b);
      assert.equal(tierOf(info, 'jpeg:trailing:gain-map'), 'amber', `${n}: ${ids(info).join(' ')}`);
      assert.ok(info.items.some((i) => i.tier === 'red' && i.id !== 'exif:makernote'), `${n}: something red (${ids(info).join(' ')})`);
      const out = name.replace('.jpg', '.out-start.jpg');
      const res = await scrubTo(out, b, redAmberIds(info));
      assert.deepEqual(res.warnings, [], n);
      const o = F.read(out);
      assert.ok(!nameIn(o) && !contains(o, 'Astrid_Holmvik') && !contains(o, 'Astrid.Holmvik'), `${n}: the name is gone`);
      const back = await core.inspect(o);
      assert.equal(core.privacyWord(back.items), 'public', `${n}: ${back.items.map((i) => `${i.tier}:${i.id}`).join(' ')}`);
      if (!n.startsWith('apple')) { gainMapRenders(name, out); continue; }
      // An Apple gain map has no directory: it is found through MPF, keeps its pixels, and
      // its XMP holds exactly the version and Apple's label, under the usual prefixes.
      const imgs = mpfImages(o);
      assert.equal(imgs[0].size, walkJpeg(o).eoiEnd, n);
      const gin = mpfImages(b)[1];
      F.write(`${name}.out-gm-in.jpg`, b.subarray(gin.offset, gin.offset + gin.size));
      F.write(`${name}.out-gm.jpg`, o.subarray(imgs[1].offset, imgs[1].offset + imgs[1].size));
      const [h1, h2] = F.decodeHashes([F.path(`${name}.out-gm-in.jpg`), F.path(`${name}.out-gm.jpg`)]);
      assert.ok(h1 && h1 === h2, `${n}: the gain map pixels are unchanged`);
      const gx = Buffer.from(o.subarray(imgs[1].offset, imgs[1].offset + imgs[1].size)).toString('latin1');
      assert.ok(/<apdi:AuxiliaryImageType>urn:com:apple:photo:2020:aux:hdrgainmap<\/apdi:AuxiliaryImageType>|apdi:AuxiliaryImageType="urn:com:apple:photo:2020:aux:hdrgainmap"/.test(gx), `${n}: Apple's label under its usual prefix`);
    }
  });

  test('decoder tables no scan uses go, in the photo and in a kept gain map; the pixels stay', async () => {
    const plant64 = Buffer.alloc(64, 0x20);
    Buffer.from(`${NAME}, 12 Fjordveien, 5300 Kleppesto`, 'latin1').copy(plant64);
    const dqt = F.jpegSeg(0xdb, F.u8([0x03], plant64));
    const sym = Buffer.from(`${NAME} Fjordveien`, 'latin1');
    const counts = Buffer.alloc(16); counts[7] = sym.length;
    const dht = F.jpegSeg(0xc4, F.u8([0x13], counts, sym));
    if (!existsSync(F.path('green-exif-base.jpg'))) F.magick(['-size', '64x48', 'plasma:fractal', '-seed', '151', '-depth', '8', '-strip', '-quality', '90', F.path('green-exif-base.jpg')]);
    F.write('tables-r4-photo.jpg', F.jpegInsert(F.read('green-exif-base.jpg'), dqt));
    const info = await core.inspect(F.read('tables-r4-photo.jpg'));
    assert.equal(tierOf(info, 'jpeg:unused-tables'), 'red', ids(info).join(' '));
    await scrubTo('tables-r4-photo.out-start.jpg', F.read('tables-r4-photo.jpg'), redAmberIds(info));
    assert.ok(!nameIn(F.read('tables-r4-photo.out-start.jpg')));
    samePixels('tables-r4-photo.jpg', 'tables-r4-photo.out-start.jpg', 'green-exif-base.jpg');
    for (const [n, seg] of [['dqt', dqt], ['dht', dht]]) {
      const name = F.gainMapJpeg(`gm-r4-${n}.jpg`, { companion: false, gainSegs: [seg] });
      const gi = await core.inspect(F.read(name));
      assert.equal(tierOf(gi, 'jpeg:trailing:gain-map:metadata'), 'red', `${n}: ${ids(gi).join(' ')}`);
      const out = name.replace('.jpg', '.out-start.jpg');
      await scrubTo(out, F.read(name), redAmberIds(gi));
      assert.ok(!nameIn(F.read(out)), `${n}: the name is gone`);
      gainMapRenders(name, out);
    }
    // Tables in use are not touched: a stock JPEG has none to offer.
    assert.ok(!ids(await core.inspect(F.read('green-exif-base.jpg'))).includes('jpeg:unused-tables'));
  });

  test("an ISO 21496-1 gain map applied in its own colour space keeps its own profile", async () => {
    const own = F.iccProfileV4({ desc: 'Rec2020 Gamut with sRGB Transfer', cprt: 'Google Inc. 2023' });
    const photo = F.iccProfileV4({ desc: 'Display P3 Gamut with sRGB Transfer', cprt: 'Google Inc. 2023' });
    const name = F.gainMapJpeg('gm-r4-iso-own-colour.jpg', { companion: false, photoSegs: [F.iccSegment(photo)], gainIso: [F.isoBlock({ channels: 3 })], gainSegs: [F.iccSegment(own)] });
    const info = await core.inspect(F.read(name));
    assert.equal(tierOf(info, 'jpeg:trailing:gain-map:colour'), 'green');
    await scrubTo('gm-r4-iso-own-colour.out-start.jpg', F.read(name), redAmberIds(info));
    const g = mpfImages(F.read('gm-r4-iso-own-colour.out-start.jpg'))[1];
    const sub = F.read('gm-r4-iso-own-colour.out-start.jpg').subarray(g.offset, g.offset + g.size);
    assert.ok(Buffer.from(sub).includes(Buffer.from(own)), 'the gain map keeps its profile byte for byte');
    gainMapRenders(name, 'gm-r4-iso-own-colour.out-start.jpg');
  });

  test('PNG: a technical exif text copy has no more values than its field', async () => {
    F.magick(['-size', '64x48', 'plasma:fractal', '-seed', '152', '-depth', '8', '-strip', `PNG24:${F.path('green-png-base.png')}`]);
    const codes = [...'Astrid Holmvik'].map((c) => c.charCodeAt(0)).join(',');
    for (const [n, kw, value, want] of [['codes', 'exif:FNumber', codes, 'red'], ['one', 'exif:FNumber', '28/10', null], ['iso', 'exif:ISOSpeedRatings', '100, 200', null]]) {
      F.write(`png-r4-${n}.png`, F.pngInsertBefore(F.read('green-png-base.png'), 'IDAT', F.pngChunk('tEXt', F.u8(kw, [0], value))));
      const pi = await core.inspect(F.read(`png-r4-${n}.png`));
      assert.equal(tierOf(pi, 'png:exif-text:technical-text'), want ?? undefined, `${n}: ${ids(pi).join(' ')}`);
    }
  });

  test('item text of the new probes has no em dashes or double hyphens', async () => {
    for (const name of ['icc-r4-header.jpg', 'icc-r4-numbers.jpg', 'exif-r4-transfer.jpg', 'xmp-r4-prefix.jpg', 'xmp-r4-xpacket-id.jpg', 'tables-r4-photo.jpg', 'gm-r4-dqt.jpg', 'gm-r4-photo-prefix.jpg']) {
      const info = await core.inspect(F.read(name));
      for (const i of info.items) {
        for (const field of ['label', 'note']) {
          const t = i[field] || '';
          assert.ok(!t.includes('—') && !t.includes('-' + '-'), `${i.id} ${field}: ${t}`);
        }
        assert.ok(i.value.length <= 80, `${name} ${i.id} value too long: ${i.value}`);
      }
    }
  });
});

// ======================================================================================
// 0.0.3, decision 4 ("empty blank spaces"): every XMP packet that stays is written again in
// one canonical form, so nothing in how it was laid out survives: no white space between
// nodes, no padding, attributes, declarations and structure fields in a fixed order, no
// comments or processing instructions beyond the plain packet wrapper. The checks read the
// packets back out of the files.

// A message spelt in white space: each bit a space or a tab, each byte ended by a newline.
const WS_BITS = (text) => [...Buffer.from(text, 'latin1')].map((c) => `${[...c.toString(2).padStart(8, '0')].map((x) => (x === '1' ? '\t' : ' ')).join('')}\n`).join('');
const WS_MSG = WS_BITS('Ingrid Holm, Fjordveien 12');
// A packet laid out with that message between its nodes and padding after it, holding a
// date (amber, kept by default), a rating (green) and a creator (red).
const wsPacket = (msg = WS_MSG, pad = 2048) => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>${msg}<x:xmpmeta xmlns:x="adobe:ns:meta/">${msg}<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${msg}<rdf:Description rdf:about=""${msg}xmlns:xmp="http://ns.adobe.com/xap/1.0/"${msg}xmlns:dc="http://purl.org/dc/elements/1.1/"   xmp:Rating="3"${msg}>${msg}<xmp:CreateDate>${msg}2026-09-14T10:15:23${msg}</xmp:CreateDate>${msg}<dc:creator>${msg}<rdf:Seq>${msg}<rdf:li>${PLANT.xmpCreator}</rdf:li>${msg}</rdf:Seq>${msg}</dc:creator>${msg}</rdf:Description>${msg}</rdf:RDF>${msg}</x:xmpmeta>${' '.repeat(pad)}${msg}<?xpacket end="w"?>`;

// The XMP packets of a file, as text: { photo: [...], gain: [...] }.
function xmpPacketsOf(bytes) {
  const b = Buffer.from(bytes);
  const fmt = b[0] === 0xff ? 'jpeg' : b.toString('latin1', 1, 4) === 'PNG' ? 'png' : b.toString('latin1', 8, 12) === 'WEBP' ? 'webp' : 'heic';
  const out = { photo: [], gain: [] };
  const fromJpeg = (x, list) => {
    for (const s of walkJpeg(x).segs) {
      if (s.kind === 'seg' && s.marker === 0xe1 && Buffer.from(x.subarray(s.dataStart, s.dataStart + XMP_HEAD.length)).toString('latin1') === XMP_HEAD) list.push(Buffer.from(x.subarray(s.dataStart + XMP_HEAD.length, s.end)).toString('utf8'));
    }
  };
  if (fmt === 'jpeg') {
    fromJpeg(b, out.photo);
    const imgs = mpfImages(b);
    for (const g of (imgs || []).slice(1)) fromJpeg(b.subarray(g.offset, g.offset + g.size), out.gain);
  } else if (fmt === 'png') {
    for (let p = 8; p + 12 <= b.length;) {
      const n = b.readUInt32BE(p);
      const d = b.subarray(p + 8, p + 8 + n);
      if (b.toString('latin1', p + 4, p + 8) === 'iTXt' && d.toString('latin1', 0, 18) === 'XML:com.adobe.xmp\0') out.photo.push(d.subarray(18 + 4).toString('utf8'));
      p += 12 + n;
    }
  } else if (fmt === 'webp') {
    for (const c of F.webpChunks(b)) if (c.type === 'XMP ') out.photo.push(Buffer.from(c.data).toString('utf8'));
  } else {
    const m = parseHeif(b);
    const gainIds = new Set(m.refs.filter((r) => r.type === 'auxl').map((r) => r.from));
    for (const it of m.items.values()) {
      if (it.contentType !== 'application/rdf+xml') continue;
      const text = Buffer.concat(it.ranges.map(([s, e]) => b.subarray(s, e))).toString('utf8');
      const ofGain = m.refs.some((r) => r.type === 'cdsc' && r.from === it.id && r.to.some((t) => gainIds.has(t)));
      (ofGain ? out.gain : out.photo).push(text);
    }
  }
  return out;
}

// A packet is in the canonical form when writing it again gives the same text; an emptied
// HEIC packet is the one fixed empty packet.
function assertCanonical(text, compact, label) {
  if (text === '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>') return;
  assert.equal(canonicalXmp(parseXmp(text), compact), text, `${label}: the packet is in the canonical form`);
  assert.ok(!/>[ \t\r\n]+</.test(text), `${label}: no white space between nodes`);
  assert.ok(!/^[ \t\r\n]|[ \t\r\n]$/.test(text), `${label}: no padding`);
  assert.ok(!text.includes('<!--') && (text.match(/<\?/g) || []).length <= 2, `${label}: no comments or other processing instructions`);
}

describe('0.0.3: every XMP packet that stays is in the canonical form', () => {
  const base = () => {
    if (!existsSync(F.path('canon-base.jpg'))) F.magick(['-size', '96x64', 'plasma:fractal', '-seed', '161', '-depth', '8', '-strip', '-quality', '90', F.path('canon-base.jpg')]);
    if (!existsSync(F.path('canon-base.png'))) F.magick(['-size', '96x64', 'plasma:fractal', '-seed', '162', '-depth', '8', '-strip', `PNG24:${F.path('canon-base.png')}`]);
    return { jpg: F.read('canon-base.jpg'), png: F.read('canon-base.png') };
  };

  test('white space between nodes and padding go in JPEG, PNG, WebP and HEIC; values stay', async () => {
    const { jpg, png } = base();
    const packet = Buffer.from(wsPacket(), 'utf8');
    F.write('ws.jpg', F.jpegInsert(jpg, F.jpegSeg(0xe1, F.u8(XMP_HEAD, packet))));
    F.write('ws.png', F.pngInsertBefore(png, 'IDAT', F.pngChunk('iTXt', F.u8('XML:com.adobe.xmp', [0, 0, 0, 0, 0], packet))));
    if (!existsSync(F.path('canon-base.webp'))) {
      F.magick(['-size', '96x64', 'plasma:fractal', '-seed', '163', '-depth', '8', '-quality', '80', F.path('canon-base.webp')]);
      F.exiftoolWrite(F.path('canon-base.webp'), ['-XMP-xmp:Rating=1']);
    }
    const webp = F.webpChunks(F.read('canon-base.webp')).map((c) => (c.type === 'XMP ' ? F.webpChunk('XMP ', packet) : c.raw));
    F.write('ws.webp', F.webpRebuild(webp));
    F.appleHdrHeic('ws.heic', { noGain: true, photoXmp: `${WS_MSG}<xmp:CreateDate>${WS_MSG}2026-09-14T10:15:23</xmp:CreateDate>${WS_MSG}<xmp:Rating>3</xmp:Rating><dc:creator><rdf:Seq><rdf:li>${PLANT.xmpCreator}</rdf:li></rdf:Seq></dc:creator>`, pad: 2048 });
    for (const name of ['ws.jpg', 'ws.png', 'ws.webp', 'ws.heic']) {
      const b = F.read(name);
      const info = await core.inspect(b);
      assert.equal(info.normalise, true, `${name}: the layout is not canonical`);
      assert.equal(tierOf(info, 'xmp:dates'), 'amber', name);
      const out = name.replace(/\.(\w+)$/, '.out-red.$1');
      const res = await scrubTo(out, b, reds(info));
      assert.deepEqual(res.warnings.filter((w) => /XMP/.test(w)), [], `${name}: ${res.warnings.join(' / ')}`);
      const o = F.read(out);
      const packets = xmpPacketsOf(o).photo;
      assert.equal(packets.length, 1, `${name}: one packet`);
      assertCanonical(packets[0], name.endsWith('.heic'), name);
      assert.ok(packets[0].includes('<xmp:CreateDate>2026-09-14T10:15:23</xmp:CreateDate>'), `${name}: the date stays, without the white space around it`);
      assert.match(packets[0], /xmp:Rating="3"|<xmp:Rating>3<\/xmp:Rating>/, `${name}: the rating stays`);
      assert.ok(!contains(o, PLANT.xmpCreator), `${name}: the creator goes`);
      assert.ok(!/[ \t\n]{2,}/.test(packets[0]), `${name}: no run of white space survives`);
      const back = await core.inspect(o);
      assert.equal(back.normalise, false, `${name}: read back, nothing more to normalise`);
      assert.equal(back.items.find((i) => i.id === 'xmp:dates').value, info.items.find((i) => i.id === 'xmp:dates').value, `${name}: the date reads the same`);
      // Prepared again with nothing ticked, the file does not change.
      const again = await core.scrub(o, []);
      assert.ok(Buffer.from(again.bytes).equals(Buffer.from(o)), `${name}: idempotent`);
      if (name.endsWith('.heic')) heicIntact(b, o, name);
      else noNewWarnings(name, out);
      samePixels(name, out);
    }
  });

  // The form of a value (an attribute or an element, a nested rdf:Description or
  // rdf:parseType="Resource") is kept as written, because some readers take only one form.
  test('two packets that differ only in layout, prefixes and order give the same bytes', async () => {
    const { jpg } = base();
    const a = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmp:Rating="3" xmp:CreateDate="2026-09-14T10:15:23"><exif:Flash rdf:parseType="Resource"><exif:Fired>False</exif:Fired><exif:Mode>2</exif:Mode></exif:Flash><xmp:ModifyDate>2026-09-15T08:00:00</xmp:ModifyDate></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const b = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:ModifyDate>2026-09-15T08:00:00</xmp:ModifyDate>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:e="http://ns.adobe.com/exif/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
     xmp:CreateDate="2026-09-14T10:15:23"
        xmp:Rating='3'>
   <e:Flash
       rdf:parseType="Resource">
     <e:Mode>2</e:Mode>
     <e:Fired>False</e:Fired>
   </e:Flash>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
${' '.repeat(500)}
<?xpacket end="w"?>`;
    const outs = [];
    for (const [n, t] of [['order-a.jpg', a], ['order-b.jpg', b]]) {
      F.write(n, F.jpegInsert(jpg, F.jpegSeg(0xe1, F.u8(XMP_HEAD, Buffer.from(t, 'utf8')))));
      outs.push(Buffer.from((await core.scrub(F.read(n), [])).bytes));
    }
    assert.equal(xmpPacketsOf(outs[0]).photo[0], xmpPacketsOf(outs[1]).photo[0]);
    assert.ok(outs[0].equals(outs[1]), 'the two files are the same once prepared');
  });

  test('a packet that cannot be written in the canonical form is unreadable, red, and never kept', async () => {
    const { jpg } = base();
    // One prefix bound to two unknown namespaces cannot share one fresh node.
    const t = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:a="http://example.com/one/" a:Thing="2026"/>
<rdf:Description rdf:about="" xmlns:a="http://example.com/two/"><a:title>T</a:title></rdf:Description>
</rdf:RDF></x:xmpmeta>`;
    F.write('canon-fail.jpg', F.jpegInsert(jpg, F.jpegSeg(0xe1, F.u8(XMP_HEAD, Buffer.from(t, 'utf8')))));
    const b = F.read('canon-fail.jpg');
    const info = await core.inspect(b);
    assert.deepEqual(info.items.filter((i) => i.source === 'XMP').map((i) => `${i.tier}:${i.id}`), ['red:xmp:packet']);
    assert.equal(info.items.find((i) => i.id === 'xmp:packet').note, 'It may hold anything, so removing it is the safe choice.');
    const res = await core.scrub(b, []);
    assert.equal(xmpPacketsOf(res.bytes).photo.length, 0, 'not kept, even unticked');
    assert.ok(res.warnings.some((w) => /could not be read was removed/.test(w)), res.warnings.join(' / '));
  });

  test('comments, odd characters and Unicode spaces between nodes are not kept either', async () => {
    const p = parseXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><!-- note --><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"> <xmp:CreateDate>2026</xmp:CreateDate></rdf:Description></rdf:RDF></x:xmpmeta>`);
    const items = [];
    const set = new ItemSet();
    items.push(...addXmpItems(set, p, {}, {}, 0));
    assert.ok(items.some((i) => i.key === 'hidden'), 'the comment and the no-break space are hidden text');
    // Kept on purpose, the hidden text still cannot survive the canonical form; the scrub says so.
    const plan = planXmp(p, items.map((i) => ({ id: i.id, key: i.key, props: i.props })), new Set());
    assert.equal(plan.action, 'rewrite');
    assert.ok(!plan.text.includes('note') && !plan.text.includes(' '));
    assert.match(plan.warning, /Hidden text inside XMP was removed although it was not ticked/);
  });

  test('Extended XMP that stays is written again in the canonical form, with a new GUID', async () => {
    const name = F.jpegExtended();
    const b = F.read(name);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'xmp:extended'), 'red');
    // Kept on purpose: only the creator goes.
    const res = await scrubTo('extended.out-kept.jpg', b, ['xmp:creator']);
    assert.deepEqual(res.warnings, []);
    const o = Buffer.from(F.read('extended.out-kept.jpg'));
    const segs = walkJpeg(o).segs.filter((s) => s.kind === 'seg' && s.marker === 0xe1 && o.toString('latin1', s.dataStart, s.dataStart + 35) === 'http://ns.adobe.com/xmp/extension/\0');
    assert.ok(segs.length >= 2, 'split over several segments again');
    const guid = o.toString('latin1', segs[0].dataStart + 35, segs[0].dataStart + 67);
    const whole = Buffer.concat(segs.map((s) => o.subarray(s.dataStart + 75, s.end)));
    assert.equal(createHash('md5').update(whole).digest('hex').toUpperCase(), guid, 'the GUID is the MD5 of the new packet');
    assert.equal(segs.every((s) => o.readUInt32BE(s.dataStart + 67) === whole.length), true, 'each part gives the full length');
    assertCanonical(whole.toString('utf8'), true, 'extended');
    const main = xmpPacketsOf(o).photo[0];
    assertCanonical(main, false, 'main');
    assert.ok(main.includes(`xmpNote:HasExtendedXMP="${guid}"`), 'the photo points to it by the new GUID');
    assert.ok(!contains(o, PLANT.xmpCreator));
    // exiftool joins the parts again, so the GUID, lengths and offsets agree.
    const rows = F.exifRead(F.path('extended.out-kept.jpg'));
    assert.ok(rows.some((r) => r.tag === 'Secret' && r.value === 'EXTXMP-PLANT-SECRET'), 'exiftool reads the Extended XMP');
    noNewWarnings(name, 'extended.out-kept.jpg');
    const again = await core.scrub(o, []);
    assert.ok(Buffer.from(again.bytes).equals(o), 'idempotent');
  });

  test("the kept HDR gain map's own XMP is canonical, and the directory and MPF follow its length", async () => {
    const name = F.gainMapJpeg('canon-gm.jpg', {});
    const b = F.read(name);
    const before = xmpPacketsOf(b).gain[0];
    assert.ok(/>\s+</.test(before), 'the fixture lays the gain map XMP out with white space');
    const info = await core.inspect(b);
    assert.equal(info.normalise, true);
    // Nothing removed: the gain map is still written again.
    await scrubTo('canon-gm.out-none.jpg', b, []);
    const o = F.read('canon-gm.out-none.jpg');
    const packets = xmpPacketsOf(o);
    assertCanonical(packets.photo[0], false, 'photo');
    assertCanonical(packets.gain[0], true, 'gain map');
    gainMapRenders(name, 'canon-gm.out-none.jpg');
    assert.ok(mpfImages(o)[1].size < F.read(`${name}.gain.jpg`).length, 'the gain map is shorter');
    noNewWarnings(name, 'canon-gm.out-none.jpg');
    // An iPhone gain map keeps its fixed label and version in the canonical form.
    const apple = F.appleHdrJpeg('canon-gm-apple.jpg');
    const ab = F.read(apple);
    await scrubTo('canon-gm-apple.out-red.jpg', ab, reds(await core.inspect(ab)));
    const ag = xmpPacketsOf(F.read('canon-gm-apple.out-red.jpg')).gain[0];
    assertCanonical(ag, true, 'apple gain map');
    assert.match(ag, /apdi:AuxiliaryImageType="urn:com:apple:photo:2020:aux:hdrgainmap"|<apdi:AuxiliaryImageType>urn:com:apple:photo:2020:aux:hdrgainmap</);
    assert.equal((await core.inspect(F.read('canon-gm-apple.out-red.jpg'))).normalise, false);
  });
});

// ======================================================================================
// 0.0.3, decision 5: an iPhone HEIC keeps its HDR gain map and Apple HDR brightness by
// default (both amber), as an iPhone JPEG does. The gain map is the auxiliary image named
// exactly urn:com:apple:photo:2020:aux:hdrgainmap; the brightness is the two MakerNote
// numbers (tags 33 and 48), kept in a minimal MakerNote when the rest of it goes. The two
// go together. Any other auxiliary name that is not on the fixed list is red.

describe('0.0.3: iPhone HEIC HDR', () => {
  const APPLE = 'urn:com:apple:photo:2020:aux:hdrgainmap';
  const hdrRows = (file) => {
    const rows = F.exifRead(F.path(file));
    const get = (tag) => rows.find((r) => r.tag === tag)?.value;
    return { headroom: get('HDRHeadroom'), gain: get('HDRGain'), aux: get('AuxiliaryImageType'), version: get('HDRGainMapVersion') };
  };

  test('the gain map and the HDR brightness stay by default; the rest of the MakerNote goes', async () => {
    const name = F.appleHdrHeic('apple-hdr.heic', { gainBody: `\n         <HDRGainMap:OwnerNote>${PLANT.hdr}</HDRGainMap:OwnerNote>` });
    const b = F.read(name);
    const info = await core.inspect(b);
    assert.equal(tierOf(info, 'heic:gain-map'), 'amber');
    assert.equal(tierOf(info, 'exif:apple-hdr'), 'amber');
    assert.equal(tierOf(info, 'exif:makernote'), 'red');
    assert.equal(tierOf(info, 'heic:gain-map:metadata'), 'red', 'a field the gain map does not need');
    assert.ok(!ids(info).includes('heic:aux-image'));
    assert.ok(!info.warnings.some((w) => /depth map/.test(w)), info.warnings.join(' / '));
    const res = await scrubTo('apple-hdr.out-red.heic', b, reds(info));
    assert.deepEqual(res.warnings, []);
    const o = F.read('apple-hdr.out-red.heic');
    for (const s of [PLANT.appleNote, PLANT.hdr, PLANT.xmpCreator]) assert.ok(!contains(o, s), `${s} goes`);
    const before = hdrRows(name);
    const after = hdrRows('apple-hdr.out-red.heic');
    assert.equal(after.aux, APPLE);
    assert.equal(after.headroom, before.headroom, 'HDRHeadroom (tag 33) reads the same');
    assert.equal(after.gain, before.gain, 'HDRGain (tag 48) reads the same');
    assert.equal(after.version, '65536', "the gain map's HDRGainMapVersion stays");
    // libheif: the picture and the gain map decode to the same pixels, and the gain map is
    // still attached to the picture with Apple's name.
    const heif = F.heifInfo([F.path(name), F.path('apple-hdr.out-red.heic')]);
    const [hin, hout] = [heif[F.path(name)], heif[F.path('apple-hdr.out-red.heic')]];
    assert.ok(hin.primary && hin.primary === hout.primary, 'the picture decodes the same');
    assert.equal(hout.aux.length, 1);
    assert.equal(hout.aux[0].type, APPLE);
    assert.equal(hout.aux[0].pixels, hin.aux[0].pixels, 'the gain map decodes the same');
    heicIntact(b, o, 'apple-hdr.out-red.heic');
    const back = await core.inspect(o);
    assert.deepEqual(back.items.filter((i) => i.tier !== 'green').map((i) => `${i.tier}:${i.id}`).sort(),
      ['amber:exif:apple-hdr', 'amber:exif:camera', 'amber:exif:datetime', 'amber:heic:gain-map', 'amber:xmp:dates']);
    assert.equal(core.privacyWord(back.items), 'public');
    assert.equal(back.normalise, false);
    assert.ok(Buffer.from((await core.scrub(o, [])).bytes).equals(Buffer.from(o)), 'idempotent');
    // The gain map's own description keeps only its version, in the canonical form.
    const gainXmp = xmpPacketsOf(o).gain[0];
    assertCanonical(gainXmp, true, 'gain map XMP');
    assert.ok(!gainXmp.includes('xmptk'));
  });

  test('the gain map and the HDR brightness go together, in either direction', async () => {
    const name = F.appleHdrHeic('apple-pair.heic');
    const b = F.read(name);
    const red = reds(await core.inspect(b));
    for (const [out, ticks] of [['apple-pair.no-brightness.heic', [...red, 'exif:apple-hdr']], ['apple-pair.no-gain.heic', [...red, 'heic:gain-map']]]) {
      const res = await scrubTo(out, b, ticks);
      assert.deepEqual(res.warnings, [], out);
      const o = F.read(out);
      const back = await core.inspect(o);
      assert.ok(!ids(back).some((id) => /gain-map|apple-hdr|makernote/.test(id)), `${out}: ${ids(back).join(' ')}`);
      const rows = hdrRows(out);
      assert.equal(rows.headroom, undefined, `${out}: no HDR brightness left`);
      assert.ok(!rows.aux, `${out}: no auxiliary image named`);
      const heif = F.heifInfo([F.path(name), F.path(out)]);
      assert.equal(heif[F.path(out)].aux.length, 0, `${out}: no gain map attached`);
      assert.equal(heif[F.path(out)].primary, heif[F.path(name)].primary, `${out}: the picture decodes the same`);
      assert.equal(core.privacyWord(back.items), 'public');
    }
    // The gain map alone ticked, the maker notes kept: the whole MakerNote stays.
    await scrubTo('apple-pair.gain-only.heic', b, ['heic:gain-map']);
    const rows = hdrRows('apple-pair.gain-only.heic');
    assert.ok(rows.headroom !== undefined && !rows.aux);
    assert.ok(contains(F.read('apple-pair.gain-only.heic'), PLANT.appleNote), 'the maker notes were kept, as ticked');
  });

  test('an auxiliary image with a name that is not exactly a known one is red and goes', async () => {
    const cases = [
      ['apple-aux-name.heic', { auxType: `${APPLE} ${PLANT.hdr2}` }, PLANT.hdr2],
      ['apple-aux-tail.heic', { auxTail: Buffer.from(PLANT.hdr2) }, PLANT.hdr2],
      ['apple-aux-near.heic', { auxType: `${APPLE}2` }, `${APPLE}2`],
      ['apple-aux-free.heic', { auxType: `urn:example:${PLANT.hdr2}` }, PLANT.hdr2],
    ];
    for (const [name, opts, plant] of cases) {
      F.appleHdrHeic(name, opts);
      const b = F.read(name);
      assert.ok(contains(b, plant), `${name}: planted`);
      const info = await core.inspect(b);
      assert.equal(tierOf(info, 'heic:aux-image'), 'red', `${name}: ${ids(info).join(' ')}`);
      assert.ok(!ids(info).includes('heic:gain-map') && !ids(info).includes('exif:apple-hdr'), `${name}: not a gain map`);
      const out = name.replace('.heic', '.out-red.heic');
      await scrubTo(out, b, reds(info));
      const o = F.read(out);
      assert.ok(!contains(o, plant), `${name}: the name goes`);
      const heif = F.heifInfo([F.path(name), F.path(out)]);
      assert.equal(heif[F.path(out)].aux.length, 0, `${name}: the layer is no longer attached`);
      assert.equal(heif[F.path(out)].primary, heif[F.path(name)].primary, `${name}: the picture decodes the same`);
      const back = await core.inspect(o);
      assert.deepEqual(back.items.filter((i) => i.tier === 'red').map((i) => i.id), [], `${name}: nothing red left`);
    }
  });

  test('known auxiliary names stay as they are, and a HEIC without a gain map gets no HDR details', async () => {
    const name = F.appleHdrHeic('apple-matte.heic', { auxType: 'urn:com:apple:photo:2018:aux:portraiteffectsmatte' });
    const b = F.read(name);
    const info = await core.inspect(b);
    assert.ok(!ids(info).some((id) => /gain-map|apple-hdr|aux-image/.test(id)), ids(info).join(' '));
    assert.ok(info.warnings.some((w) => /depth map or another extra image layer/.test(w)));
    await scrubTo('apple-matte.out-red.heic', b, reds(info));
    const heif = F.heifInfo([F.path('apple-matte.out-red.heic')]);
    assert.deepEqual(heif[F.path('apple-matte.out-red.heic')].aux.map((a) => a.type), ['urn:com:apple:photo:2018:aux:portraiteffectsmatte']);
    assert.ok(!contains(F.read('apple-matte.out-red.heic'), PLANT.appleNote), 'without a gain map the whole MakerNote goes');
  });
});

// ======================================================================================
// 0.0.3, decision 6 (Marcos, 2026-10-04): the page ticks red only. Free text that can name
// people (captions, titles, descriptions, keywords, comments, edit history with its file
// names, other IPTC and Photoshop text) is red; amber holds structured details only.

describe('0.0.3: free text is red, structured details stay amber', () => {
  test('tier descriptions', () => {
    assert.equal(core.TIERS.amber.description, 'Can reveal routines, devices or history. Kept unless you tick it.');
    assert.equal(core.TIERS.red.description, 'Can identify you, your camera or the place. Removed by default.');
    assert.equal(core.TIERS.green.description, 'Helps the picture display correctly. Kept by default.');
  });

  test('free text items are red, structured items amber', () => {
    for (const k of ['caption', 'keywords', 'instructions', 'other']) assert.equal(IPTC_ITEMS[k].tier, 'red', `iptc:${k}`);
    for (const k of ['dates', 'software']) assert.equal(IPTC_ITEMS[k].tier, 'amber', `iptc:${k}`);
    assert.equal(TIFF_ITEMS.description.tier, 'red');
    for (const k of ['datetime', 'timezone', 'camera', 'lens', 'software', 'other', 'apple-hdr']) assert.equal(TIFF_ITEMS[k].tier, 'amber', `exif:${k}`);
    for (const k of ['description', 'history']) assert.equal(XMP_ITEMS[k].tier, 'red', `xmp:${k}`);
    for (const k of ['dates', 'camera', 'software', 'motion', 'gainmap']) assert.equal(XMP_ITEMS[k].tier, 'amber', `xmp:${k}`);
  });

  test('EXIF ImageDescription, UserComment and the XP fields are one red detail', async () => {
    const tiff = F.tiffBlock({ ifd0: [[0x010e, 2, 0, 'Astrid at the lake'], [0x010f, 2, 0, 'Fjordcam'], [0x9c9b, 1, 0, Buffer.from('Title\0', 'utf16le')], [0x9c9c, 1, 0, Buffer.from('Note\0', 'utf16le')], [0x9c9e, 1, 0, Buffer.from('Keys\0', 'utf16le')], [0x9c9f, 1, 0, Buffer.from('Subj\0', 'utf16le')]], exif: [[0x9286, 7, 0, Buffer.concat([Buffer.from('ASCII\0\0\0'), Buffer.from('Comment')])]] });
    const b = F.jpegInsert(F.read(F.jpegProgressive()), F.jpegSeg(0xe1, F.u8('Exif\0\0', tiff)));
    const info = await core.inspect(b);
    const desc = info.items.filter((i) => /^exif:description/.test(i.id));
    assert.ok(desc.length && desc.every((i) => i.tier === 'red'), desc.map((i) => `${i.id} ${i.tier}`).join(', '));
    assert.ok(info.items.some((i) => /^exif:camera/.test(i.id) && i.tier === 'amber'));
  });

  test('PNG text under any keyword, and a JPEG comment, are red', async () => {
    const png = F.pngInsertBefore(F.read(F.pngFull()), 'IDAT', F.pngChunk('tEXt', 'Shot by\0Astrid Holmvik'), F.pngChunk('tEXt', 'Disclaimer\0Private'));
    const pi = await core.inspect(png);
    assert.equal(pi.items.find((i) => i.id === 'png:text:shot-by').tier, 'red');
    assert.equal(pi.items.find((i) => i.id === 'png:notes').tier, 'red');
    const out = await core.scrub(png, pi.items.filter((i) => i.tier === 'red').map((i) => i.id));
    assert.ok(!contains(out.bytes, 'Astrid Holmvik') && !contains(out.bytes, 'Private'), 'red only removes them');
    const jpg = F.jpegInsert(F.read(F.jpegProgressive()), F.jpegSeg(0xfe, F.u8('For Astrid')));
    const ji = await core.inspect(jpg);
    assert.equal(ji.items.find((i) => i.id === 'jpeg:comment').tier, 'red');
  });

  // Since the review of 4 October 2026 every manifest is red: the signer's certificate, the
  // generator's name, ingredient names and compressed assertions can all name a person, and
  // each manifest carries a unique identifier.
  test('Content Credentials are always red; what they are seen to repeat is named', () => {
    const box = (json) => Buffer.from(json, 'latin1');
    const plain = describeC2pa([box('{"claim_generator":"FjordOS/1.0","alg":"sha256"}')]);
    assert.equal(plain.tier, 'red');
    assert.match(plain.note, /signer's certificate/);
    for (const j of ['{"dc:title":"Astrid at the lake.jpg"}', '{"actions":[{"action":"c2pa.edited","description":"for Astrid"}]}', '{"title":"x"}']) {
      const d = describeC2pa([box(j)]);
      assert.equal(d.tier, 'red', j);
      assert.match(d.value, /titles or descriptions/);
    }
    assert.match(describeC2pa([box('{"label":"c2pa.thumbnail.ingredient.jpeg"}')]).value, /a preview of the original picture/);
  });

  test('red only keeps dates, camera, lens and software, and removes free text', async () => {
    const b = F.read(F.jpegFull());
    const info = await core.inspect(b);
    const out = await core.scrub(b, reds(info));
    const back = await core.inspect(out.bytes);
    const left = new Set(back.items.map((i) => i.id));
    for (const id of ['exif:datetime', 'exif:timezone', 'exif:camera', 'exif:lens', 'exif:software', 'xmp:dates', 'xmp:software', 'iptc:dates']) assert.ok(left.has(id), `${id} kept`);
    for (const id of ['exif:description', 'xmp:description', 'xmp:history', 'iptc:caption', 'iptc:keywords', 'iptc:instructions', 'jpeg:comment']) assert.ok(!left.has(id), `${id} removed`);
    assert.ok(back.items.every((i) => i.tier !== 'red'));
    assert.equal(core.privacyWord(back.items), 'public');
  });
});

// ======================================================================================
// The privacy and compatibility reviews of 4 October 2026: since only red is ticked to
// start with, whatever an amber or green detail keeps by default must hold nothing a person
// cannot see (tests/probes.mjs), and kept values must read the same to standard readers.

describe('0.0.3 review: nothing hidden rides along with what is kept by default', () => {
  test('every probe: red canaries go with red only, visible names stay amber, red and amber removes all', async () => {
    const { privacyProbes } = await import('./probes.mjs');
    for (const p of privacyProbes(F)) {
      const info = await core.inspect(p.bytes);
      for (const c of p.canaries) assert.ok(contains(p.bytes, c.string), `${p.name}: the input holds ${c.string}`);
      const ext = p.name.split('.').pop();
      const redOut = p.name.replace(/\.\w+$/, `.out-red.${ext}`);
      await scrubTo(redOut, p.bytes, reds(info));
      const out = F.read(redOut);
      for (const c of p.canaries.filter((x) => x.tier === 'red')) assert.ok(!contains(out, c.string), `${p.name}: ${c.location} (${c.string}) survives red only`);
      const back = await core.inspect(out);
      assert.deepEqual(reds(back), [], `${p.name}: red details left: ${reds(back).join(', ')}`);
      for (const c of p.canaries.filter((x) => x.tier === 'amber')) {
        assert.ok(contains(out, c.string), `${p.name}: ${c.string} is kept by red only`);
        assert.ok(back.items.some((i) => i.tier === 'amber' && i.value.includes(c.string)), `${p.name}: ${c.string} is shown under amber`);
      }
      const all = await core.scrub(p.bytes, info.items.filter((i) => i.tier !== 'green').map((i) => i.id));
      for (const c of p.canaries) assert.ok(!contains(all.bytes, c.string), `${p.name}: ${c.string} survives red and amber`);
      assert.equal(back.normalise, false, `${p.name}: read back, nothing more to normalise`);
      assert.ok(Buffer.from((await core.scrub(out, [])).bytes).equals(Buffer.from(out)), `${p.name}: idempotent`);
      if (ext === 'heic') heicIntact(p.bytes, out, redOut);
      else samePixels(p.name, redOut);
    }
    // A removed layer whose item was not marked hidden is marked hidden, so a reader does not
    // offer its zeroed data as a second picture.
    const h = F.heifInfo([F.path('probe-heic-aux-unhidden.heic'), F.path('probe-heic-aux-unhidden.out-red.heic')]);
    const [hin, hout] = Object.values(h);
    assert.equal(hout.top, 1, 'one top-level picture after the layer goes');
    assert.equal(hout.primary, hin.primary, 'the picture decodes the same');
    const hs = F.heifInfo([F.path('probe-heic-structure.heic'), F.path('probe-heic-structure.out-red.heic')]);
    assert.equal(Object.values(hs)[1].primary, Object.values(hs)[0].primary, 'HEIC with its structure in the fixed form decodes the same');
    assert.equal(Object.values(hs)[1].aux[0].pixels, Object.values(hs)[0].aux[0].pixels, 'and its gain map too');
  });

  test('EXIF: a date or device field with unused inline bytes, or of the wrong form, is red', async () => {
    const base = F.read(F.jpegProgressive());
    const slack = F.jpegInsert(base, F.jpegSeg(0xe1, F.u8('Exif\0\0', F.tiffBlock({ ifd0: [[0x0131, 2, 1, Buffer.from('\0Q9Z', 'latin1')], [0x010f, 2, 0, 'Canon']] }))));
    const info = await core.inspect(slack);
    assert.equal(tierOf(info, 'exif:device-text'), 'red');
    assert.equal(tierOf(info, 'exif:camera'), 'amber');
    const out = await core.scrub(slack, reds(info));
    assert.ok(!contains(out.bytes, 'Q9Z'));
    // Real-world forms stay amber: padded names, blank dates, sub-seconds, time zones.
    const ok = F.jpegInsert(base, F.jpegSeg(0xe1, F.u8('Exif\0\0', F.tiffBlock({
      ifd0: [[0x010f, 2, 0, 'OLYMPUS IMAGING CORP.  '], [0x0110, 2, 32, Buffer.from('E-M5\0'.padEnd(32, '\0'), 'latin1')], [0x0131, 2, 0, 'Version 1.2 (Mac OS X)']],
      exif: [[0x9003, 2, 0, '    :  :     :  :  '], [0x9291, 2, 0, '00'], [0x9011, 2, 0, '+02:00'], [0x882a, 8, 2, Buffer.from([0, 2, 0, 0])], [0xa434, 2, 0, 'M.Zuiko 12-40mm F2.8'], [0xa004, 2, 0, 'SND00001.WAV']],
    }))));
    const i2 = await core.inspect(ok);
    assert.ok(!i2.items.some((i) => i.id === 'exif:device-text'), i2.items.map((i) => `${i.id}=${i.value}`).join(' | '));
    for (const id of ['exif:camera', 'exif:software', 'exif:datetime', 'exif:timezone', 'exif:lens', 'exif:other']) assert.equal(tierOf(i2, id), 'amber', id);
  });

  test('Apple HDR brightness: kept rounded, and a value out of range takes the gain map to red', async () => {
    const fine = F.appleHdrJpeg('apple-round.jpg', { note: { maker33: [10108, 10000], maker48: [123456, 10000000] } });
    const i1 = await core.inspect(F.read(fine));
    const hdr = i1.items.find((i) => i.id === 'exif:apple-hdr');
    assert.equal(hdr.value.replace(/^Headroom [\d.]+ /, ''), '(maker note values 1.011 and 0.0123)');
    const o1 = await core.scrub(F.read(fine), reds(i1));
    const rows = F.exifRead(F.write('apple-round.out-red.jpg', o1.bytes));
    const val = (tag) => rows.find((r) => r.tag === tag)?.value;
    assert.equal(String(val('HDRHeadroom')), '1.011');
    assert.equal(String(val('HDRGain')), '0.0123');
    for (const [name, build] of [['apple-digits.jpg', () => F.appleHdrJpeg('apple-digits.jpg', { note: { maker33: [47999999, 1000000], maker48: [12345678, 1000000] } })],
      ['apple-digits.heic', () => F.appleHdrHeic('apple-digits.heic', { note: { maker33: [47999999, 1000000], maker48: [12345678, 1000000] } })],
      ['apple-no33b.jpg', () => F.appleHdrJpeg('apple-no33b.jpg', { note: { maker33: [0, 0] } })]]) {
      build();
      const info = await core.inspect(F.read(name));
      const gm = info.items.find((i) => i.id === 'jpeg:trailing:gain-map' || i.id === 'heic:gain-map');
      assert.ok(!ids(info).includes('exif:apple-hdr'), `${name}: no Apple HDR brightness out of range`);
      assert.equal(gm.tier, 'red', `${name}: a gain map no screen can show in HDR is red`);
      const out = await core.scrub(F.read(name), reds(info));
      const back = await core.inspect(out.bytes);
      assert.ok(!back.items.some((i) => /gain-map/.test(i.id)), `${name}: the gain map goes with red only`);
    }
  });

  test('XMP values read the same to a standard XML reader: carriage returns and line breaks in attributes', async () => {
    const packet = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
      + '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Label="Line1\nLine2\tTab">'
      + '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">A&#xD;B\r\nC</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>';
    const b = F.jpegInsert(F.read(F.jpegProgressive()), F.jpegSeg(0xe1, F.u8(XMP_HEAD, Buffer.from(packet, 'utf8'))));
    F.write('xmp-cr.jpg', b);
    const res = await core.scrub(b, []);
    F.write('xmp-cr.out.jpg', res.bytes);
    const read = (file) => JSON.parse(F.sh('python3', ['-c', `import sys, json, xml.dom.minidom as md
b = open(sys.argv[1], 'rb').read(); i = b.find(b'<x:xmpmeta'); j = b.find(b'</x:xmpmeta>') + 12
d = md.parseString(b[i:j]); out = {}
for el in d.getElementsByTagName('*'):
    for k, v in el.attributes.items():
        if not k.startswith('xmlns'): out[el.tagName + '@' + k] = v
    t = ''.join(c.data for c in el.childNodes if c.nodeType == 3)
    if t.strip(): out[el.tagName] = t
print(json.dumps(out))`, F.path(file)]));
    const before = read('xmp-cr.jpg');
    const after = read('xmp-cr.out.jpg');
    assert.equal(before['rdf:li'], 'A\rB\nC');
    assert.deepEqual(after, before);
  });

  test('Extended XMP already in the standard form changes nothing', async () => {
    const b = F.read(F.jpegExtended());
    const info = await core.inspect(b);
    const keep = info.items.filter((i) => i.id === 'xmp:extended');
    assert.equal(keep.length, 1);
    const once = await core.scrub(b, reds(info).filter((id) => id !== 'xmp:extended'));
    const back = await core.inspect(once.bytes);
    assert.equal(back.normalise, false, 'read back, nothing more to normalise');
    assert.ok(Buffer.from((await core.scrub(once.bytes, [])).bytes).equals(Buffer.from(once.bytes)), 'idempotent');
  });

  test('IPTC that stays is written in the standard form, with its digest computed again', async () => {
    const ds = (r, d, v) => F.u8([0x1c, r, d], [v.length >> 8, v.length & 255], v);
    const iptc = F.u8(ds(2, 0, [0, 2]), ds(2, 60, '101500'), ds(2, 55, '20240101'), ds(2, 65, 'FakeEdit'));
    const res = (id, data) => F.u8('8BIM', [id >> 8, id & 255], [0, 0], [0, 0, data.length >> 8, data.length & 255], data, data.length & 1 ? [0] : []);
    const b = F.jpegInsert(F.read(F.jpegProgressive()), F.jpegSeg(0xed, F.u8('Photoshop 3.0\0', res(0x0404, iptc), res(0x0425, Buffer.alloc(16, 7)))));
    const info = await core.inspect(b);
    assert.equal(info.normalise, true);
    const out = Buffer.from((await core.scrub(b, [])).bytes);
    const at = out.indexOf(Buffer.from('8BIM\x04\x04', 'latin1'));
    const len = out.readUInt32BE(at + 8);
    const data = out.subarray(at + 12, at + 12 + len);
    assert.deepEqual([...data.subarray(0, 5)], [0x1c, 2, 0, 0, 2], 'record version first, as written: version 4');
    assert.equal(data.subarray(3, 7).readUInt16BE(2), 4);
    assert.ok(data.indexOf(Buffer.from('20240101')) < data.indexOf(Buffer.from('101500')), 'datasets in number order');
    const d = out.indexOf(Buffer.from('8BIM\x04\x25', 'latin1'));
    assert.ok(Buffer.from(md5(data)).equals(out.subarray(d + 12, d + 28)), 'the digest is that of the new IPTC data');
    const back = await core.inspect(out);
    assert.equal(back.normalise, false);
    assert.equal(tierOf(back, 'iptc:dates'), 'amber');
  });

  test('HEIC: an MPEG layer name followed by its HEVC description stays, as Apple writes a depth map', async () => {
    const tail = Buffer.from('000000110000000d4e01b109351e7d840103dbb020', 'hex');
    F.appleHdrHeic('depth-tail.heic', { auxType: 'urn:mpeg:hevc:2015:auxid:2', auxTail: tail });
    const info = await core.inspect(F.read('depth-tail.heic'));
    assert.ok(!ids(info).includes('heic:aux-image'), ids(info).join(' '));
    F.appleHdrHeic('depth-tail-bad.heic', { auxType: 'urn:mpeg:hevc:2015:auxid:2', auxTail: Buffer.concat([tail.subarray(0, 3), Buffer.from([0x12]), tail.subarray(4), Buffer.from('x')]) });
    assert.equal(tierOf(await core.inspect(F.read('depth-tail-bad.heic')), 'heic:aux-image'), 'red', 'a byte more than the description is red');
  });
});
