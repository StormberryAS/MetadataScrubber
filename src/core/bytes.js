// Small byte helpers shared by every format module.
//
// No DOM, no dependencies: this runs in browsers and in Node 24 alike.

// Always returns a plain Uint8Array. Subclasses such as Node's Buffer are re-wrapped,
// because Buffer#slice returns a view rather than a copy and the engine relies on
// slice() copying before it edits anything in place.
export function toU8(input) {
  if (input instanceof Uint8Array) {
    return input.constructor === Uint8Array ? input : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('Expected a Uint8Array or ArrayBuffer');
}

export const u16be = (b, p) => (b[p] << 8) | b[p + 1];
export const u16le = (b, p) => b[p] | (b[p + 1] << 8);
export const u32be = (b, p) => ((b[p] << 24) >>> 0) + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
export const u32le = (b, p) => ((b[p + 3] << 24) >>> 0) + ((b[p + 2] << 16) | (b[p + 1] << 8) | b[p]);

export function u64be(b, p) {
  return u32be(b, p) * 0x100000000 + u32be(b, p + 4);
}

export function w16be(b, p, v) { b[p] = (v >>> 8) & 255; b[p + 1] = v & 255; }
export function w32be(b, p, v) { b[p] = (v >>> 24) & 255; b[p + 1] = (v >>> 16) & 255; b[p + 2] = (v >>> 8) & 255; b[p + 3] = v & 255; }
export function w32le(b, p, v) { b[p] = v & 255; b[p + 1] = (v >>> 8) & 255; b[p + 2] = (v >>> 16) & 255; b[p + 3] = (v >>> 24) & 255; }
export function w24le(b, p, v) { b[p] = v & 255; b[p + 1] = (v >>> 8) & 255; b[p + 2] = (v >>> 16) & 255; }
export function w64be(b, p, v) {
  w32be(b, p, Math.floor(v / 0x100000000));
  w32be(b, p + 4, v >>> 0);
}

// Latin-1 decode, safe for large ranges.
export function latin1(b, start = 0, end = b.length) {
  let s = '';
  for (let i = start; i < end; i += 8192) {
    s += String.fromCharCode.apply(null, b.subarray(i, Math.min(end, i + 8192)));
  }
  return s;
}

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();
export const utf8 = (b, start = 0, end = b.length) => utf8Decoder.decode(b.subarray(start, end));
export const encodeUtf8 = (s) => utf8Encoder.encode(s);

export function encodeLatin1(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}

// Reads a NUL-terminated Latin-1 string; returns [text, positionAfterNul].
export function cstring(b, start, end = b.length) {
  let p = start;
  while (p < end && b[p] !== 0) p++;
  return [latin1(b, start, p), Math.min(p + 1, end)];
}

export function startsWith(b, pos, str) {
  if (pos + str.length > b.length) return false;
  for (let i = 0; i < str.length; i++) if (b[pos + i] !== str.charCodeAt(i)) return false;
  return true;
}

export function indexOfBytes(hay, needle, from = 0, to = hay.length) {
  const first = needle[0];
  const last = to - needle.length;
  outer: for (let i = from; i <= last; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export const indexOfAscii = (hay, str, from, to) => indexOfBytes(hay, encodeLatin1(str), from, to);

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Ordered list of output pieces, each either a range of the source or new bytes.
// Remembers where every source range landed so absolute offsets can be fixed later.
export class Assembler {
  constructor(src) { this.src = src; this.parts = []; this.length = 0; }
  copy(start, end) {
    if (end > start) { this.parts.push({ start, end, out: this.length }); this.length += end - start; }
  }
  add(bytes) {
    if (bytes.length) { this.parts.push({ bytes, out: this.length }); this.length += bytes.length; }
  }
  // Where a source position ended up in the output, or -1 when it was cut.
  map(pos) {
    for (const p of this.parts) {
      if (p.bytes === undefined && pos >= p.start && pos < p.end) return p.out + (pos - p.start);
    }
    return -1;
  }
  finish() {
    const out = new Uint8Array(this.length);
    for (const p of this.parts) {
      if (p.bytes !== undefined) out.set(p.bytes, p.out);
      else out.set(this.src.subarray(p.start, p.end), p.out);
    }
    return out;
  }
}

let crcTable = null;
export function crc32(b, start = 0, end = b.length) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function adler32(b) {
  let a = 1;
  let s = 0;
  for (let i = 0; i < b.length; i++) {
    a = (a + b[i]) % 65521;
    s = (s + a) % 65521;
  }
  return ((s << 16) | a) >>> 0;
}

// zlib stream made of stored (uncompressed) blocks. Valid for any inflater and needs no
// compressor, which keeps rewritten text chunks simple and fully auditable.
export function zlibStored(data) {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const chunk = data.subarray(i * 65535, Math.min(data.length, (i + 1) * 65535));
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = chunk.length & 255; out[o++] = chunk.length >>> 8;
    out[o++] = ~chunk.length & 255; out[o++] = (~chunk.length >>> 8) & 255;
    out.set(chunk, o); o += chunk.length;
  }
  w32be(out, o, adler32(data));
  return out;
}

const MAX_INFLATE = 64 * 1024 * 1024;
const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

// Inflates a zlib stream. Node uses node:zlib; browsers use DecompressionStream.
// Returns null when the data is not valid zlib, or when anything follows the end of the
// stream: such bytes are skipped by readers and could hold anything. DecompressionStream
// refuses them by itself; in Node the bytes the inflater used are counted.
export async function inflate(data) {
  if (isNode) {
    try {
      const zlib = await import('node:zlib');
      const res = zlib.inflateSync(data, { maxOutputLength: MAX_INFLATE, info: true });
      if (res.engine.bytesWritten !== data.length) return null;
      return new Uint8Array(res.buffer);
    } catch {
      return null;
    }
  }
  if (typeof DecompressionStream !== 'function') return null;
  try {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(data).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_INFLATE) { reader.cancel().catch(() => {}); return null; }
      parts.push(value);
    }
    return concat(parts);
  } catch {
    return null;
  }
}

