// Content Credentials (C2PA) manifests, as found in JPEG APP11, PNG caBX, WebP C2PA and
// HEIC uuid boxes.
//
// The manifest is signed, so it is never edited: it is kept or removed whole. Since 0.0.3
// (decision 6: anything that can hold a person's name is red) it is always red. Every
// manifest can name people: the signer's certificate (a person's name for a personal
// signing identity), the claim generator's free-text name, ingredient names and titles
// (usually file names), custom assertions and compressed (brob) assertions no text search
// can read, and a thumbnail of the parent picture, which may be the uncropped original.
// Each manifest also carries a unique identifier that links the file to its original, as
// the XMP document IDs do. What the manifest is seen to repeat is still named in the value.

import { formatBytes, latin1 } from './bytes.js?v=4d7df4d3';

const LOCATION = /GPS(?:Latitude|Longitude|Altitude|Position|Coordinates)|"?exif:GPS|LocationCreated|LocationShown/;
const SERIAL = /SerialNumber|BodySerial|LensSerial|CameraSerial/;
const PERSON = /stds\.schema-org\.CreativeWork|cawg\.identity|"Person"|\bPerson\b|"author"|\bauthor\b|CameraOwnerName|OwnerName/;
const COMPUTER = /HostComputer/;
const FREE_TEXT = /dc:title|dc:description|dc:subject|\btitle\b|\bdescription\b|\bcaption\b|\bheadline\b|\bkeywords\b|\bcomment\b|\balt_?text\b|\balternativeText\b/i;

// Describes one manifest (all its bytes, any number of parts). Returns
// { tier, value, note } for the item; tier is always red.
export function describeC2pa(parts) {
  let total = 0;
  let text = '';
  for (const p of parts) {
    total += p.length;
    // Text strings inside JSON and CBOR are plain UTF-8, so a Latin-1 view finds the keys.
    text += latin1(p, 0, Math.min(p.length, 4 * 1024 * 1024));
  }
  const found = [];
  if (LOCATION.test(text)) found.push('location');
  if (SERIAL.test(text)) found.push('serial number');
  if (PERSON.test(text)) found.push('names');
  if (COMPUTER.test(text)) found.push('computer name');
  if (FREE_TEXT.test(text)) found.push('titles or descriptions');
  if (/c2pa\.thumbnail/.test(text)) found.push('a preview of the original picture');
  const size = formatBytes(total);
  return {
    tier: 'red',
    value: `Signed record of origin and edits${found.length ? `, includes ${found.join(', ')}` : ''}, ${size}`,
    note: "They can hold names, titles, the signer's certificate, a unique ID that links the picture to its original, and a preview of the original picture. Removing them also removes the proof of where the image came from.",
  };
}
