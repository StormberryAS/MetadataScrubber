// Content Credentials (C2PA) manifests, as found in JPEG APP11, PNG caBX, WebP C2PA and
// HEIC uuid boxes.
//
// The manifest is signed, so it is never edited: it is kept or removed whole. Most
// manifests only describe the device and the edits (amber, as the spec says). Some also
// repeat the GPS position, a serial number, the author's name or the computer's name in
// their assertions (stds.exif, schema.org CreativeWork, CAWG identity); those are red,
// because keeping them would undo removing the same details elsewhere.

import { formatBytes, latin1 } from './bytes.js?v=b373c219';

const LOCATION = /GPS(?:Latitude|Longitude|Altitude|Position|Coordinates)|"?exif:GPS|LocationCreated|LocationShown/;
const SERIAL = /SerialNumber|BodySerial|LensSerial|CameraSerial/;
const PERSON = /stds\.schema-org\.CreativeWork|cawg\.identity|"Person"|\bPerson\b|"author"|\bauthor\b|CameraOwnerName|OwnerName/;
const COMPUTER = /HostComputer/;

// Describes one manifest (all its bytes, any number of parts). Returns
// { tier, value, note } for the item.
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
  const size = formatBytes(total);
  if (!found.length) {
    return {
      tier: 'amber',
      value: `Signed record of origin and edits, ${size}`,
      note: 'Removing them also removes the proof of where the image came from.',
    };
  }
  return {
    tier: 'red',
    value: `Signed record of origin and edits, includes ${found.join(', ')}, ${size}`,
    note: 'They repeat details such as the place, serial numbers or names. Removing them also removes the proof of where the image came from.',
  };
}
