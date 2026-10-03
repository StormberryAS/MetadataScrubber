// Reads the human-readable description of an ICC colour profile.

import { clip, latin1, startsWith, u32be } from './bytes.js?v=b373c219';

export function iccDescription(b) {
  if (!b || b.length < 132 || !startsWith(b, 36, 'acsp')) return 'Colour profile';
  const count = u32be(b, 128);
  for (let i = 0; i < Math.min(count, 200); i++) {
    const e = 132 + i * 12;
    if (e + 12 > b.length) break;
    if (!startsWith(b, e, 'desc')) continue;
    const off = u32be(b, e + 4);
    const size = u32be(b, e + 8);
    if (off + size > b.length || size < 12) break;
    if (startsWith(b, off, 'desc')) {
      const n = u32be(b, off + 8);
      return clip(latin1(b, off + 12, Math.min(off + 12 + n, off + size)).replace(/\0[\s\S]*$/, '')) || 'Colour profile';
    }
    if (startsWith(b, off, 'mluc')) {
      const records = u32be(b, off + 8);
      if (!records) break;
      const len = u32be(b, off + 20);
      const start = off + u32be(b, off + 24);
      let s = '';
      for (let j = start; j + 1 < Math.min(start + len, b.length); j += 2) s += String.fromCharCode((b[j] << 8) | b[j + 1]);
      return clip(s.replace(/\0[\s\S]*$/, '')) || 'Colour profile';
    }
  }
  return 'Colour profile';
}
