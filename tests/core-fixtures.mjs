// Synthetic test pictures for the engine tests. Nothing here is a real photo: pictures are
// generated noise from ImageMagick, and every name, serial number and place is invented
// (the GPS position is a public landmark). Files are written to a scratch folder and never
// committed. Set MS_FIXTURE_DIR to choose the folder.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

export const FIX = process.env.MS_FIXTURE_DIR || join(tmpdir(), 'metadatascrubber-core-fixtures');
mkdirSync(FIX, { recursive: true });

export const path = (name) => join(FIX, name);
export const read = (name) => new Uint8Array(readFileSync(path(name)));
export const write = (name, bytes) => { writeFileSync(path(name), bytes); return path(name); };

export function sh(cmd, args, binary = false) {
  return execFileSync(cmd, args, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Planted values. Red ones must vanish with the default selection; amber ones must stay.
export const PLANT = {
  artist: 'Ingrid Testperson',
  owner: 'Olav Ownerson',
  serial: 'SN-PLANT-0001',
  lensSerial: 'LSN-PLANT-0002',
  uniqueId: 'f00dfacecafebabe00112233deadbeef',
  xmpCreator: 'Xmp Plantcreator',
  xmpCity: 'Plantville',
  xmpDocId: 'xmp.did:PLANTDOC123',
  xmpAuxSerial: 'AUXSN-PLANT-3',
  iptcByline: 'Iptc Plantbyline',
  iptcCity: 'Iptcplantcity',
  iptcContact: 'plantcontact@example.invalid',
  unknownApp: 'ACME-SECRET-PLANT',
  trailing: 'TRAILING-PLANT-SECRET',
  // the computer name is red since 2026-10-02: it often names the owner
  computer: 'ingrid-laptop',
  // hidden in or around an HDR gain map that is kept (red: they are not part of it)
  hdr: 'HDR-HIDDEN-PLANT',
  hdr2: 'HDR-SECOND-PLANT',
  // hidden inside a kept HDR gain map in a technical field or its own colour profile. Free
  // text in a technical field or in a colour profile is red since 0.0.3 (the name of the
  // plant is kept so older reports still match)
  hdrAmber: 'HDR-AMBER-PLANT',
  // free text in a green detail: a colour profile's text or a technical XMP field (red)
  green: 'GREEN-TEXT-PLANT',
  // inside Apple's MakerNote next to the HDR numbers (red, like the whole MakerNote)
  appleNote: 'APPLE-NOTE-PLANT',
  // amber values that the default selection keeps
  make: 'Fakecam',
  model: 'Fakecam X100',
  software: 'FakeEdit 2.1',
  copyright: 'Copyright Ingrid T',
  description: 'Planted description QWX',
  comment: 'Planted JPEG comment QWZ',
};

const GPS_ARGS = ['-GPSLatitude=48.8584', '-GPSLatitudeRef=N', '-GPSLongitude=2.2945', '-GPSLongitudeRef=E',
  '-GPSAltitude=35', '-GPSAltitudeRef=0', '-GPSAreaInformation=GPS-AREA-PLANT'];

export function exiftoolWrite(file, args) {
  sh('exiftool', ['-q', '-q', '-overwrite_original', '-m', ...args, file]);
}

// ======================================================================================
// Byte builders

export const u8 = (...parts) => {
  const bufs = parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p)));
  return new Uint8Array(Buffer.concat(bufs));
};
const be16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const be32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const le32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const be64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b; };

export function jpegSeg(marker, payload) {
  const p = Buffer.from(payload);
  return u8([0xff, marker], be16(p.length + 2), p);
}

// Inserts segments after the leading APPn/COM segments of a JPEG.
export function jpegInsert(jpeg, ...segs) {
  const b = Buffer.from(jpeg);
  let p = 2;
  while (b[p] === 0xff && ((b[p + 1] >= 0xe0 && b[p + 1] <= 0xef) || b[p + 1] === 0xfe)) p += 2 + b.readUInt16BE(p + 2);
  return u8(b.subarray(0, p), ...segs, b.subarray(p));
}

export function pngChunk(type, data) {
  const d = Buffer.from(data);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), d]);
  return u8(be32(d.length), body, be32(zlib.crc32(body)));
}

// Inserts chunks before the first chunk of the given type.
export function pngInsertBefore(png, type, ...chunks) {
  const b = Buffer.from(png);
  let p = 8;
  while (p < b.length) {
    const n = b.readUInt32BE(p);
    if (b.toString('latin1', p + 4, p + 8) === type) break;
    p += 12 + n;
  }
  return u8(b.subarray(0, p), ...chunks, b.subarray(p));
}

export function webpChunk(type, data) {
  const d = Buffer.from(data);
  return u8(type, le32(d.length), d, d.length & 1 ? [0] : []);
}

export function webpRebuild(chunks) {
  const body = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return u8('RIFF', le32(body.length + 4), 'WEBP', body);
}

export function webpChunks(webp) {
  const b = Buffer.from(webp);
  const out = [];
  let p = 12;
  while (p + 8 <= b.length) {
    const n = b.readUInt32LE(p + 4);
    out.push({ type: b.toString('latin1', p, p + 4), data: b.subarray(p + 8, p + 8 + n), raw: b.subarray(p, p + 8 + n + (n & 1)) });
    p += 8 + n + (n & 1);
  }
  return out;
}

// Small hand-written TIFF writer, independent of the engine.
// dirs: { ifd0: [[tag, type, count, Buffer|number[]]], exif: [...], gps: [...], ifd1: [...] }
export function tiffBlock({ le = false, ifd0 = [], exif = [], gps = [], makernote = null, shared = null, thumbnail = null }) {
  const w16 = (v) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(v) : b.writeUInt16BE(v); return b; };
  const w32 = (v) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(v >>> 0) : b.writeUInt32BE(v >>> 0); return b; };
  const buf = [];
  let size = 8;
  const put = (b) => { const at = size; buf.push(b); size += b.length; if (b.length & 1) { buf.push(Buffer.alloc(1)); size++; } return at; };
  const header = Buffer.concat([Buffer.from(le ? 'II' : 'MM', 'latin1'), w16(42), w32(8)]);
  const dirs = { ifd0: [...ifd0], exif: [...exif], gps: [...gps] };
  if (exif.length || makernote) dirs.ifd0.push([0x8769, 4, 1, 'PTR:exif']);
  if (gps.length) dirs.ifd0.push([0x8825, 4, 1, 'PTR:gps']);
  const order = ['ifd0', 'exif', 'gps'].filter((d) => dirs[d].length);
  for (const d of order) dirs[d].sort((a, b) => a[0] - b[0]);
  // Reserve directory space first, so offsets are known.
  const at = {};
  let cursor = 8;
  for (const d of order) { at[d] = cursor; cursor += 2 + dirs[d].length * 12 + 4; }
  if (thumbnail) { at.ifd1 = cursor; cursor += 2 + 2 * 12 + 4; }
  size = cursor;
  const dirBytes = {};
  const sharedAt = {};
  // Returns [count, 4-byte value field].
  const valueOf = (e) => {
    const [tag, type, count, val] = e;
    if (typeof val === 'string' && val.startsWith('PTR:')) return [1, w32(at[val.slice(4)])];
    if (typeof val === 'string' && val.startsWith('SHARED:')) {
      const key = val.slice(7);
      if (sharedAt[key] === undefined) sharedAt[key] = put(Buffer.from(shared[key], 'latin1'));
      return [count, w32(sharedAt[key])];
    }
    if (tag === 0x927c && makernote) {
      const mn = makernote(size, le);
      return [mn.length, w32(put(mn))];
    }
    let data;
    if (Buffer.isBuffer(val)) data = val;
    else if (typeof val === 'string') data = Buffer.from(val + '\0', 'latin1');
    else if (type === 3) data = Buffer.concat(val.map((v) => w16(v)));
    else if (type === 4) data = Buffer.concat(val.map((v) => w32(v)));
    else if (type === 5) data = Buffer.concat(val.map((v) => w32(v)));
    else data = Buffer.from(val);
    const unit = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 }[type];
    const n = count || data.length / unit;
    if (data.length <= 4) return [n, Buffer.concat([data, Buffer.alloc(4 - data.length)])];
    return [n, w32(put(data))];
  };
  for (const d of order) {
    const list = dirs[d];
    const parts = [w16(list.length)];
    for (const e of list) {
      const [tag, type] = e;
      const [cnt, field] = valueOf(e);
      parts.push(w16(tag), w16(type), w32(cnt), field);
    }
    parts.push(w32(d === 'ifd0' && thumbnail ? at.ifd1 : 0));
    dirBytes[d] = Buffer.concat(parts);
  }
  if (thumbnail) {
    const tAt = put(Buffer.from(thumbnail));
    dirBytes.ifd1 = Buffer.concat([w16(2), w16(0x0201), w16(4), w32(1), w32(tAt), w16(0x0202), w16(4), w32(1), w32(thumbnail.length), w32(0)]);
  }
  const out = Buffer.alloc(size);
  header.copy(out, 0);
  for (const d of [...order, ...(thumbnail ? ['ifd1'] : [])]) dirBytes[d].copy(out, at[d]);
  let p = cursor;
  for (const b of buf) { b.copy(out, p); p += b.length; }
  return new Uint8Array(out);
}

