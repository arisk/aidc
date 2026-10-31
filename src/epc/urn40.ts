/**
 * URN Code 40 (TDS Table 14-8), shared by the ALN method (14.5.6.5) and the "++" hostname
 * (14.5.16.1.1). Three characters per 16-bit group, r = 1600 * i1 + 40 * i2 + i3 + 1, the last
 * group padded with PAD (index 0).
 */
import type { BitReader, BitWriter } from '../core/bits.ts';

/** Table 14-8: index 0 is PAD. */
const URN40 = '\0ABCDEFGHIJKLMNOPQRSTUVWXYZ-.:0123456789';

const INDEX: Int8Array = /* @__PURE__ */ (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 1; i < URN40.length; i++) t[URN40.charCodeAt(i)] = i;
  return t;
})();

const indexOf = (c: number): number => (c < 128 ? (INDEX[c] ?? -1) : -1);

/** Whether `s` has only URN Code 40 characters (PAD excluded). */
export function isUrn40(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (indexOf(s.charCodeAt(i)) < 1) return false;
  return true;
}

/** Data bits of an `L`-character URN Code 40 string. */
export const urn40Bits = (L: number): number => 16 * Math.ceil(L / 3);

/** Writes `s`, which the caller has checked with `isUrn40`. */
export function writeUrn40(s: string, w: BitWriter): void {
  const L = s.length;
  for (let i = 0; i < L; i += 3) {
    const i1 = indexOf(s.charCodeAt(i));
    const i2 = i + 1 < L ? indexOf(s.charCodeAt(i + 1)) : 0;
    const i3 = i + 2 < L ? indexOf(s.charCodeAt(i + 2)) : 0;
    w.write(1600 * i1 + 40 * i2 + i3 + 1, 16);
  }
}

/**
 * Reads `L` characters. A group of 0 or over 64000, PAD inside the value, or padding other than
 * PAD calls `fail`. Throws RangeError when the bits run out.
 */
export function readUrn40(r: BitReader, L: number, fail: (message: string) => never): string {
  let out = '';
  for (let i = 0; i < L; i += 3) {
    const v = r.read(16);
    if (v === 0 || v > 64000) fail(`URN Code 40 value ${v} is out of range`);
    const n = v - 1;
    for (let k = 0, weight = 1600; k < 3; k++, weight /= 40) {
      const x = Math.floor(n / weight) % 40;
      if (i + k < L) {
        if (x === 0) fail('URN Code 40 PAD inside the value');
        out += URN40.charAt(x);
      } else if (x !== 0) fail('URN Code 40 padding is not PAD');
    }
  }
  return out;
}
