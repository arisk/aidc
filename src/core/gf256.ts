import { Gs1Error } from './errors.ts';

/** The field GF(2^8) for one primitive polynomial; alpha is 2. */
export interface Gf256 {
  readonly poly: number;
  /** exp[i] = alpha^i, doubled to 512 entries so exp[log a + log b] needs no modulo. */
  readonly exp: Uint8Array;
  /** log[a] = i with alpha^i = a; log[0] is unused. */
  readonly log: Uint8Array;
}

/** Data Matrix ECC 200: x^8 + x^5 + x^3 + x^2 + 1. */
export const DM_POLY: number = 0x12d;
/** QR Code: x^8 + x^4 + x^3 + x^2 + 1. */
export const QR_POLY: number = 0x11d;

const fields = new Map<number, Gf256>();

/** The field for `poly`, memoised. Throws INVALID_VALUE unless `poly` is a primitive degree-8 polynomial. */
export function gf256(poly: number): Gf256 {
  const cached = fields.get(poly);
  if (cached) return cached;
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  let valid = Number.isInteger(poly) && poly >= 0x100 && poly <= 0x1ff;
  if (valid) {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      // alpha^i must not revisit 1 or reach 0 before the full period of 255.
      if (x === 0 || (i > 0 && x === 1)) {
        valid = false;
        break;
      }
      exp[i] = x;
      log[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= poly;
    }
    if (valid && x !== 1) valid = false;
  }
  if (!valid) {
    throw new Gs1Error({
      code: 'INVALID_VALUE',
      message: `0x${Number.isFinite(poly) ? poly.toString(16) : String(poly)} is not a primitive polynomial of degree 8`,
      details: { option: 'poly', value: poly },
    });
  }
  for (let i = 255; i < 512; i++) exp[i] = byteAt(exp, i - 255);
  const field: Gf256 = { poly, exp, log };
  fields.set(poly, field);
  return field;
}

/** Byte `i` of `a`; 0 outside the array (the tables and blocks are always indexed in range). */
export function byteAt(a: Uint8Array, i: number): number {
  return a[i] ?? 0;
}

export function gfMul(f: Gf256, a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return byteAt(f.exp, byteAt(f.log, a) + byteAt(f.log, b));
}