// A Canon-style maker note: an IFD whose value offsets count from the TIFF header, which is
// exactly why kept maker notes must never move.
export function canonMakernote(at, le) {
  const w16 = (v) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(v) : b.writeUInt16BE(v); return b; };
  const w32 = (v) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(v >>> 0) : b.writeUInt32BE(v >>> 0); return b; };
  const imageType = Buffer.from('Fake Canon Image Type\0', 'latin1');
  const owner = Buffer.alloc(32);
  owner.write('MAKERNOTE-OWNER-PLANT', 'latin1');
  const dirLen = 2 + 3 * 12 + 4;
  const typeAt = at + dirLen;
  const ownerAt = typeAt + imageType.length + (imageType.length & 1);
  const dir = Buffer.concat([
    w16(3),
    w16(0x0006), w16(2), w32(imageType.length), w32(typeAt),
    w16(0x0009), w16(2), w32(32), w32(ownerAt),
    w16(0x000c), w16(4), w32(1), w32(4242),
    w32(0),
  ]);
  return Buffer.concat([dir, imageType, imageType.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0), owner]);
}

// Synthetic MP4: just enough boxes for a reader to recognise a video.
export function fakeMp4(secret = 'VIDEO-PLANT-SECRET', size = 3000) {
  const ftyp = u8(be32(24), 'ftypmp42', be32(0), 'isommp42');
  const free = u8(be32(8 + secret.length), 'free', secret);
  const mdat = u8(be32(8 + size), 'mdat', randomBytes(size));
  return u8(ftyp, free, mdat);
}

// Synthetic JUMBF box labelled c2pa, as carried by Content Credentials.
export function fakeJumbf(secret = 'FakeCam C2PA PLANT') {
  const json = Buffer.from(`{"claim_generator":"${secret}"}`, 'latin1');
  const jsonBox = u8(be32(8 + json.length), 'json', json);
  const uuid = Buffer.from('6332706100110010800000aa00389b71', 'hex');
  const label = Buffer.from('c2pa\0', 'latin1');
  const jumd = u8(be32(8 + 16 + 1 + label.length), 'jumd', uuid, [3], label);
  return u8(be32(8 + jumd.length + jsonBox.length), 'jumb', jumd, jsonBox);
}

export function magick(args) {
  sh('magick', args);
}

// ======================================================================================
// Fixture recipes (memoised; each writes into FIX and returns the file name)

const done = new Map();
const once = (name, fn) => () => {
  if (!done.has(name)) done.set(name, fn());
  return done.get(name);
};

export const icc = '/usr/share/color/icc/colord/AdobeRGB1998.icc';

export const jpegFull = once('full.jpg', () => {
  const f = path('full-base.jpg');
  magick(['-size', '320x240', 'plasma:fractal', '-seed', '11', '-depth', '8', '-quality', '90', f]);
  magick(['-size', '160x120', 'plasma:fractal', '-seed', '12', '-depth', '8', '-quality', '70', path('thumb.jpg')]);
  exiftoolWrite(f, [...GPS_ARGS,
    `-EXIF:Make=${PLANT.make}`, `-EXIF:Model=${PLANT.model}`, `-EXIF:Artist=${PLANT.artist}`, `-EXIF:OwnerName=${PLANT.owner}`,
    `-EXIF:SerialNumber=${PLANT.serial}`, `-EXIF:LensSerialNumber=${PLANT.lensSerial}`, `-EXIF:ImageUniqueID=${PLANT.uniqueId}`,
    '-EXIF:LensMake=FakeLens', '-EXIF:LensModel=FakeLens 24-70', `-EXIF:Copyright=${PLANT.copyright}`,
    '-EXIF:DateTimeOriginal=2026:09:14 10:15:23', '-EXIF:CreateDate=2026:09:14 10:15:23', '-EXIF:ModifyDate=2026:09:15 08:00:00',
    '-EXIF:SubSecTimeOriginal=123', '-EXIF:OffsetTimeOriginal=+02:00', `-EXIF:Software=${PLANT.software}`,
    `-EXIF:HostComputer=${PLANT.computer}`, `-EXIF:ImageDescription=${PLANT.description}`, '-EXIF:UserComment=Planted user comment QWY',
    '-EXIF:Orientation#=6', '-EXIF:ExposureTime=0.008', '-EXIF:FNumber=1.9', '-EXIF:ISO=100', '-EXIF:FocalLength=6.8',
    '-EXIF:XResolution=72', '-EXIF:YResolution=72', '-EXIF:ResolutionUnit=inches', `-ThumbnailImage<=${path('thumb.jpg')}`,
    `-XMP-dc:Creator=${PLANT.xmpCreator}`, `-XMP-photoshop:City=${PLANT.xmpCity}`, '-XMP-iptcCore:Location=Plant Square',
    `-XMP-xmpMM:DocumentID=${PLANT.xmpDocId}`, '-XMP-xmpMM:InstanceID=xmp.iid:PLANTINST456',
    '-XMP-xmpMM:HistoryAction=saved', '-XMP-xmpMM:HistoryWhen=2026:09:15 08:00:00', '-XMP-xmpMM:HistorySoftwareAgent=FakeEdit 2.1',
    '-XMP-xmp:CreatorTool=FakeEdit 2.1', '-XMP-xmp:CreateDate=2026:09:14 10:15:23', `-XMP-aux:SerialNumber=${PLANT.xmpAuxSerial}`,
    '-XMP-exif:GPSLatitude=48.8584', '-XMP-exif:GPSLongitude=2.2945', '-XMP-dc:Description=Xmp planted description',
    '-XMP-dc:Title=Xmp planted title', '-XMP-dc:Rights=Xmp rights holder', '-XMP-xmpRights:Owner=Xmp Rightsowner',
    '-XMP-photoshop:AuthorsPosition=Chief Planter', '-XMP-iptcCore:CreatorWorkEmail=xmpcontact@example.invalid',
    '-XMP-tiff:Make=Fakecam', '-XMP-xmp:Rating=3',
    `-IPTC:By-line=${PLANT.iptcByline}`, '-IPTC:Credit=Iptc credit line', '-IPTC:CopyrightNotice=Iptc copyright notice',
    `-IPTC:City=${PLANT.iptcCity}`, '-IPTC:Sub-location=Iptc sublocation', '-IPTC:Province-State=Iptc province',
    '-IPTC:Country-PrimaryLocationName=Iptc country', '-IPTC:Caption-Abstract=Iptc caption text', '-IPTC:Keywords=plantkeyword',
    '-IPTC:DateCreated=20260914', '-IPTC:TimeCreated=10:15:23+02:00', '-IPTC:SpecialInstructions=Iptc instructions',
    `-IPTC:Contact=${PLANT.iptcContact}`,
    `-ICC_Profile<=${icc}`, `-Comment=${PLANT.comment}`, `-PhotoshopThumbnail<=${path('thumb.jpg')}`]);
  let b = read('full-base.jpg');
  const app9 = jpegSeg(0xe9, u8('ACMECAM\0', PLANT.unknownApp));
  const c2pa = jpegSeg(0xeb, u8('JP', [0, 1], be32(1), fakeJumbf()));
  const adobe = jpegSeg(0xee, u8('Adobe', [0, 100, 0, 0, 0, 0, 1]));
  // A comment holding FF D9 bytes: segment lengths, not marker scanning, must decide.
  const tricky = jpegSeg(0xfe, u8('odd bytes ', [0xff, 0xd9, 0xff, 0xd8], ' end'));
  b = jpegInsert(b, app9, c2pa, adobe, tricky);
  b = u8(b, PLANT.trailing, [0xff, 0xd9, 0, 1, 2]);
  write('full.jpg', b);
  return 'full.jpg';
});

export const jpegProgressive = once('progressive.jpg', () => {
  const f = path('progressive.jpg');
  magick(['-size', '256x192', 'plasma:fractal', '-seed', '21', '-depth', '8', '-interlace', 'Plane', '-quality', '85', f]);
  exiftoolWrite(f, ['-ExifByteOrder=Little-endian', ...GPS_ARGS, `-EXIF:Artist=${PLANT.artist}`, `-EXIF:Make=${PLANT.make}`,
    `-EXIF:SerialNumber=${PLANT.serial}`, '-EXIF:DateTimeOriginal=2026:09:14 10:15:23']);
  write('progressive.jpg', u8(read('progressive.jpg'), PLANT.trailing));
  return 'progressive.jpg';
});

export const jpegRestart = once('restart.jpg', () => {
  const f = path('restart.jpg');
  magick(['-size', '200x150', 'plasma:fractal', '-seed', '31', '-depth', '8', path('restart-src.png')]);
  sh('python3', ['-c', `from PIL import Image\nImage.open(${JSON.stringify(path('restart-src.png'))}).convert('RGB').save(${JSON.stringify(f)}, quality=88, restart_marker_blocks=3)`]);
  exiftoolWrite(f, [...GPS_ARGS, `-EXIF:Artist=${PLANT.artist}`, `-XMP-dc:Creator=${PLANT.xmpCreator}`]);
  return 'restart.jpg';
});

// Canon-style maker note, values shared between tags, and a built-in preview: all in a
// hand-built little-endian EXIF block.
export const jpegMakernote = once('makernote.jpg', () => {
  const f = path('makernote-base.jpg');
  magick(['-size', '160x120', 'plasma:fractal', '-seed', '41', '-depth', '8', '-quality', '90', f]);
  const thumb = readFileSync(path('thumb.jpg'));
  const tiff = tiffBlock({
    le: true,
    ifd0: [[0x010f, 2, 0, 'Canon'], [0x0110, 2, 0, 'Canon FakeShot 1'], [0x0112, 3, 1, [1]],
      [0x013b, 2, 22, 'SHARED:name'], [0x010e, 2, 22, 'SHARED:name']],
    exif: [[0x927c, 7, 0, null], [0x9003, 2, 0, '2026:09:14 10:15:23'], [0xa431, 2, 0, PLANT.serial]],
    gps: [[0x0001, 2, 2, 'N'], [0x0002, 5, 3, [48, 1, 51, 1, 3024, 100]], [0x0003, 2, 2, 'E'], [0x0004, 5, 3, [2, 1, 17, 1, 4020, 100]],
      [0x001c, 7, 14, Buffer.from('GPS-AREA-PLANT', 'latin1')]],
    makernote: canonMakernote,
    shared: { name: 'Shared Name Plant 22\0\0' },
    thumbnail: thumb,
  });
  const t = Buffer.from(tiff);
  write('makernote.tiff', t);
  write('makernote.jpg', jpegInsert(read('makernote-base.jpg'), jpegSeg(0xe1, u8('Exif\0\0', t))));
  return 'makernote.jpg';
});

