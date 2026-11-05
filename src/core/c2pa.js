/*! src/core/c2pa.js is compiled from ts/src/core/c2pa.ts by tools/build-ts.sh, which leaves out
    every comment but this one: the explanations are in the source. Edit the TypeScript, never the
    .js: the build refuses to overwrite a hand edit, and its check mode fails on one. */
import { formatBytes, latin1 } from './bytes.js?v=987761c7';
const LOCATION = /GPS(?:Latitude|Longitude|Altitude|Position|Coordinates)|"?exif:GPS|LocationCreated|LocationShown/;
const SERIAL = /SerialNumber|BodySerial|LensSerial|CameraSerial/;
const PERSON = /stds\.schema-org\.CreativeWork|cawg\.identity|"Person"|\bPerson\b|"author"|\bauthor\b|CameraOwnerName|OwnerName/;
const COMPUTER = /HostComputer/;
const FREE_TEXT = /dc:title|dc:description|dc:subject|\btitle\b|\bdescription\b|\bcaption\b|\bheadline\b|\bkeywords\b|\bcomment\b|\balt_?text\b|\balternativeText\b/i;
export function describeC2pa(parts) {
    let total = 0;
    let text = '';
    for (const p of parts) {
        total += p.length;
        text += latin1(p, 0, Math.min(p.length, 4 * 1024 * 1024));
    }
    const found = [];
    if (LOCATION.test(text))
        found.push('location');
    if (SERIAL.test(text))
        found.push('serial number');
    if (PERSON.test(text))
        found.push('names');
    if (COMPUTER.test(text))
        found.push('computer name');
    if (FREE_TEXT.test(text))
        found.push('titles or descriptions');
    if (/c2pa\.thumbnail/.test(text))
        found.push('a preview of the original picture');
    const size = formatBytes(total);
    return {
        tier: 'red',
        value: `Signed record of origin and edits${found.length ? `, includes ${found.join(', ')}` : ''}, ${size}`,
        note: "They can hold names, titles, the signer's certificate, a unique ID that links the picture to its original, and a preview of the original picture. Removing them also removes the proof of where the image came from.",
    };
}
