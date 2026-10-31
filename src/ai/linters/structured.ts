// Ported to TypeScript from gs1-syntax-dictionary src/lint_*.c @ c63d8a1 (Apache-2.0, Copyright (c) 2022-2026 GS1 AISBL); modified for aidc.
// Covers: lint_pcenc.c, lint_latitude.c, lint_longitude.c, lint_pieceoftotal.c, lint_posinseqslash.c, lint_iban.c.
import { iso3166alpha2 } from './codes.ts';
import { type Linter, err, firstNonDigit, isDigitCode } from './types.ts';

function isHex(c: number): boolean {
  return isDigitCode(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

/** lint_pcenc.c: every '%' must be followed by two hex digits. */
export const pcenc: Linter = (data) => {
  for (let pos = 0; pos < data.length; pos++) {
    if (data.charCodeAt(pos) !== 37) continue;
    if (pos + 2 >= data.length) return err('INVALID_PERCENT_SEQUENCE', pos, data.length - pos);
    if (!isHex(data.charCodeAt(pos + 1)) || !isHex(data.charCodeAt(pos + 2))) {
      return err('INVALID_PERCENT_SEQUENCE', pos, 3);
    }
    pos += 2;
  }
  return null;
};

/** lint_latitude.c */
export const latitude: Linter = (data) => {
  if (data.length !== 10) return err('LATITUDE_INVALID_LENGTH', 0, data.length);
  const bad = firstNonDigit(data);
  if (bad !== -1) return err('NON_DIGIT_CHARACTER', bad, 1);
  return Number(data) > 1_800_000_000 ? err('INVALID_LATITUDE', 0, 10) : null;
};

/** lint_longitude.c */
export const longitude: Linter = (data) => {
  if (data.length !== 10) return err('LONGITUDE_INVALID_LENGTH', 0, data.length);
  const bad = firstNonDigit(data);
  if (bad !== -1) return err('NON_DIGIT_CHARACTER', bad, 1);
  return Number(data) > 3_600_000_000 ? err('INVALID_LONGITUDE', 0, 10) : null;
};

/** lint_pieceoftotal.c: digits are compared as strings, so length is unbounded. */
export const pieceoftotal: Linter = (data) => {
  const bad = firstNonDigit(data);
  if (bad !== -1) return err('NON_DIGIT_CHARACTER', bad, 1);
  if (data.length === 0 || data.length % 2 !== 0) {
    return err('INVALID_LENGTH_FOR_PIECE_OF_TOTAL', 0, data.length);
  }
  const half = data.length / 2;
  const piece = data.slice(0, half);
  const total = data.slice(half);
  const zeros = '0'.repeat(half);
  if (piece === zeros) return err('ZERO_PIECE_NUMBER', 0, half);
  if (total === zeros) return err('ZERO_TOTAL_PIECES', half, half);
  return piece > total ? err('PIECE_NUMBER_EXCEEDS_TOTAL', 0, data.length) : null;
};

/** lint_posinseqslash.c: "<pos>/<end>", both without zero prefix, pos <= end. */
export const posinseqslash: Linter = (data) => {
  const len = data.length;
  let pos = 0;
  while (pos < len && isDigitCode(data.charCodeAt(pos))) pos++;
  if (pos === 0 || pos >= len || data[pos] !== '/') {
    return err('POSITION_IN_SEQUENCE_MALFORMED', 0, len);
  }
  const slash = pos;
  if (firstNonDigit(data, slash + 1) !== -1 || slash >= len - 1) {
    return err('POSITION_IN_SEQUENCE_MALFORMED', 0, len);
  }
  if (data[0] === '0') return err('ILLEGAL_ZERO_PREFIX', 0, slash);
  if (data[slash + 1] === '0') return err('ILLEGAL_ZERO_PREFIX', slash + 1, len - slash - 1);
  const endLen = len - slash - 1;
  // With equal lengths and no zero prefix, a string comparison is numeric.
  const exceeds = slash === endLen ? data.slice(0, slash) > data.slice(slash + 1) : slash > endLen;
  return exceeds ? err('POSITION_EXCEEDS_END', 0, len) : null;
};

const IBAN_MIN_LENGTH = 10;
const IBAN_MAX_LENGTH = 34;

/** lint_iban.c: weight is 1 + value, with letters A-Z valued 10-35. */
function ibanWeight(c: number): number {
  if (isDigitCode(c)) return c - 48 + 1;
  if (c >= 65 && c <= 90) return c - 65 + 11;
  return 0;
}

/** lint_iban.c */
export const iban: Linter = (data) => {
  const len = data.length;
  if (len < 4) return err('IBAN_TOO_SHORT', 0, len);
  if (iso3166alpha2(data.slice(0, 2)) !== null) return err('ILLEGAL_IBAN_COUNTRY_CODE', 0, 2);
  if (len > IBAN_MAX_LENGTH) return err('IBAN_TOO_LONG', 0, len);
  if (len <= IBAN_MIN_LENGTH) return err('IBAN_TOO_SHORT', 0, len);
  let csum = 0;
  for (let pos = 4; pos < len + 4; pos++) {
    const actual = pos < len ? pos : pos - len;
    const weight = ibanWeight(data.charCodeAt(actual));
    if (weight === 0) return err('INVALID_IBAN_CHARACTER', actual, 1);
    csum = (csum * (weight <= 10 ? 10 : 100) + weight - 1) % 97;
  }
  return csum === 1 ? null : err('INCORRECT_IBAN_CHECKSUM', 2, 2);
};