const XMP_WRAP = (body, ns = '') => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="FakeXMP Core 1.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" ${ns}>
${body}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

// Pixel-style Motion Photo with an Ultra HDR gain map: primary JPEG, MPF index, gain map
// JPEG, then an MP4 clip.
export const jpegMotion = once('motion.jpg', () => {
  magick(['-size', '320x240', 'plasma:fractal', '-seed', '51', '-depth', '8', '-quality', '90', path('motion-primary.jpg')]);
  magick(['-size', '80x60', 'gradient:gray20-gray90', '-depth', '8', '-quality', '80', path('motion-gain.jpg')]);
  const gainXmp = XMP_WRAP('', 'xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" hdrgm:GainMapMax="2.3" hdrgm:Gamma="1"');
  const iso = jpegSeg(0xe2, u8('urn:iso:std:iso:ts:21496:-1\0', [0, 0, 0, 0]));
  const gain = jpegInsert(read('motion-gain.jpg'), jpegSeg(0xe1, u8('http://ns.adobe.com/xap/1.0/\0', Buffer.from(gainXmp, 'utf8'))), iso);
  const video = fakeMp4();
  const primaryXmp = (gl, vl) => XMP_WRAP(`   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>
     <rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${String(gl).padStart(8, '0')}"/></rdf:li>
     <rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="MotionPhoto" Item:Mime="video/mp4" Item:Length="${String(vl).padStart(8, '0')}"/></rdf:li>
    </rdf:Seq>
   </Container:Directory>`, `xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" GCamera:MotionPhoto="1" GCamera:MotionPhotoVersion="1" GCamera:MotionPhotoPresentationTimestampUs="1500000" hdrgm:Version="1.0" xmp:CreateDate="2026-09-14T10:15:23" dc:format="image/jpeg"`);
  const mpf = (primarySize, gainOffset, gainSize) => u8('MPF\0', 'MM', [0, 42], be32(8), be16(3),
    be16(0xb000), be16(7), be32(4), '0100',
    be16(0xb001), be16(4), be32(1), be32(2),
    be16(0xb002), be16(7), be32(32), be32(50),
    be32(0),
    be32(0x20030000), be32(primarySize), be32(0), be16(0), be16(0),
    be32(0), be32(gainSize), be32(gainOffset), be16(0), be16(0));
  const build = (mp) => jpegInsert(read('motion-primary.jpg'),
    jpegSeg(0xe1, u8('http://ns.adobe.com/xap/1.0/\0', Buffer.from(primaryXmp(gain.length, video.length), 'utf8'))),
    jpegSeg(0xe2, mp), iso);
  let primary = build(mpf(0, 0, 0));
  const mpfPos = Buffer.from(primary).indexOf(Buffer.from('MPF\0', 'latin1'));
  const base = mpfPos + 4;
  primary = build(mpf(primary.length, primary.length - base, gain.length));
  write('motion.jpg', u8(primary, gain, video));
  write('motion-gain-only.jpg', gain);
  return 'motion.jpg';
});

// ======================================================================================
// Ultra HDR pictures for the gain map tests

// A TIFF directory at `off` (from the TIFF header) with out-of-line values right after it.
// tags: [[tag, type, count, Buffer]].
function tiffIfd(le, tags, off, next) {
  const w16 = (v) => { const b = Buffer.alloc(2); if (le) b.writeUInt16LE(v); else b.writeUInt16BE(v); return b; };
  const w32 = (v) => { const b = Buffer.alloc(4); if (le) b.writeUInt32LE(v >>> 0); else b.writeUInt32BE(v >>> 0); return b; };
  const head = [w16(tags.length)];
  const values = [];
  let at = off + 2 + 12 * tags.length + 4;
  for (const [tag, type, count, data] of tags) {
    let field;
    if (data.length <= 4) field = Buffer.concat([data, Buffer.alloc(4 - data.length)]);
    else { field = w32(at); values.push(data); at += data.length; if (data.length & 1) { values.push(Buffer.alloc(1)); at++; } }
    head.push(w16(tag), w16(type), w32(count), field);
  }
  head.push(w32(next));
  return Buffer.concat([...head, ...values]);
}

// 'MPF\0' and an MP header, MP Index IFD (B000, B001, B002, optional B003 and B004), the MP
// entry table, an optional MP Attribute IFD, then `tail`. entries: [attribute, size, offset].
export function mpfPayload({ le = false, entries, ids = null, b004 = null, attr = null, tail = null }) {
  const w16 = (v) => { const b = Buffer.alloc(2); if (le) b.writeUInt16LE(v); else b.writeUInt16BE(v); return b; };
  const w32 = (v) => { const b = Buffer.alloc(4); if (le) b.writeUInt32LE(v >>> 0); else b.writeUInt32BE(v >>> 0); return b; };
  const table = Buffer.concat(entries.map(([a, size, off, d1 = 0, d2 = 0]) => Buffer.concat([w32(a), w32(size), w32(off), w16(d1), w16(d2)])));
  const tags = [[0xb000, 7, 4, Buffer.from('0100')], [0xb001, 4, 1, w32(entries.length)], [0xb002, 7, table.length, table]];
  if (ids) tags.push([0xb003, 7, ids.length, Buffer.from(ids)]);
  if (b004 !== null) tags.push([0xb004, 4, 1, w32(b004)]);
  const indexLen = tiffIfd(le, tags, 8, 0).length;
  const attrAt = attr ? 8 + indexLen : 0;
  const body = [tiffIfd(le, tags, 8, attrAt)];
  if (attr) body.push(tiffIfd(le, attr, attrAt, 0));
  return u8('MPF\0', le ? 'II' : 'MM', w16(42), w32(8), ...body, tail ? Buffer.from(tail) : []);
}

export const ISO_ID = 'urn:iso:std:iso:ts:21496:-1\0';
// An ISO 21496-1 block after the identifier: version-only, or full with one or three
// channels, with or without a common denominator.
export function isoBlock({ full = true, channels = 1, common = false, flags = null, minVersion = 0 } = {}) {
  const head = u8(be16(minVersion), be16(0));
  if (!full) return head;
  const f = flags !== null ? flags : (channels === 3 ? 0x80 : 0) | (common ? 0x08 : 0);
  const parts = [head, [f]];
  if (common) {
    parts.push(be32(64), be32(0), be32(147));
    for (let c = 0; c < channels; c++) parts.push(be32(0), be32(147), be32(64), be32(1), be32(1));
  } else {
    parts.push(be32(0), be32(1), be32(23), be32(10));
    for (let c = 0; c < channels; c++) parts.push(be32(0), be32(1), be32(23), be32(10), be32(1), be32(1), be32(1), be32(64), be32(1), be32(64));
  }
  return u8(...parts);
}

const GAIN_FIELDS = 'hdrgm:Version="1.0" hdrgm:GainMapMin="0" hdrgm:GainMapMax="2.3" hdrgm:Gamma="1" hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="2.3" hdrgm:BaseRenditionIsHDR="False"';
const HDRGM_NS = 'xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"';

