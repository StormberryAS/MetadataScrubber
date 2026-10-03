// Synthetic test pictures for the engine tests. Nothing here is a real photo: pictures are
// generated noise from ImageMagick, and every name, serial number and place is invented
// (the GPS position is a public landmark). Files are written to a scratch folder and never
// committed. Set MS_FIXTURE_DIR to choose the folder.

import { execFileSync } from 'node:child_process';
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
    `-IPTC:By-line=${PLANT.iptcByline}`, `-IPTC:City=${PLANT.iptcCity}`, '-IPTC:Credit=Iptc credit line', '-IPTC:Keywords=Rawkeyword']);
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

export function buildHeic(name, { ilocVersion = 1, offSize = 4, lenSize = 4, baseSize = 4, idxSize = 0, infeVersion = 2, wideIds = false, ipmaLarge = false }) {
  magick(['-size', '160x120', 'plasma:fractal', '-seed', '131', '-depth', '8', path('heic-primary.heic')]);
  magick(['-size', '48x36', 'plasma:fractal', '-seed', '132', '-depth', '8', path('heic-thumb.heic')]);
  const prim = extractHeic(path('heic-primary.heic'));
  const thumb = extractHeic(path('heic-thumb.heic'));
  const iccBytes = readFileSync(icc);
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