export function hexDecode(text) {
  const clean = text.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function hexEncodeLines(bytes, perLine = 36) {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += hex[bytes[i] >> 4] + hex[bytes[i] & 15];
    if ((i + 1) % perLine === 0) s += '\n';
  }
  return s;
}

export function clip(text, max = 80) {
  const t = String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 3).trimEnd() + '...' : t;
}

export function formatBytes(n) {
  if (n < 1000) return `${n} bytes`;
  if (n < 1000000) return `${(n / 1000).toFixed(1)} KB`;
  return `${(n / 1000000).toFixed(1)} MB`;
}

// Sorts [start, end) ranges and merges the ones that touch or overlap.
export function mergeRanges(list) {
  const sorted = list.filter(([s, e]) => e > s).map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

// The parts of `ranges` not covered by `minus`, as sorted, merged [start, end) ranges.
// One sweep over both sorted lists, so thousands of ranges stay fast.
export function subtractRanges(ranges, minus) {
  const a = mergeRanges(ranges);
  const m = mergeRanges(minus);
  const out = [];
  let j = 0;
  for (const [s, e] of a) {
    while (j < m.length && m[j][1] <= s) j++;
    let p = s;
    let k = j;
    while (k < m.length && m[k][0] < e) {
      if (m[k][0] > p) out.push([p, m[k][0]]);
      p = Math.max(p, m[k][1]);
      if (m[k][1] >= e) break;
      k++;
    }
    if (p < e) out.push([p, e]);
  }
  return out;
}

// Zeroes the [start, end) ranges, except the parts covered by the protected ones.
export function zeroRanges(buf, ranges, keep = []) {
  const clip = (list) => list.map(([s, e]) => [Math.max(0, s), Math.min(buf.length, e)]);
  for (const [s, e] of subtractRanges(clip(ranges), clip(keep))) buf.fill(0, s, e);
}