// An Ultra HDR style picture built byte by byte: the photo with XMP (hdrgm:Version and a
// Container directory) and an MPF index, then the gain map with its own hdrgm description.
// Writes <name> and <name>.gain.jpg (the gain map on its own) and returns the name.
// Options add what a test needs:
//   photoAttrs, photoNs     more attributes and namespaces on the photo's rdf:Description
//   version                 the photo's hdrgm:Version value
//   itemAttrs, itemBody     more attributes on, or elements in, the GainMap Container:Item
//   gainMime                the GainMap entry's Item:Mime (image/jpeg by default)
//   extraLi                 more rdf:li entries at the end of the directory's rdf:Seq
//   dirExtra                more content inside Container:Directory
//   noVersion               the photo has no hdrgm:Version (an ISO 21496-1 only picture)
//   photoSegs               more segments in the photo (for example a colour profile)
//   gainFields, gainAttrs   the gain map's hdrgm attributes, and more attributes
//   gainBody, gainToolkit   elements in the gain map's rdf:Description, and an x:xmptk
//   noGainXmp               the gain map has no XMP at all
//   photoIso, gainIso       arrays of payloads (after the ISO identifier) of ISO segments
//   gainSegs                more segments inside the gain map
//   mpf                     { le, ids, b004, attr, tail, type, offset } for the MPF index
//   exif                    an EXIF block in the photo with the planted artist name
//   lead, after             zero bytes before the gain map; bytes after its end marker,
//                           inside its MPF size
//   padding                 [primary, gain map] Item:Padding values
//   gain                    { size: 'WxH', colour, base } for the gain map picture
//   photoXmp                false: the photo has no XMP at all (an iPhone JPEG)
//   exifTiff                a TIFF block for an EXIF segment in the photo (instead of exif)
//   gainXmp                 the gain map's whole rdf:Description content: { ns, attrs, body }
//                           (instead of the hdrgm description)
//   companion               false: do not write <name>.gain.jpg. On its own a gain map is
//                           an ordinary photo, and the audit would judge what is planted in
//                           it by the photo's rules (a technical XMP field or a colour profile
//                           is green there), which is not what such a test is about
export function gainMapJpeg(name, opts = {}) {
  if (!existsSync(path('hdr-photo.jpg'))) {
    magick(['-size', '320x240', 'plasma:fractal', '-seed', '71', '-depth', '8', '-strip', '-quality', '90', path('hdr-photo.jpg')]);
    magick(['-size', '80x60', 'gradient:gray20-gray90', '-depth', '8', '-strip', '-quality', '80', path('hdr-gain.jpg')]);
  }
  const g = opts.gain || {};
  let gainBase;
  if (g.base) gainBase = g.base;
  else if (g.size || g.colour) {
    const file = path(`hdr-gain-${g.size || '80x60'}-${g.colour ? 'c' : 'g'}.jpg`);
    magick(['-size', g.size || '80x60', g.colour ? 'plasma:fractal' : 'gradient:gray20-gray90', '-seed', '72', '-depth', '8', '-strip', '-quality', '80', ...(g.colour ? [] : ['-colorspace', 'Gray']), file]);
    gainBase = new Uint8Array(readFileSync(file));
  } else gainBase = read('hdr-gain.jpg');
  const fields = opts.gainFields ?? GAIN_FIELDS;
  const gx = opts.gainXmp;
  const gainXmp = (gx ? XMP_WRAP(gx.body || '', `${gx.ns} ${gx.attrs || ''}`) : XMP_WRAP(opts.gainBody || '', `${HDRGM_NS} ${fields}${opts.gainAttrs ? ` ${opts.gainAttrs}` : ''}`))
    .replace(' x:xmptk="FakeXMP Core 1.0"', opts.gainToolkit ? ` x:xmptk="${opts.gainToolkit}"` : '');
  const gainSegs = [];
  if (!opts.noGainXmp) gainSegs.push(jpegSeg(0xe1, u8('http://ns.adobe.com/xap/1.0/\0', Buffer.from(gainXmp, 'utf8'))));
  for (const p of opts.gainIso || []) gainSegs.push(jpegSeg(0xe2, u8(ISO_ID, p)));
  gainSegs.push(...(opts.gainSegs || []));
  const gain = gainSegs.length ? jpegInsert(gainBase, ...gainSegs) : gainBase;
  const after = opts.after ? Buffer.from(opts.after) : Buffer.alloc(0);
  const lead = Buffer.alloc(opts.lead || 0);
  const gainLen = gain.length + after.length;
  const [padP, padG] = opts.padding || [];
  const pad = (v) => (v === undefined ? '' : ` Item:Padding="${v}"`);
  const photoXmp = XMP_WRAP(`   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"${pad(padP)}/></rdf:li>
     <rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="${opts.gainMime ?? 'image/jpeg'}" Item:Length="${gainLen}"${pad(padG)}${opts.itemAttrs ? ` ${opts.itemAttrs}` : ''}${opts.itemBody ? ` rdf:parseType="Resource">${opts.itemBody}</Container:Item>` : '/>'}</rdf:li>${opts.extraLi || ''}
    </rdf:Seq>${opts.dirExtra || ''}
   </Container:Directory>`, `${HDRGM_NS} xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/"${opts.photoNs ? ` ${opts.photoNs}` : ''}${opts.noVersion ? '' : ` hdrgm:Version="${opts.version ?? '1.0'}"`}${opts.photoAttrs ? ` ${opts.photoAttrs}` : ''}`)
    .replace(' x:xmptk="FakeXMP Core 1.0"', '');
  const m = opts.mpf || {};
  const head = opts.photoXmp === false ? [] : [jpegSeg(0xe1, u8('http://ns.adobe.com/xap/1.0/\0', Buffer.from(photoXmp, 'utf8')))];
  if (opts.exifTiff) head.push(jpegSeg(0xe1, u8('Exif\0\0', opts.exifTiff)));
  if (opts.exif) head.push(jpegSeg(0xe1, u8('Exif\0\0', tiffBlock({ ifd0: [[0x013b, 2, 0, PLANT.artist]] }))));
  for (const p of opts.photoIso || []) head.push(jpegSeg(0xe2, u8(ISO_ID, p)));
  head.push(...(opts.photoSegs || []));
  const build = (primLen, gainOff) => jpegInsert(read('hdr-photo.jpg'), ...head, jpegSeg(0xe2, mpfPayload({
    le: m.le, ids: m.ids, b004: m.b004 ?? null, attr: m.attr, tail: m.tail,
    entries: [[0x20030000, primLen, 0], [m.type ?? 0, gainLen, m.offset ?? gainOff]],
  })));
  let photo = build(0, 0);
  const base = Buffer.from(photo).indexOf(Buffer.from('MPF\0', 'latin1')) + 4;
  photo = build(photo.length, photo.length + lead.length - base);
  if (opts.companion !== false) write(`${name}.gain.jpg`, gain);
  write(name, u8(photo, lead, gain, after));
  return name;
}

// A small ICC profile (version 2, display class, RGB) with a description and a copyright
// text tag, and optionally more text tags: { desc, cprt, more: [[sig, text]] }.
export function iccProfile({ desc = 'sRGB test', cprt = 'No copyright, use freely', more = [] } = {}) {
  const descTag = (t) => u8('desc', be32(0), be32(t.length + 1), t, [0], be32(0), be32(0), [0, 0, 0], Buffer.alloc(67));
  const textTag = (t) => u8('text', be32(0), t, [0]);
  const xyz = u8('XYZ ', be32(0), be32(0xf6d6), be32(0x10000), be32(0xd32d));
  const tags = [['desc', descTag(desc)], ['cprt', textTag(cprt)], ['wtpt', xyz], ...more.map(([sig, t]) => [sig, textTag(t)])];
  const tableLen = 4 + 12 * tags.length;
  let off = 128 + tableLen;
  const table = [be32(tags.length)];
  const data = [];
  for (const [sig, d] of tags) {
    const padded = u8(d, Buffer.alloc((4 - (d.length % 4)) % 4));
    table.push(Buffer.from(sig, 'latin1'), be32(off), be32(d.length));
    data.push(padded);
    off += padded.length;
  }
  const head = Buffer.alloc(128);
  head.writeUInt32BE(off, 0);
  head.write('none', 4, 'latin1');
  head.writeUInt32BE(0x02100000, 8);
  head.write('mntrRGB XYZ ', 12, 'latin1');
  head.write('acsp', 36, 'latin1');
  head.writeUInt32BE(0xf6d6, 68); head.writeUInt32BE(0x10000, 72); head.writeUInt32BE(0xd32d, 76);
  return u8(head, ...table, ...data);
}
// The JPEG APP2 segment that carries a whole (small) ICC profile.
export const iccSegment = (profile) => jpegSeg(0xe2, u8('ICC_PROFILE\0', [1, 1], profile));

// A version 4 profile with mluc text tags, an XYZ white point and a parametric curve:
// { desc, cprt, dmnd, more: [[sig, text]], records: more language records for desc }.
export function iccProfileV4({ desc = 'Display P3', cprt = 'Copyright Apple Inc., 2017', dmnd = null, more = [], records = [] } = {}) {
  const mluc = (list) => {
    const head = [Buffer.from('mluc', 'latin1'), be32(0), be32(list.length), be32(12)];
    let off = 16 + 12 * list.length;
    const strs = [];
    for (const [lang, t] of list) {
      const s16 = Buffer.from(t, 'utf16le').swap16();
      head.push(Buffer.from(lang, 'latin1'), be32(s16.length), be32(off));
      strs.push(s16);
      off += s16.length;
    }
    return u8(...head, ...strs);
  };
  const xyz = u8('XYZ ', be32(0), be32(0xf6d6), be32(0x10000), be32(0xd32d));
  const para = u8('para', be32(0), [0, 0, 0, 0], be32(0x26666));
  const tags = [['desc', mluc([['enUS', desc], ...records])], ['cprt', mluc([['enUS', cprt]])], ['wtpt', xyz], ['rTRC', para], ['gTRC', para], ['bTRC', para]];
  if (dmnd !== null) tags.push(['dmnd', mluc([['enUS', dmnd]])]);
  for (const [sig, t] of more) tags.push([sig, mluc([['enUS', t]])]);
  const tableLen = 4 + 12 * tags.length;
  let off = 128 + tableLen;
  const table = [be32(tags.length)];
  const data = [];
  const placed = new Map();
  for (const [sig, d] of tags) {
    const key = d.toString('hex');
    if (placed.has(key)) { table.push(Buffer.from(sig, 'latin1'), be32(placed.get(key)), be32(d.length)); continue; }
    const padded = u8(d, Buffer.alloc((4 - (d.length % 4)) % 4));
    table.push(Buffer.from(sig, 'latin1'), be32(off), be32(d.length));
    placed.set(key, off);
    data.push(padded);
    off += padded.length;
  }
  const head = Buffer.alloc(128);
  head.writeUInt32BE(off, 0);
  head.write('appl', 4, 'latin1');
  head.writeUInt32BE(0x04000000, 8);
  head.write('mntrRGB XYZ ', 12, 'latin1');
  head.write('acsp', 36, 'latin1');
  head.writeUInt32BE(0xf6d6, 68); head.writeUInt32BE(0x10000, 72); head.writeUInt32BE(0xd32d, 76);
  return u8(head, ...table, ...data);
}

