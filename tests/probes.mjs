// Hidden-channel probes from the privacy review of 4 October 2026 (0.0.3).
//
// Since 0.0.3 only red details are ticked to start with, so whatever an amber (date or
// device) or green detail keeps by default must hold nothing a person cannot see. Each probe
// hides a canary where the review found that the starting selection used to keep it: text
// after the end marker of an EXIF field, fields the page does not show, PNG text chunk
// fields (language tag, translated keyword, bytes after the compressed stream), Photoshop
// resource names and IPTC structure, XMP attributes and qualifiers, the XMP toolkit name,
// HEIC structure (ftyp, hdlr, item names, the EXIF item's prefix, a creation time with a
// tail, an auxiliary image's label), the bytes before a WebP EXIF block, and Content
// Credentials. Canary tiers:
//   red    must be gone after the starting selection (red only);
//   amber  a short, well-formed device name: shown on the page, kept by the starting
//          selection, gone when amber is ticked. The checks cannot tell such a name from a
//          model name, which the README and DESIGN notes say.
//
// Used by tests/core.test.mjs and tests/audit.mjs. Everything is synthetic.

import { existsSync } from 'node:fs';
import zlib from 'node:zlib';

export function privacyProbes(F) {
  const list = [];
  const add = (name, bytes, canaries, note) => { F.write(name, bytes); list.push({ name, bytes: new Uint8Array(bytes), canaries, note }); };
  const red = (string, location) => ({ string, tier: 'red', location });
  const amber = (string, location) => ({ string, tier: 'amber', location });
  const T = (s) => Buffer.from(s, 'latin1');
  const base = (ext, seed, extra = []) => {
    const n = `probe-base-${seed}.${ext}`;
    if (!existsSync(F.path(n))) F.magick(['-size', '64x48', 'plasma:fractal', '-seed', String(seed), '-depth', '8', '-strip', ...extra, F.path(n)]);
    return F.read(n);
  };
  const jpg = base('jpg', 201, ['-quality', '85']);
  const png = base('png', 202);
  const exif = (tiff) => F.jpegSeg(0xe1, F.u8('Exif\0\0', tiff));

  // EXIF
  add('probe-exif-afternul.jpg', F.jpegInsert(jpg, exif(F.tiffBlock({
    ifd0: [[0x010f, 2, 0, T('Canon\0PROBE-MAKE-AFTERNUL-7a1\0')], [0x0131, 2, 0, T('GIMP 2.10\0PROBE-SW-AFTERNUL-7a2\0')]],
    exif: [[0x9003, 2, 0, T('2024:01:01 12:00:00\0PROBE-DATE-AFTERNUL-7a3\0')]],
  }))), [
    red('PROBE-MAKE-AFTERNUL-7a1', 'EXIF Make after its end marker (shown as Canon)'),
    red('PROBE-SW-AFTERNUL-7a2', 'EXIF Software after its end marker'),
    red('PROBE-DATE-AFTERNUL-7a3', 'EXIF DateTimeOriginal after its end marker'),
  ], 'Text hidden after the end marker of a camera, software and date field.');
  add('probe-exif-unshown.jpg', F.jpegInsert(jpg, exif(F.tiffBlock({
    ifd0: [[0x010f, 2, 0, 'Canon']],
    exif: [[0x9003, 2, 0, '2024:01:01 12:00:00'], [0x9291, 2, 0, 'PROBE-SUBSEC-7b1'], [0x9011, 2, 0, 'PROBE-TZ-7b2'],
      [0x882a, 8, 8, T('PROBE-TZOFF-7b3!')], [0xa432, 5, 6, T('PROBE-LENSSPEC-7b4'.padEnd(48, '.'))]],
  }))), [
    red('PROBE-SUBSEC-7b1', 'EXIF SubSecTimeOriginal, which the page does not show'),
    red('PROBE-TZ-7b2', 'EXIF OffsetTimeOriginal holding text'),
    red('PROBE-TZOFF-7b3', 'EXIF TimeZoneOffset with eight values'),
    red('PROBE-LENSSPEC-7b4', 'EXIF LensSpecification with six values'),
  ], 'Date and device fields the page does not show, or with a type or count their specification does not give.');
  add('probe-exif-other.jpg', F.jpegInsert(jpg, exif(F.tiffBlock({
    ifd0: [[0x010f, 2, 0, 'Canon'], [0x0213, 3, 1, [1]], [0x014a, 4, 6, T('PROBE-SUBIFDS-7c1-xxxxxx')], [0x0201, 4, 1, T('Q7c2')], [0x0202, 4, 1, T('Q7c3')],
      [0xc4a5, 7, 0, T('PrintIM\x000300PROBE-PRINTIM-7c4')]],
    exif: [[0xa004, 2, 0, 'PROBE-SOUND-7c5 with a note']],
  }))), [
    red('PROBE-SUBIFDS-7c1', 'EXIF SubIFDs, a list of numbers spelling text'),
    red('Q7c2', 'EXIF JPEGInterchangeFormat outside the preview chain'),
    red('Q7c3', 'EXIF JPEGInterchangeFormatLength outside the preview chain'),
    red('PROBE-PRINTIM-7c4', 'EXIF PrintIM'),
    red('PROBE-SOUND-7c5', 'EXIF RelatedSoundFile that is not a file name'),
  ], 'Fields once kept as "other camera data".');
  add('probe-exif-visible.jpg', F.jpegInsert(jpg, exif(F.tiffBlock({ ifd0: [[0x010f, 2, 0, 'PROBE Visible Make 7d1']] }))), [
    amber('PROBE Visible Make 7d1', 'EXIF Make: a short, well-formed name, shown as amber'),
  ], 'A name written as the camera make: shown, kept until amber is ticked.');

  // PNG
  const chunk = (type, ...parts) => F.pngChunk(type, F.u8(...parts));
  const ztail = Buffer.concat([zlib.deflateSync(Buffer.from('2024-01-01T00:00:00')), T('PROBE-ZTAIL-8a3')]);
  add('probe-png-text.png', F.pngInsertBefore(png, 'IDAT',
    chunk('tEXt', 'Creation Time\0PROBE-CTIME-8a0 Storgata 5'),
    chunk('iTXt', 'date:create\0\0\0x-PROBE-LANG-8a1\0PROBE-TRANS-8a2\0', '2024-01-01T00:00:00'),
    chunk('zTXt', 'date:modify\0\0', ztail),
    chunk('tEXt', 'Software\0PROBE Soft 8a4'),
    chunk('tEXt', 'exif:PrintIM\0PROBE-PNG-PRINTIM-8a5'),
    chunk('tEXt', 'exif:RelatedSoundFile\0PROBE-PNG-SOUND-8a6'),
    chunk('tEXt', 'exif:DateTimeOriginal\0PROBE-PNG-DTO-8a7'),
    chunk('tEXt', 'exif:SubIFDs\0PROBE-PNG-SUBIFD-8a8'),
    chunk('tIME', [0x07, 0xe8, 1, 1, 0, 0, 0], 'PROBE-TIME-TAIL-8a9'),
  ), [
    red('PROBE-CTIME-8a0', 'PNG Creation Time that is not a date'),
    red('PROBE-LANG-8a1', 'the language tag of an iTXt date'),
    red('PROBE-TRANS-8a2', 'the translated keyword of an iTXt date'),
    red('PROBE-ZTAIL-8a3', 'bytes after the compressed stream of a zTXt date'),
    amber('PROBE Soft 8a4', 'PNG Software: a short, well-formed name, shown as amber'),
    red('PROBE-PNG-PRINTIM-8a5', 'a PNG exif:PrintIM text chunk'),
    red('PROBE-PNG-SOUND-8a6', 'a PNG exif:RelatedSoundFile text chunk that is not a file name'),
    red('PROBE-PNG-DTO-8a7', 'a PNG exif:DateTimeOriginal text chunk that is not a date'),
    red('PROBE-PNG-SUBIFD-8a8', 'a PNG exif:SubIFDs text chunk'),
    red('PROBE-TIME-TAIL-8a9', 'bytes after the seven bytes of tIME'),
  ], 'PNG text chunks around dates and device names.');
  add('probe-png-exif-prefix.png', F.pngInsertBefore(png, 'IDAT', F.pngChunk('eXIf', F.u8('PRBEXF7', F.tiffBlock({ ifd0: [[0x010f, 2, 0, 'Canon']] })))), [
    red('PRBEXF7', 'bytes before the TIFF header of an eXIf chunk'),
  ], 'An eXIf chunk with bytes before its TIFF header.');

  // IPTC and the Photoshop block
  const ds = (r, d, v) => F.u8([0x1c, r, d], [v.length >> 8, v.length & 255], v);
  const res = (id, name, data) => {
    let n = F.u8([name.length], name);
    if (n.length & 1) n = F.u8(n, [0]);
    return F.u8('8BIM', [id >> 8, id & 255], n, [data.length >>> 24, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255], data, data.length & 1 ? [0] : []);
  };
  const iptc = F.u8(ds(1, 90, F.u8([0x1b, 0x25, 0x47], 'PROBE-190-9a2')), ds(2, 0, F.u8([0, 4], 'PROBE-200-9a3')), ds(2, 55, T('PROBE-DATE-9a4')), ds(2, 65, T('PROBE Prog 9a5')), ds(2, 60, T('120000')));
  const irb = F.u8(res(0x0404, 'PROBE-RESNAME-9a1', iptc), res(0x0425, '', T('PROBE-DIGEST-9a6-0123456789')));
  add('probe-iptc.jpg', F.jpegInsert(jpg, F.jpegSeg(0xed, F.u8('Photoshop 3.0\0', irb))), [
    red('PROBE-RESNAME-9a1', 'the name of the Photoshop resource holding IPTC'),
    red('PROBE-190-9a2', 'IPTC 1:90 (character set) holding more than the UTF-8 marker'),
    red('PROBE-200-9a3', 'IPTC 2:0 (record version) longer than two bytes'),
    red('PROBE-DATE-9a4', 'IPTC 2:55 (date created) that is not a date'),
    amber('PROBE Prog 9a5', 'IPTC 2:65 (program): a short, well-formed name, shown as amber'),
    red('PROBE-DIGEST-9a6', 'the IPTC digest resource (0x0425)'),
  ], 'A Photoshop block whose structure carries text around amber IPTC.');

  // XMP
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="PROBE-TOOLKIT-aa8"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
    + '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:q="urn:PROBE-NS-aa5">'
    + '<xmp:CreatorTool xml:lang="x-PROBE-LANG-aa1">GIMP</xmp:CreatorTool>'
    + '<xmp:CreateDate rdf:datatype="urn:PROBE-DATATYPE-aa2">2024-01-01T00:00:00</xmp:CreateDate>'
    + '<xmp:ModifyDate rdf:ID="PROBE-RDFID-aa3">2024-01-01T00:00:00</xmp:ModifyDate>'
    + '<xmp:MetadataDate rdf:parseType="Resource"><rdf:value>2024-01-01T00:00:00</rdf:value><q:note>PROBE-QUAL-aa4</q:note></xmp:MetadataDate>'
    + '<tiff:Model>Canon 5D\t\t \n PROBE-WS-ab1</tiff:Model>'
    + '<exif:RelatedSoundFile>PROBE-XSOUND-aa6</exif:RelatedSoundFile>'
    + '<tiff:Make>PROBE Visible XMake aa7</tiff:Make>'
    + '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const fake = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + '<rdf:Description rdf:about="" xmlns:xmp="urn:PROBE-FAKENS-aa9" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Make="Canon"><xmp:CreateDate>2024-01-01T00:00:00</xmp:CreateDate></rdf:Description>'
    + '</rdf:RDF></x:xmpmeta>';
  add('probe-xmp.jpg', F.jpegInsert(jpg, F.jpegSeg(0xe1, F.u8('http://ns.adobe.com/xap/1.0/\0', Buffer.from(xmp, 'utf8')))), [
    red('PROBE-LANG-aa1', 'xml:lang on xmp:CreatorTool'),
    red('PROBE-DATATYPE-aa2', 'rdf:datatype on xmp:CreateDate'),
    red('PROBE-RDFID-aa3', 'rdf:ID on xmp:ModifyDate'),
    red('PROBE-QUAL-aa4', 'a qualifier in an unknown namespace on xmp:MetadataDate'),
    red('PROBE-NS-aa5', 'the address of that namespace'),
    red('PROBE-XSOUND-aa6', 'exif:RelatedSoundFile in XMP'),
    amber('PROBE Visible XMake aa7', 'tiff:Make: a short, well-formed name, shown as amber'),
    red('PROBE-TOOLKIT-aa8', 'the x:xmptk toolkit name'),
    red('PROBE-WS-ab1', 'tiff:Model with tabs and line breaks inside'),
  ], 'XMP date and device fields carrying attributes, qualifiers and white space, and a toolkit name.');
  add('probe-xmp-fakens.jpg', F.jpegInsert(jpg, F.jpegSeg(0xe1, F.u8('http://ns.adobe.com/xap/1.0/\0', Buffer.from(fake, 'utf8')))), [
    red('PROBE-FAKENS-aa9', 'the prefix xmp bound to another address, on a date'),
  ], 'A date under the usual prefix of XMP but in a namespace of its own.');

  // HEIC (built like an iPhone HDR photo)
  const heic = (name, opts, canaries, note) => { F.appleHdrHeic(name, opts); add(name, F.read(name), canaries, note); };
  heic('probe-heic-auxc.heic', { auxType: 'urn:mpeg:hevc:2015:auxid:2', auxTail: 'PROBE-AUXTAIL-ba1\0' }, [
    red('PROBE-AUXTAIL-ba1', 'text after an MPEG auxiliary image name'),
  ], 'A depth layer name followed by text.');
  heic('probe-heic-structure.heic', { hdlrName: 'PROBE-HDLR-ba2', ftypMinor: 'PRBm', brands: ['mif1', 'heic', 'PRBb'], names: { 1: 'PROBE-NAME-ba4' }, exifHead: 'PRBEXF' }, [
    red('PROBE-HDLR-ba2', 'the handler name in hdlr'),
    red('PRBm', 'the minor version in ftyp'),
    red('PRBb', 'an unknown brand in ftyp'),
    red('PROBE-NAME-ba4', "the picture's item name"),
    red('PRBEXF', 'the bytes before the TIFF header of the EXIF item'),
  ], 'HEIC structure fields no reader needs.');
  const crtt = F.isoFullBox('crtt', 0, 0, Buffer.alloc(8, 1), 'PROBE-CRTT-ba5');
  heic('probe-heic-crtt.heic', { extraProps: [crtt] }, [
    red('PROBE-CRTT-ba5', 'bytes after the time in a crtt property'),
  ], 'A creation time property longer than one time.');
  heic('probe-heic-aux-unhidden.heic', { auxType: 'urn:example:PROBE-AUX-ba7', auxHidden: false }, [
    red('PROBE-AUX-ba7', 'an auxiliary image with an unknown label, not marked hidden'),
  ], 'A layer with an unknown label whose item is not hidden; removing it must not leave a broken second picture.');

  // WebP
  const wbase = 'probe-base-203.webp';
  if (!existsSync(F.path(wbase))) {
    F.magick(['-size', '64x48', 'plasma:fractal', '-seed', '203', '-depth', '8', '-quality', '80', F.path(wbase)]);
    F.exiftoolWrite(F.path(wbase), ['-EXIF:Make=Canon']);
  }
  const webp = F.webpChunks(F.read(wbase)).map((c) => (c.type === 'EXIF' ? F.webpChunk('EXIF', F.u8('PRBWEBP', c.data)) : c.raw));
  add('probe-webp-exif-prefix.webp', F.webpRebuild(webp), [red('PRBWEBP', 'bytes before the TIFF header of the WebP EXIF chunk')], 'A WebP EXIF chunk with bytes before its TIFF header.');

  // Content Credentials: every manifest is red since the review.
  const jumbf = (json) => {
    const box = (type, body) => F.u8([0, 0, (body.length + 8) >> 8, (body.length + 8) & 255], type, body);
    const jumd = box('jumd', F.u8(Buffer.from('6332706100110010800000aa00389b71', 'hex'), [3], 'c2pa\0'));
    return F.u8('JP', [0, 1], [0, 0, 0, 1], box('jumb', F.u8(jumd, box('json', T(json)))));
  };
  add('probe-c2pa.jpg', F.jpegInsert(jpg, F.jpegSeg(0xeb, jumbf('{"claim_generator":"PROBE-GEN-ca1","ingredients":[{"name":"PROBE-INGREDIENT-ca2.jpg"}]}'))), [
    red('PROBE-GEN-ca1', 'the claim generator name in Content Credentials'),
    red('PROBE-INGREDIENT-ca2', 'an ingredient name in Content Credentials'),
  ], 'Content Credentials whose free text no keyword search would flag.');
  return list;
}
