import { Gs1Error } from './errors.ts';
import { type Gf256, byteAt, gfMul } from './gf256.ts';

/**
 * Reed-Solomon over GF(2^8) with generator roots alpha^firstRoot .. alpha^(firstRoot + ec - 1).
 * Codeword order: the first data codeword is the highest-degree coefficient; parity follows.
 */

const generators = new Map<string, Uint8Array>();

function checkParams(ecLength: number, firstRoot: number): void {
  if (!Number.isInteger(ecLength) || ecLength < 0 || ecLength > 254) {
    throw new Gs1Error({
      code: 'INVALID_VALUE',
      message: `ecLength must be an integer from 0 to 254, got ${ecLength}`,
      details: { option: 'ecLength', value: ecLength },
    });
  }
  if (!Number.isInteger(firstRoot) || firstRoot < 0 || firstRoot > 254) {
    throw new Gs1Error({
      code: 'INVALID_VALUE',
      message: `firstRoot must be an integer from 0 to 254, got ${firstRoot}`,
      details: { option: 'firstRoot', value: firstRoot },
    });
  }
}

/** The monic generator polynomial, highest degree first (ecLength + 1 coefficients). Cached. */
export function rsGenerator(f: Gf256, ecLength: number, firstRoot: number): Uint8Array {
  checkParams(ecLength, firstRoot);
  const key = `${f.poly}:${ecLength}:${firstRoot}`;
  const cached = generators.get(key);
  if (cached) return cached;
  const g = new Uint8Array(ecLength + 1);
  g[0] = 1;
  for (let i = 0; i < ecLength; i++) {
    // Multiply by (x + alpha^(firstRoot + i)); characteristic 2, so minus is plus.
    const root = byteAt(f.exp, (firstRoot + i) % 255);
    for (let j = i + 1; j >= 1; j--) {
      g[j] = byteAt(g, j) ^ gfMul(f, byteAt(g, j - 1), root);
    }
  }
  generators.set(key, g);
  return g;
}

/** The `ecLength` parity codewords for `data`, by LFSR division with the generator. */
export function rsEncode(
  f: Gf256,
  data: Uint8Array,
  ecLength: number,
  firstRoot: number,
): Uint8Array {
  const g = rsGenerator(f, ecLength, firstRoot);
  const rem = new Uint8Array(ecLength);
  if (ecLength === 0) return rem;
  for (let i = 0; i < data.length; i++) {
    const factor = byteAt(data, i) ^ byteAt(rem, 0);
    rem.copyWithin(0, 1);
    rem[ecLength - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLength; j++) {
        rem[j] = byteAt(rem, j) ^ gfMul(f, factor, byteAt(g, j + 1));
      }
    }
  }
  return rem;
}

/** Syndromes S_j = r(alpha^(firstRoot + j)); true when any is nonzero. */
function syndromes(
  f: Gf256,
  block: Uint8Array,
  ecLength: number,
  firstRoot: number,
  out: Uint8Array,
): boolean {
  let any = false;
  for (let j = 0; j < ecLength; j++) {
    const a = (firstRoot + j) % 255;
    let s = 0;
    for (let i = 0; i < block.length; i++) {
      s = (s === 0 ? 0 : byteAt(f.exp, byteAt(f.log, s) + a)) ^ byteAt(block, i);
    }
    out[j] = s;
    if (s !== 0) any = true;
  }
  return any;
}

/**
 * Corrects `block` (data then parity) in place and returns the number of corrected codewords.
 * Returns undefined (leaving the block untouched) when the parameters are invalid, when more than
 * min(maxErrors, floor(ecLength / 2)) codewords are wrong, or when no consistent correction exists.
 * Errors only, no erasures. Never throws.
 */