// A version 4 RGB display profile assembled from raw tags: { tags: [[sig, bytes]], header:
// { offset: bytes } written over the header, size: a declared size other than the real one }.
// Tags with the same bytes share their data, as real profiles do for the three curves.
export const iccMluc = (t, code = 'enUS') => {
  const s16 = Buffer.from(t, 'utf16le').swap16();
  return u8('mluc', be32(0), be32(1), be32(12), code, be32(s16.length), be32(28), s16);
};
export const iccXyz = (...v) => u8('XYZ ', be32(0), ...v.map((x) => be32(Math.round(x * 65536) >>> 0)));
export const ICC_BASE_TAGS = () => [
  ['desc', iccMluc('Display P3')], ['cprt', iccMluc('Copyright Apple Inc., 2017')], ['wtpt', iccXyz(0.9642, 1, 0.8249)],
  ['rXYZ', iccXyz(0.5151, 0.2412, -0.0011)], ['gXYZ', iccXyz(0.292, 0.6922, 0.0419)], ['bXYZ', iccXyz(0.1571, 0.0666, 0.7841)],
  ['rTRC', u8('para', be32(0), [0, 0, 0, 0], be32(0x23333))], ['gTRC', u8('para', be32(0), [0, 0, 0, 0], be32(0x23333))], ['bTRC', u8('para', be32(0), [0, 0, 0, 0], be32(0x23333))],
];
export function iccBuild({ tags = ICC_BASE_TAGS(), header = {}, size = null } = {}) {
  const tableLen = 4 + 12 * tags.length;
  let off = 128 + tableLen;
  const table = [be32(tags.length)];
  const data = [];
  const placed = new Map();
  for (const [sig, d] of tags) {
    const key = Buffer.from(d).toString('hex');
    if (placed.has(key)) { table.push(Buffer.from(sig, 'latin1'), be32(placed.get(key)), be32(d.length)); continue; }
    const padded = u8(d, Buffer.alloc((4 - (d.length % 4)) % 4));
    table.push(Buffer.from(sig, 'latin1'), be32(off), be32(d.length));
    placed.set(key, off);
    data.push(padded);
    off += padded.length;
  }
  const head = Buffer.alloc(128);
  head.writeUInt32BE(size ?? off, 0);
  head.writeUInt32BE(0x04300000, 8);
  head.write('mntrRGB XYZ ', 12, 'latin1');
  head.write('acsp', 36, 'latin1');
  head.writeUInt32BE(0xf6d6, 68); head.writeUInt32BE(0x10000, 72); head.writeUInt32BE(0xd32d, 76);
  for (const [at, v] of Object.entries(header)) Buffer.from(v, 'latin1').copy(head, Number(at));
  return u8(head, ...table, ...data);
}

// Apple's MakerNote ("Apple iOS", version 1, big-endian, offsets from its own start) with
// the two HDR numbers (tags 33 and 48) and a text tag holding `text`.
export function appleMakerNote({ maker33 = [10200, 10000], maker48 = [64, 10000], text = PLANT.appleNote } = {}) {
  const t = Buffer.from(`${text}\0`, 'latin1');
  const entries = [[0x0001, 9, 1, be32(14)], [0x000b, 2, t.length, t], [0x0021, 10, 1, u8(be32(maker33[0]), be32(maker33[1]))]];
  if (maker48) entries.push([0x0030, 10, 1, u8(be32(maker48[0]), be32(maker48[1]))]);
  const head = 14 + 2 + 12 * entries.length + 4;
  const parts = [Buffer.from('Apple iOS\0\0\x01MM', 'latin1'), be16(entries.length)];
  const values = [];
  let at = head;
  for (const [tag, type, count, data] of entries) {
    parts.push(be16(tag), be16(type), be32(count));
    if (data.length <= 4) parts.push(u8(data, Buffer.alloc(4 - data.length)));
    else { parts.push(be32(at)); values.push(data); at += data.length; if (data.length & 1) { values.push(Buffer.alloc(1)); at++; } }
  }
  parts.push(be32(0));
  return u8(...parts, ...values);
}

const APPLE_GAIN_NS = 'xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/" xmlns:apdi="http://ns.apple.com/pixeldatainfo/1.0/"';
// An iPhone-style HDR JPEG: no XMP in the photo, EXIF with Apple's MakerNote, an MPF index,
// and a grey gain map whose XMP names it with apdi:AuxiliaryImageType and carries
// HDRGainMapVersion, as iPhones write it. Options: auxType (the apdi value), gainBody
// (more elements), note (appleMakerNote options), photoXmp (true: give the photo an hdrgm
// XMP too).
export function appleHdrJpeg(name, { auxType = 'urn:com:apple:photo:2020:aux:hdrgainmap', gainBody = '', note = {}, ...rest } = {}) {
  const mn = appleMakerNote(note);
  const tiff = tiffBlock({ ifd0: [[0x010f, 2, 0, 'Apple'], [0x0112, 3, 1, [1]]], exif: [[0x927c, 7, 0, 'x'], [0xa001, 3, 1, [1]]], makernote: () => Buffer.from(mn) });
  return gainMapJpeg(name, {
    photoXmp: false, exifTiff: tiff, companion: false,
    gainXmp: { ns: APPLE_GAIN_NS, body: `   <HDRGainMap:HDRGainMapVersion>65536</HDRGainMap:HDRGainMapVersion>\n   <apdi:AuxiliaryImageType>${auxType}</apdi:AuxiliaryImageType>${gainBody}` },
    ...rest,
  });
}

// Samsung-style trailer after EOI, with an embedded clip.
export const jpegSamsung = once('samsung.jpg', () => {
  magick(['-size', '160x120', 'plasma:fractal', '-seed', '61', '-depth', '8', '-quality', '90', path('samsung-base.jpg')]);
  const video = fakeMp4('SAMSUNG-VIDEO-PLANT', 2000);
  const name = 'MotionPhoto_Data';
  const block = u8([0, 0, 0x30, 0x0a], Buffer.from([name.length, 0, 0, 0]), name, video);
  const dirBody = u8('SEFH', Buffer.from([106, 0, 0, 0]), Buffer.from([1, 0, 0, 0]),
    [0, 0, 0x30, 0x0a], le32(block.length), le32(block.length));
  write('samsung.jpg', u8(read('samsung-base.jpg'), block, dirBody, le32(dirBody.length), 'SEFT'));
  return 'samsung.jpg';
});

// A Galaxy-style Motion Photo with an Ultra HDR gain map: the Pixel-style picture above, but
// its clip sits inside a Samsung trailer (MotionPhoto_Data), and the directory's MotionPhoto
// length counts from the start of that trailer to the end of the file.
export const jpegMotionSamsung = once('motion-samsung.jpg', () => {
  const pixel = read(jpegMotion());
  const video = fakeMp4();
  const head = pixel.subarray(0, pixel.length - video.length);
  const name = 'MotionPhoto_Data';
  const block = u8([0, 0, 0x30, 0x0a], Buffer.from([name.length, 0, 0, 0]), name, video);
  const dirBody = u8('SEFH', Buffer.from([106, 0, 0, 0]), Buffer.from([1, 0, 0, 0]), [0, 0, 0x30, 0x0a], le32(block.length + 0), le32(block.length));
  const trailer = u8(block, dirBody, le32(dirBody.length), 'SEFT');
  const text = Buffer.from(head).toString('latin1');
  const old = `Item:Length="${String(video.length).padStart(8, '0')}"`;
  if (!text.includes(old)) throw new Error('motion-samsung: no MotionPhoto length to change');
  const fixed = Buffer.from(text.replace(old, `Item:Length="${String(trailer.length).padStart(8, '0')}"`), 'latin1');
  write('motion-samsung.jpg', u8(fixed, trailer));
  return 'motion-samsung.jpg';
});

// Extended XMP spread over two APP1 segments, holding a hidden "original" picture.
export const jpegExtended = once('extended.jpg', () => {
  magick(['-size', '160x120', 'plasma:fractal', '-seed', '71', '-depth', '8', '-quality', '90', path('extended-base.jpg')]);
  const hidden = Buffer.concat([readFileSync(path('extended-base.jpg')), randomBytes(60000)]).toString('base64');
  const ext = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:GImage="http://ns.google.com/photos/1.0/image/" xmlns:Plant="http://example.invalid/plant/" Plant:Secret="EXTXMP-PLANT-SECRET" GImage:Data="${hidden}"/></rdf:RDF></x:xmpmeta>`;
  const guid = createHash('md5').update(ext).digest('hex').toUpperCase();
  const main = XMP_WRAP('', `xmlns:xmpNote="http://ns.adobe.com/xmp/note/" xmlns:GImage="http://ns.google.com/photos/1.0/image/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmpNote:HasExtendedXMP="${guid}" GImage:Mime="image/jpeg" xmp:CreateDate="2026-09-14T10:15:23"`)
    .replace('</rdf:Description>', `   <dc:creator><rdf:Seq><rdf:li>${PLANT.xmpCreator}</rdf:li></rdf:Seq></dc:creator>\n  </rdf:Description>`);
  const extBytes = Buffer.from(ext, 'utf8');
  const segs = [jpegSeg(0xe1, u8('http://ns.adobe.com/xap/1.0/\0', Buffer.from(main, 'utf8')))];
  for (let off = 0; off < extBytes.length; off += 65000) {
    segs.push(jpegSeg(0xe1, u8('http://ns.adobe.com/xmp/extension/\0', guid, be32(extBytes.length), be32(off), extBytes.subarray(off, off + 65000))));
  }
  write('extended.jpg', jpegInsert(read('extended-base.jpg'), ...segs));
  return 'extended.jpg';
});

