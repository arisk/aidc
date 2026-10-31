import { CSET32, CSET82, firstInvalidChar } from './cset.ts';
import { Gs1Error } from './errors.ts';

/** Mod 10 check digit with 3-1 weighting from the right. Caller guarantees ASCII digits. */
export function mod10(digits: string): number {
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += (digits.charCodeAt(i) - 48) * weight;
    weight = 4 - weight;
  }
  return (10 - (sum % 10)) % 10;
}

export function checkDigit(digitsWithoutCheck: string): string {
  if (digitsWithoutCheck.length === 0) {
    throw new Gs1Error({
      code: 'INVALID_LENGTH',
      message: 'No digits to calculate a check digit for',
    });
  }
  const bad = firstInvalidChar(digitsWithoutCheck, 'N');
  if (bad !== -1) {
    throw new Gs1Error({
      code: 'INVALID_CHAR',
      message: 'A non-digit character was found',
      position: bad,
      length: 1,
    });
  }
  return String(mod10(digitsWithoutCheck));
}

export function isValidCheckDigit(digitsWithCheck: string): boolean {
  const n = digitsWithCheck.length;
  if (n < 2 || firstInvalidChar(digitsWithCheck, 'N') !== -1) return false;
  return mod10(digitsWithCheck.slice(0, n - 1)) === digitsWithCheck.charCodeAt(n - 1) - 48;
}

const PRIMES: readonly number[] = [
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
  101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193,
  197, 199, 211, 223, 227, 229, 233, 239, 241, 251, 257, 263, 269, 271, 277, 281, 283, 293, 307,
  311, 313, 317, 331, 337, 347, 349, 353, 359, 367, 373, 379, 383, 389, 397, 401, 409, 419, 421,
  431, 433, 439, 443, 449, 457, 461, 463, 467, 479, 487, 491, 499, 503, 509,
];

const CSET82_INDEX: Int8Array = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < CSET82.length; i++) t[CSET82.charCodeAt(i)] = i;
  return t;
})();

/** Check character pair for GMN (AI 8013). Throws Gs1Error on invalid input. */
export function checkCharacterPair(data: string): string {
  if (data.length > PRIMES.length) {
    throw new Gs1Error({
      code: 'INVALID_LENGTH',
      message: `Data longer than ${PRIMES.length} characters`,
      position: 0,
      length: data.length,
    });
  }
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    const v = CSET82_INDEX[c] ?? -1;
    if (v < 0) {
      throw new Gs1Error({
        code: 'INVALID_CHAR',
        message: 'A non-CSET 82 character was found',
        position: i,
        length: 1,
      });
    }
    sum += v * (PRIMES[data.length - 1 - i] ?? 0);
  }
  sum %= 1021;
  return `${CSET32[sum >> 5]}${CSET32[sum & 31]}`;
}

export function isValidCheckCharacterPair(dataWithPair: string): boolean {
  const n = dataWithPair.length;
  if (n < 2) return false;
  try {
    return checkCharacterPair(dataWithPair.slice(0, n - 2)) === dataWithPair.slice(n - 2);
  } catch {
    return false;
  }
}