export function rsDecode(
  f: Gf256,
  block: Uint8Array,
  ecLength: number,
  firstRoot: number,
  maxErrors: number,
): number | undefined {
  const n = block.length;
  if (
    !Number.isInteger(ecLength) ||
    !Number.isInteger(firstRoot) ||
    ecLength < 0 ||
    ecLength > 254 ||
    ecLength > n ||
    n > 255 ||
    firstRoot < 0 ||
    firstRoot > 254 ||
    !(maxErrors >= 0)
  ) {
    return undefined;
  }
  const capacity = Math.min(Math.floor(maxErrors), ecLength >> 1);
  const s = new Uint8Array(ecLength);
  if (!syndromes(f, block, ecLength, firstRoot, s)) return 0;

  // Berlekamp-Massey: error locator lambda (lambda[0] = 1) of degree l.
  let lambda = new Uint8Array(ecLength + 1);
  let prev = new Uint8Array(ecLength + 1);
  lambda[0] = 1;
  prev[0] = 1;
  let l = 0;
  let gap = 1;
  let prevDisc = 1;
  for (let i = 0; i < ecLength; i++) {
    let disc = byteAt(s, i);
    for (let k = 1; k <= l; k++) {
      disc ^= gfMul(f, byteAt(lambda, k), byteAt(s, i - k));
    }
    if (disc === 0) {
      gap++;
      continue;
    }
    const scale = byteAt(f.exp, byteAt(f.log, disc) + 255 - byteAt(f.log, prevDisc));
    const before = lambda.slice();
    for (let k = 0; k + gap <= ecLength; k++) {
      lambda[k + gap] = byteAt(lambda, k + gap) ^ gfMul(f, scale, byteAt(prev, k));
    }
    if (2 * l <= i) {
      l = i + 1 - l;
      prev = before;
      prevDisc = disc;
      gap = 1;
    } else {
      gap++;
    }
  }
  if (l > capacity) return undefined;

  // Chien search over the block positions only. Position p (0 = first codeword) has locator
  // X = alpha^(n - 1 - p); it is an error when lambda(X^-1) = 0.
  const positions: number[] = [];
  for (let p = 0; p < n; p++) {
    const power = n - 1 - p;
    let sum = 0;
    for (let k = 0; k <= l; k++) {
      const c = byteAt(lambda, k);
      if (c !== 0) {
        sum ^= byteAt(f.exp, byteAt(f.log, c) + (((255 - (power % 255)) * k) % 255));
      }
    }
    if (sum === 0) positions.push(p);
  }
  if (positions.length !== l) return undefined;

  // omega(x) = S(x) lambda(x) mod x^ec.
  const omega = new Uint8Array(ecLength);
  for (let i = 0; i < ecLength; i++) {
    let acc = 0;
    for (let k = 0; k <= i && k <= l; k++) {
      acc ^= gfMul(f, byteAt(lambda, k), byteAt(s, i - k));
    }
    omega[i] = acc;
  }

  // Forney: e = X^(1 - firstRoot) * omega(X^-1) / lambda'(X^-1).
  const fixed = block.slice();
  for (const p of positions) {
    const power = n - 1 - p;
    const xInv = (255 - (power % 255)) % 255;
    let num = 0;
    for (let k = 0; k < ecLength; k++) {
      const c = byteAt(omega, k);
      if (c !== 0) num ^= byteAt(f.exp, byteAt(f.log, c) + ((xInv * k) % 255));
    }
    let den = 0;
    for (let k = 1; k <= l; k += 2) {
      const c = byteAt(lambda, k);
      if (c !== 0) den ^= byteAt(f.exp, byteAt(f.log, c) + ((xInv * (k - 1)) % 255));
    }
    if (den === 0) return undefined;
    // A zero numerator would be a zero error magnitude: not a valid correction.
    if (num === 0) return undefined;
    const shift = (((power * (1 - firstRoot)) % 255) + 255) % 255;
    const ratio = byteAt(f.exp, byteAt(f.log, num) + 255 - byteAt(f.log, den));
    const magnitude = gfMul(f, byteAt(f.exp, shift), ratio);
    fixed[p] = byteAt(fixed, p) ^ magnitude;
  }

  if (syndromes(f, fixed, ecLength, firstRoot, s)) return undefined;
  block.set(fixed);
  return positions.length;
}