export const pngFull = once('full.png', () => {
  const f = path('full-base.png');
  magick(['-size', '160x120', 'plasma:fractal', '-seed', '81', '-depth', '8', `PNG24:${f}`]);
  exiftoolWrite(f, [...GPS_ARGS, `-EXIF:Artist=${PLANT.artist}`, `-EXIF:Make=${PLANT.make}`, `-EXIF:SerialNumber=${PLANT.serial}`,
    '-EXIF:DateTimeOriginal=2026:09:14 10:15:23', '-EXIF:Orientation#=1',
    `-PNG:Author=${PLANT.owner}`, `-PNG:Copyright=${PLANT.copyright}`, '-PNG:CreationTime=2026:09:14 10:15:23',
    `-PNG:Software=${PLANT.software}`, `-PNG:Description=${PLANT.description}`, '-PNG:Title=Png planted title',
    `-XMP-dc:Creator=${PLANT.xmpCreator}`, `-XMP-photoshop:City=${PLANT.xmpCity}`, '-XMP-xmp:CreateDate=2026:09:14 10:15:23',
    `-XMP-xmpMM:DocumentID=${PLANT.xmpDocId}`, `-IPTC:By-line=${PLANT.iptcByline}`, '-IPTC:Credit=Iptc credit line',
    `-ICC_Profile<=${icc}`]);
  const z = (kw, text) => pngChunk('zTXt', u8(kw, [0, 0], zlib.deflateSync(Buffer.from(text, 'latin1'))));
  const itxtZ = (kw, text) => pngChunk('iTXt', u8(kw, [0, 1, 0], 'en', [0], [0], zlib.deflateSync(Buffer.from(text, 'utf8'))));
  let b = read('full-base.png');
  b = pngInsertBefore(b, 'IDAT', z('Comment', 'ZTXT-PLANT-COMMENT'), itxtZ('Warning', 'ITXT-PLANT-WARNING'),
    pngChunk('prVt', 'PRVT-PLANT-SECRET'), pngChunk('caBX', fakeJumbf()), pngChunk('tIME', [0x07, 0xea, 9, 14, 10, 15, 23]));
  write('full.png', u8(b, 'PNGTAIL-PLANT-SECRET'));
  return 'full.png';
});

// ImageMagick-style PNG: raw profile text blocks (8BIM, IPTC, XMP) and "exif:" text copies,
// plus a hand-made compressed "Raw profile type exif" block.
export const pngRaw = once('raw.png', () => {
  const j = path('raw-src.jpg');
  magick(['-size', '160x120', 'plasma:fractal', '-seed', '91', '-depth', '8', '-quality', '90', j]);
  exiftoolWrite(j, [...GPS_ARGS, `-EXIF:Artist=${PLANT.artist}`, `-XMP-dc:Creator=${PLANT.xmpCreator}`,
    `-IPTC:By-line=${PLANT.iptcByline}`, `-IPTC:City=${PLANT.iptcCity}`, '-IPTC:Credit=Iptc credit line', '-IPTC:Keywords=Rawkeyword', '-IPTC:DateCreated=2026:09:14']);
  magick([j, `PNG24:${path('raw-base.png')}`]);
  const tiff = tiffBlock({ ifd0: [[0x010f, 2, 0, 'RawCam'], [0x0131, 2, 0, 'RawSoft 1']], exif: [[0xa431, 2, 0, 'RAWEXIF-PLANT-SERIAL'], [0x9003, 2, 0, '2026:09:14 10:15:23']] });
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(tiff)]);
  const hex = payload.toString('hex').replace(/(.{72})/g, '$1\n');
  const text = `\nexif\n${String(payload.length).padStart(8, ' ')}\n${hex}\n`;
  const chunk = pngChunk('zTXt', u8('Raw profile type exif', [0, 0], zlib.deflateSync(Buffer.from(text, 'latin1'))));
  write('raw.png', pngInsertBefore(read('raw-base.png'), 'IEND', chunk));
  return 'raw.png';
});

export const webpFull = once('full.webp', () => {
  const f = path('full-base.webp');
  magick(['-size', '160x120', 'plasma:fractal', '-seed', '101', '-depth', '8', '-quality', '80', f]);
  exiftoolWrite(f, [...GPS_ARGS, `-EXIF:Artist=${PLANT.artist}`, `-EXIF:Make=${PLANT.make}`, `-EXIF:SerialNumber=${PLANT.serial}`,
    '-EXIF:DateTimeOriginal=2026:09:14 10:15:23', `-XMP-dc:Creator=${PLANT.xmpCreator}`, '-XMP-xmp:CreateDate=2026:09:14 10:15:23',
    `-ICC_Profile<=${icc}`]);
  const chunks = webpChunks(read('full-base.webp')).map((c) => {
    if (c.type === 'EXIF') return webpChunk('EXIF', u8('Exif\0\0', c.data));
    return c.raw;
  });
  chunks.push(webpChunk('prVt', 'PRVT-PLANT-ODD!!!'));
  chunks.push(webpChunk('C2PA', fakeJumbf()));
  write('full.webp', u8(webpRebuild(chunks), 'WEBPTAIL-PLANT'));
  return 'full.webp';
});

export const webpSimple = once('simple.webp', () => {
  magick(['-size', '96x64', 'plasma:fractal', '-seed', '111', '-depth', '8', '-define', 'webp:lossless=true', path('simple.webp')]);
  return 'simple.webp';
});

export const heicExiftool = once('exiftool.heic', () => {
  const f = path('exiftool.heic');
  magick(['-size', '160x120', 'plasma:fractal', '-seed', '121', '-depth', '8', f]);
  exiftoolWrite(f, [...GPS_ARGS, `-EXIF:Artist=${PLANT.artist}`, `-EXIF:Make=${PLANT.make}`, `-EXIF:Model=${PLANT.model}`,
    `-EXIF:SerialNumber=${PLANT.serial}`, '-EXIF:DateTimeOriginal=2026:09:14 10:15:23', '-EXIF:Orientation#=6',
    `-XMP-dc:Creator=${PLANT.xmpCreator}`, `-XMP-photoshop:City=${PLANT.xmpCity}`, '-XMP-xmp:CreateDate=2026:09:14 10:15:23']);
  return 'exiftool.heic';
});

// ======================================================================================
// Hand-assembled HEIC files: thumbnail item, EXIF in idat, XMP in two extents, ICC colour
// property, and the different iloc versions and field sizes.

function boxList(b, s, e) {
  const out = [];
  let p = s;
  while (p + 8 <= e) {
    const size = b.readUInt32BE(p);
    out.push({ type: b.toString('latin1', p + 4, p + 8), start: p, ds: p + 8, end: p + size });
    p += size;
  }
  return out;
}

// Pulls the coded picture and its properties out of a simple ImageMagick HEIC.
function extractHeic(file) {
  const b = readFileSync(file);
  const meta = boxList(b, 0, b.length).find((x) => x.type === 'meta');
  const kids = boxList(b, meta.ds + 4, meta.end);
  const iloc = kids.find((x) => x.type === 'iloc');
  const d = iloc.ds;
  const ver = b[d];
  const offSize = b[d + 4] >> 4;
  const lenSize = b[d + 4] & 15;
  const baseSize = b[d + 5] >> 4;
  // Version 0 or 1, one item: count(2) id(2) [method(2)] data_reference(2), then base offset.
  let p = d + 8 + 2 + (ver === 1 ? 2 : 0) + 2;
  const readN = (n) => { const v = n === 4 ? b.readUInt32BE(p) : n === 8 ? Number(b.readBigUInt64BE(p)) : 0; p += n; return v; };
  const base = readN(baseSize);
  const n = b.readUInt16BE(p); p += 2;
  const parts = [];
  for (let i = 0; i < n; i++) { const off = readN(offSize); const len = readN(lenSize); parts.push(b.subarray(base + off, base + off + len)); }
  const iprp = kids.find((x) => x.type === 'iprp');
  const ik = boxList(b, iprp.ds, iprp.end);
  const props = boxList(b, ik[0].ds, ik[0].end).map((x) => b.subarray(x.start, x.end));
  const ipma = ik[1];
  const flags = b[ipma.ds + 3];
  let q = ipma.ds + 8 + 2;
  const k = b[q++];
  const assoc = [];
  for (let i = 0; i < k; i++) {
    if (flags & 1) { assoc.push(b.readUInt16BE(q)); q += 2; } else assoc.push(b[q++]);
  }
  return { data: Buffer.concat(parts), props: assoc.map((a) => ({ box: props[(a & 0x7f) - 1], essential: !!(a & 0x80) })) };
}

