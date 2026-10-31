// Ported to TypeScript from gs1-syntax-dictionary src/lint_*.c @ c63d8a1 (Apache-2.0, Copyright (c) 2022-2026 GS1 AISBL); modified for aidc.
// Covers: lint_csum.c, lint_csumalpha.c, lint_gcppos1.c, lint_gcppos2.c.
import { mod10 } from '../../core/check-digit.ts';
import { CSET32, CSET82 } from '../../core/cset.ts';
import { type Linter, err, firstNonDigit, isDigitCode, shift } from './types.ts';

export const csum: Linter = (data) => {
  if (data.length === 0) return err('TOO_SHORT_FOR_CHECK_DIGIT', 0, 0);
  const bad = firstNonDigit(data);
  if (bad !== -1) return err('NON_DIGIT_CHARACTER', bad, 1);
  const n = data.length;
  return mod10(data.slice(0, n - 1)) === data.charCodeAt(n - 1) - 48
    ? null
    : err('INCORRECT_CHECK_DIGIT', n - 1, 1);
};

const PRIMES_COUNT = 97;
const PRIMES: readonly number[] = [
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
  101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193,
  197, 199, 211, 223, 227, 229, 233, 239, 241, 251, 257, 263, 269, 271, 277, 281, 283, 293, 307,
  311, 313, 317, 331, 337, 347, 349, 353, 359, 367, 373, 379, 383, 389, 397, 401, 409, 419, 421,
  431, 433, 439, 443, 449, 457, 461, 463, 467, 479, 487, 491, 499, 503, 509,
];
const WEIGHT: Uint8Array = (() => {
  const t = new Uint8Array(128);
  for (let i = 0; i < CSET82.length; i++) t[CSET82.charCodeAt(i)] = i + 1;
  return t;
})();

export const csumalpha: Linter = (data) => {
  const n = data.length;
  if (n > PRIMES_COUNT + 2) return err('TOO_LONG_FOR_CHECK_PAIR_IMPLEMENTATION', 0, n);
  if (n < 2) return err('TOO_SHORT_FOR_CHECK_PAIR', 0, n);
  if (n === 2) return data === '22' ? null : err('INCORRECT_CHECK_PAIR', 0, 2);
  let sum = 0;
  for (let i = 0; i < n - 2; i++) {
    const c = data.charCodeAt(i);
    const w = c < 128 ? Number(WEIGHT[c]) : 0;
    if (w === 0) return err('INVALID_CSET82_CHARACTER', i, 1);
    sum += (w - 1) * Number(PRIMES[n - 3 - i]);
  }
  sum %= 1021;
  return data[n - 2] === CSET32[sum >> 5] && data[n - 1] === CSET32[sum & 31]
    ? null
    : err('INCORRECT_CHECK_PAIR', n - 2, 2);
};

const GCP_MIN_LENGTH = 4;

export const gcppos1: Linter = (data) => {
  if (data.length < GCP_MIN_LENGTH) return err('TOO_SHORT_FOR_GCP', 0, data.length);
  for (let i = 0; i < GCP_MIN_LENGTH; i++) {
    if (!isDigitCode(data.charCodeAt(i))) return err('INVALID_GCP_PREFIX', i, 1);
  }
  return null;
};

export const gcppos2: Linter = (data) => {
  if (data.length < 2) return err('TOO_SHORT_FOR_GCP', 0, data.length);
  return shift(gcppos1(data.slice(1)), 1);
};