const box = (type, ...parts) => { const body = u8(...parts); return u8(be32(8 + body.length), type, body); };
const fullbox = (type, v, flags, ...parts) => box(type, [v, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);

export function buildHeic(name, { ilocVersion = 1, offSize = 4, lenSize = 4, baseSize = 4, idxSize = 0, infeVersion = 2, wideIds = false, ipmaLarge = false, iccBytes: iccIn = null }) {
  magick(['-size', '160x120', 'plasma:fractal', '-seed', '131', '-depth', '8', path('heic-primary.heic')]);
  magick(['-size', '48x36', 'plasma:fractal', '-seed', '132', '-depth', '8', path('heic-thumb.heic')]);
  const prim = extractHeic(path('heic-primary.heic'));
  const thumb = extractHeic(path('heic-thumb.heic'));
  const iccBytes = iccIn || readFileSync(icc);
  const colr = box('colr', 'prof', iccBytes);
  const tiff = tiffBlock({
    ifd0: [[0x010f, 2, 0, PLANT.make], [0x013b, 2, 0, PLANT.artist], [0x0112, 3, 1, [1]]],
    exif: [[0xa431, 2, 0, PLANT.serial], [0x9003, 2, 0, '2026:09:14 10:15:23']],
    gps: [[0x0001, 2, 2, 'N'], [0x0002, 5, 3, [48, 1, 51, 1, 3024, 100]], [0x0003, 2, 2, 'E'], [0x0004, 5, 3, [2, 1, 17, 1, 4020, 100]]],
  });
  const exifPayload = u8(be32(6), 'Exif\0\0', tiff);
  const xmp = Buffer.from(XMP_WRAP(`   <dc:creator><rdf:Seq><rdf:li>${PLANT.xmpCreator}</rdf:li></rdf:Seq></dc:creator>`,
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" photoshop:City="${PLANT.xmpCity}" xmp:CreateDate="2026-09-14T10:15:23"`) + ' '.repeat(200), 'utf8');
  const xmpA = xmp.subarray(0, 300);
  const xmpB = xmp.subarray(300);
  const filler = randomBytes(37);

  const idw = (v) => (wideIds ? be32(v) : be16(v));
  const nfield = (n, v) => (n === 0 ? Buffer.alloc(0) : n === 4 ? be32(v) : be64(v));
  const infe = (id, type, extra = []) => fullbox('infe', infeVersion, 0, infeVersion === 3 ? be32(id) : be16(id), be16(0), type, [0], ...extra);

  const metaFor = (pos) => {
    const hdlr = fullbox('hdlr', 0, 0, be32(0), 'pict', Buffer.alloc(12), [0]);
    const pitm = fullbox('pitm', wideIds ? 1 : 0, 0, idw(1));
    const iinfV = wideIds ? 1 : 0;
    const iinf = fullbox('iinf', iinfV, 0, iinfV ? be32(4) : be16(4),
      infe(1, 'hvc1'), infe(2, 'hvc1'), infe(3, 'Exif'), infe(4, 'mime', ['application/rdf+xml', [0]]));
    const refV = wideIds ? 1 : 0;
    const ref = (type, from, to) => box(type, idw(from), be16(1), idw(to));
    const iref = fullbox('iref', refV, 0, ref('thmb', 2, 1), ref('cdsc', 3, 1), ref('cdsc', 4, 1));
    const props = [...prim.props.map((x) => x.box), colr, ...thumb.props.map((x) => x.box)];
    const ipco = box('ipco', ...props);
    const assocEntry = (idx, ess) => (ipmaLarge ? be16((ess ? 0x8000 : 0) | idx) : [(ess ? 0x80 : 0) | idx]);
    const primAssoc = prim.props.map((x, i) => assocEntry(i + 1, x.essential));
    primAssoc.push(assocEntry(prim.props.length + 1, false));
    const thumbAssoc = thumb.props.map((x, i) => assocEntry(prim.props.length + 2 + i, x.essential));
    const ipmaV = wideIds ? 1 : 0;
    const ipma = fullbox('ipma', ipmaV, ipmaLarge ? 1 : 0, be32(2),
      idw(1), [primAssoc.length], ...primAssoc, idw(2), [thumbAssoc.length], ...thumbAssoc);
    const iprp = box('iprp', ipco, ipma);
    const v = ilocVersion;
    const itemHead = (id, method) => [v < 2 ? be16(id) : be32(id), ...(v >= 1 ? [be16(method)] : []), be16(0)];
    const extent = (off, len, idx = 1) => [...(v >= 1 && idxSize ? [nfield(idxSize, idx)] : []), nfield(offSize, off), nfield(lenSize, len)];
    const base = baseSize ? pos.mdat : 0;
    const rel = (x) => (baseSize ? x - pos.mdat : x);
    const items = [
      [...itemHead(1, 0), nfield(baseSize, base), be16(1), ...extent(rel(pos.prim), prim.data.length)],
      [...itemHead(2, 0), nfield(baseSize, base), be16(1), ...extent(rel(pos.thumb), thumb.data.length)],
      v >= 1
        ? [...itemHead(3, 1), nfield(baseSize, 0), be16(1), ...extent(0, exifPayload.length)]
        : [...itemHead(3, 0), nfield(baseSize, base), be16(1), ...extent(rel(pos.exifMdat), exifPayload.length)],
      [...itemHead(4, 0), nfield(baseSize, base), be16(2), ...extent(rel(pos.xmpA), xmpA.length), ...extent(rel(pos.xmpB), xmpB.length, 2)],
    ];
    const iloc = fullbox('iloc', v, 0, [(offSize << 4) | lenSize, (baseSize << 4) | (v >= 1 ? idxSize : 0)], v < 2 ? be16(4) : be32(4), ...items.flat());
    const kids = [hdlr, pitm, iinf, iref, iprp, iloc];
    if (v >= 1) kids.push(box('idat', exifPayload));
    return fullbox('meta', 0, 0, ...kids);
  };
  const ftyp = box('ftyp', 'heic', be32(0), 'mif1', 'heic', 'miaf');
  const mdatParts = (start) => {
    const pos = { mdat: start };
    let p = start + 8;
    pos.prim = p; p += prim.data.length;
    pos.xmpA = p; p += xmpA.length;
    p += filler.length;
    pos.thumb = p; p += thumb.data.length;
    pos.xmpB = p; p += xmpB.length;
    if (ilocVersion === 0) { pos.exifMdat = p; p += exifPayload.length; }
    return pos;
  };
  const dummy = metaFor(mdatParts(0));
  const pos = mdatParts(ftyp.length + dummy.length);
  const meta = metaFor(pos);
  const mdatBody = [prim.data, xmpA, filler, thumb.data, xmpB, ...(ilocVersion === 0 ? [exifPayload] : [])];
  const mdat = box('mdat', ...mdatBody);
  const out = u8(ftyp, meta, mdat);
  write(name, out);
  return { name, thumbRange: [pos.thumb, pos.thumb + thumb.data.length], primRange: [pos.prim, pos.prim + prim.data.length] };
}

// An iPhone-style HDR HEIC: a primary picture with EXIF holding Apple's MakerNote (the two
// HDR numbers and a text plant) and an XMP packet, and an auxiliary HDR gain map attached
// with auxl, named by an auxC property, with its own XMP packet (HDRGainMapVersion), as
// iPhones write it. Options: auxType (the auxC name), auxTail (bytes after the name's NUL),
// gainBody (more elements in the gain map's XMP), note (appleMakerNote options), photoXmp
// (the photo's XMP body), pad (spaces after the photo's packet), noGain (no gain map).
// Options for the review probes of 4 October 2026: names (item id to item name), extraProps
// (property boxes attached to the picture, not essential), auxHidden (false: the gain map's
// item entry is not marked hidden), hdlrName (text after hdlr's reserved fields), ftypMinor
// and brands (ftyp), exifHead (the six bytes before the TIFF header of the EXIF item).
export function appleHdrHeic(name, {
  auxType = 'urn:com:apple:photo:2020:aux:hdrgainmap', auxTail = null, gainBody = '', note = {}, photoXmp = null, pad = 0, noGain = false,
  names = {}, extraProps = [], auxHidden = true, hdlrName = '', ftypMinor = null, brands = ['mif1', 'heic', 'miaf'], exifHead = 'Exif\0\0',
} = {}) {
  if (!existsSync(path('heic-apple-primary.heic'))) magick(['-size', '160x120', 'plasma:fractal', '-seed', '151', '-depth', '8', path('heic-apple-primary.heic')]);
  if (!existsSync(path('heic-apple-gain.heic'))) magick(['-size', '80x60', 'gradient:gray20-gray90', '-depth', '8', path('heic-apple-gain.heic')]);
  const prim = extractHeic(path('heic-apple-primary.heic'));
  const gain = extractHeic(path('heic-apple-gain.heic'));
  const mn = appleMakerNote(note);
  const tiff = tiffBlock({ ifd0: [[0x010f, 2, 0, 'Apple'], [0x0110, 2, 0, 'iPhone 14'], [0x0112, 3, 1, [1]]], exif: [[0x927c, 7, 0, 'x'], [0x9003, 2, 0, '2026:09:14 10:15:23']], makernote: () => Buffer.from(mn) });
  const exifPayload = u8(be32(6), exifHead, tiff);
  const photo = Buffer.from(XMP_WRAP(photoXmp ?? `   <dc:creator><rdf:Seq><rdf:li>${PLANT.xmpCreator}</rdf:li></rdf:Seq></dc:creator>\n   <xmp:CreateDate>2026-09-14T10:15:23</xmp:CreateDate>`,
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"') + ' '.repeat(pad), 'utf8');
  const gainXmp = Buffer.from(`<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 6.0.0">
   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description rdf:about=""
            xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/">
         <HDRGainMap:HDRGainMapVersion>65536</HDRGainMap:HDRGainMapVersion>${gainBody}
      </rdf:Description>
   </rdf:RDF>
</x:xmpmeta>
`, 'utf8');
  const auxC = fullbox('auxC', 0, 0, auxType, [0], ...(auxTail ? [auxTail] : []));
  const items = [
    { id: 1, type: 'hvc1', data: prim.data },
    { id: 2, type: 'Exif', data: exifPayload, hidden: true },
    { id: 3, type: 'mime', data: photo, hidden: true },
    ...(noGain ? [] : [{ id: 4, type: 'hvc1', data: gain.data, hidden: auxHidden }, { id: 5, type: 'mime', data: gainXmp, hidden: true }]),
  ];
  const props = [...prim.props.map((x) => x.box), ...gain.props.map((x) => x.box), auxC, ...extraProps];
  const primAssoc = [...prim.props.map((x, i) => [(x.essential ? 0x80 : 0) | (i + 1)]), ...extraProps.map((x, i) => [prim.props.length + gain.props.length + 2 + i])];
  const gainAssoc = [...gain.props.map((x, i) => [(x.essential ? 0x80 : 0) | (prim.props.length + i + 1)]), [prim.props.length + gain.props.length + 1]];
  const ref = (type, from, to) => box(type, be16(from), be16(1), be16(to));
  const infe = (it) => fullbox('infe', 2, it.hidden ? 1 : 0, be16(it.id), be16(0), it.type, names[it.id] || '', [0], ...(it.type === 'mime' ? ['application/rdf+xml', [0]] : []));
  const metaFor = (pos) => {
    const hdlr = fullbox('hdlr', 0, 0, be32(0), 'pict', Buffer.alloc(12), hdlrName, [0]);
    const pitm = fullbox('pitm', 0, 0, be16(1));
    const iinf = fullbox('iinf', 0, 0, be16(items.length), ...items.map(infe));
    const iref = fullbox('iref', 0, 0, ...(noGain ? [] : [ref('auxl', 4, 1)]), ref('cdsc', 2, 1), ref('cdsc', 3, 1), ...(noGain ? [] : [ref('cdsc', 5, 4)]));
    const ipco = box('ipco', ...props);
    const ipmaEntries = [[1, primAssoc], ...(noGain ? [] : [[4, gainAssoc]])];
    const ipma = fullbox('ipma', 0, 0, be32(ipmaEntries.length), ...ipmaEntries.map(([id, a]) => u8(be16(id), [a.length], ...a)));
    const iprp = box('iprp', ipco, ipma);
    const iloc = fullbox('iloc', 1, 0, [0x44, 0x40], be16(items.length), ...items.map((it) => u8(be16(it.id), be16(0), be16(0), be32(pos.mdat), be16(1), be32(pos[it.id] - pos.mdat), be32(it.data.length))));
    return fullbox('meta', 0, 0, hdlr, pitm, iinf, iref, iprp, iloc);
  };
  const ftyp = box('ftyp', 'heic', ftypMinor === null ? be32(0) : ftypMinor, ...brands);
  const layout = (start) => { const pos = { mdat: start }; let p = start + 8; for (const it of items) { pos[it.id] = p; p += it.data.length; } return pos; };
  const meta = metaFor(layout(ftyp.length + metaFor(layout(0)).length));
  const out = u8(ftyp, meta, box('mdat', ...items.map((it) => it.data)));
  write(name, out);
  return name;
}

export { box as isoBox, fullbox as isoFullBox };

// libheif's view of HEIC files (python3 ctypes over libheif.so.1): { file: { primary,
// aux: [{ type, size, pixels }], top } }, pixels being hashes of the decoded planes and top
// the number of top-level images (pictures a viewer offers on their own).
export function heifInfo(files) {
  const script = path('heif-info.py');
  if (!existsSync(script)) {
    writeFileSync(script, `import ctypes, sys, hashlib, json
L = ctypes.CDLL('libheif.so.1')
class Err(ctypes.Structure):
    _fields_ = [('code', ctypes.c_int), ('subcode', ctypes.c_int), ('message', ctypes.c_char_p)]
V = ctypes.c_void_p
L.heif_context_alloc.restype = V
L.heif_context_read_from_file.argtypes = [V, ctypes.c_char_p, V]
L.heif_context_read_from_file.restype = Err
L.heif_context_get_primary_image_handle.argtypes = [V, ctypes.POINTER(V)]
L.heif_context_get_primary_image_handle.restype = Err
L.heif_image_handle_get_number_of_auxiliary_images.argtypes = [V, ctypes.c_int]
L.heif_image_handle_get_list_of_auxiliary_image_IDs.argtypes = [V, ctypes.c_int, ctypes.POINTER(ctypes.c_uint32), ctypes.c_int]
L.heif_image_handle_get_auxiliary_image_handle.argtypes = [V, ctypes.c_uint32, ctypes.POINTER(V)]
L.heif_image_handle_get_auxiliary_image_handle.restype = Err
L.heif_image_handle_get_auxiliary_type.argtypes = [V, ctypes.POINTER(ctypes.c_char_p)]
L.heif_image_handle_get_auxiliary_type.restype = Err
L.heif_image_handle_get_width.argtypes = [V]
L.heif_image_handle_get_height.argtypes = [V]
L.heif_decode_image.argtypes = [V, ctypes.POINTER(V), ctypes.c_int, ctypes.c_int, V]
L.heif_decode_image.restype = Err
L.heif_image_get_plane_readonly.argtypes = [V, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
L.heif_image_get_plane_readonly.restype = ctypes.POINTER(ctypes.c_uint8)
L.heif_image_get_height.argtypes = [V, ctypes.c_int]
L.heif_context_get_number_of_top_level_images.argtypes = [V]
def pixels(h):
    img = V()
    e = L.heif_decode_image(h, ctypes.byref(img), 99, 99, None)
    if e.code: return None
    hs = hashlib.sha256()
    for ch in (0, 1, 2):
        stride = ctypes.c_int()
        p = L.heif_image_get_plane_readonly(img, ch, ctypes.byref(stride))
        if p: hs.update(ctypes.string_at(p, stride.value * L.heif_image_get_height(img, ch)))
    return hs.hexdigest()
out = {}
for f in sys.argv[1:]:
    ctx = L.heif_context_alloc()
    e = L.heif_context_read_from_file(ctx, f.encode(), None)
    if e.code:
        out[f] = {'error': e.message.decode()}
        continue
    h = V()
    L.heif_context_get_primary_image_handle(ctx, ctypes.byref(h))
    n = L.heif_image_handle_get_number_of_auxiliary_images(h, 0)
    ids = (ctypes.c_uint32 * max(n, 1))()
    L.heif_image_handle_get_list_of_auxiliary_image_IDs(h, 0, ids, n)
    aux = []
    for i in range(n):
        a = V()
        L.heif_image_handle_get_auxiliary_image_handle(h, ids[i], ctypes.byref(a))
        t = ctypes.c_char_p()
        L.heif_image_handle_get_auxiliary_type(a, ctypes.byref(t))
        aux.append({'type': t.value.decode('latin1') if t.value else '', 'size': [L.heif_image_handle_get_width(a), L.heif_image_handle_get_height(a)], 'pixels': pixels(a)})
    out[f] = {'primary': pixels(h), 'aux': aux, 'top': L.heif_context_get_number_of_top_level_images(ctx)}
print(json.dumps(out))
`);
  }
  return JSON.parse(sh('python3', [script, ...files]));
}

export function decodeHashes(files) {
  const script = path('pixel-hash.py');
  if (!existsSync(script)) {
    writeFileSync(script, `import sys, json, hashlib
from PIL import Image
out = {}
for f in sys.argv[1:]:
    im = Image.open(f)
    im.load()
    out[f] = im.mode + ':' + hashlib.sha256(im.tobytes()).hexdigest()
print(json.dumps(out))
`);
  }
  const pil = files.filter((f) => !/\.heic$/i.test(f));
  const res = pil.length ? JSON.parse(sh('python3', [script, ...pil])) : {};
  for (const f of files.filter((x) => /\.heic$/i.test(x))) {
    res[f] = 'magick:' + createHash('sha256').update(sh('magick', [f, '-depth', '8', 'rgba:-'], true)).digest('hex');
  }
  return files.map((f) => res[f]);
}

// The ICC profile of a file as exiftool extracts it, and whether Pillow's colour engine
// (LittleCMS) opens it: { bytes, ok, desc, cprt, error }.
export function iccOf(file) {
  const bytes = sh('exiftool', ['-b', '-ICC_Profile', file], true);
  if (!bytes.length) return { bytes, ok: false, error: 'no profile' };
  const tmp = `${file}.icc`;
  writeFileSync(tmp, bytes);
  const r = spawnSync('python3', ['-c', `import sys, json
from PIL import ImageCms
p = ImageCms.ImageCmsProfile(sys.argv[1])
print(json.dumps({'desc': ImageCms.getProfileDescription(p).strip(), 'cprt': ImageCms.getProfileCopyright(p).strip()}))`, tmp], { encoding: 'utf8' });
  if (r.status !== 0) return { bytes, ok: false, error: r.stderr.trim().split('\n').pop() };
  return { bytes, ok: true, ...JSON.parse(r.stdout) };
}

// The tags of an ICC profile: { sig: { off, len, type, data } }.
export function iccTags(p) {
  const b = Buffer.from(p);
  const out = {};
  for (let i = 0; i < b.readUInt32BE(128); i++) {
    const e = 132 + i * 12;
    const off = b.readUInt32BE(e + 4);
    const len = b.readUInt32BE(e + 8);
    out[b.toString('latin1', e, e + 4)] = { off, len, type: b.toString('latin1', off, off + 4), data: b.subarray(off, off + len) };
  }
  return out;
}

// exiftool's view of a file as [{ group, tag, value }].
export function exifRead(file) {
  const out = sh('exiftool', ['-a', '-u', '-G1', '-ee', '-s', '-n', file]);
  return out.split('\n').filter(Boolean).map((line) => {
    const m = /^\[([^\]]+)\]\s+(\S+)\s*:\s?(.*)$/.exec(line);
    return m ? { group: m[1], tag: m[2], value: m[3] } : { group: '?', tag: line, value: '' };
  });
}

export function validate(file) {
  const out = sh('exiftool', ['-validate', '-warning', '-error', '-a', '-G1', '-s', file]);
  return out.split('\n')
    .filter((l) => /^\[ExifTool\]\s+(Warning|Error)\b/.test(l))
    .map((l) => l.replace(/^\[[^\]]+\]\s+\S+\s*:\s*/, '').replace(/\s*\[x\d+\]$/, '').trim())
    .sort();
}
