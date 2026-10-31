// Ported to TypeScript from gs1-syntax-dictionary src/lint_*.c @ c63d8a1 (Apache-2.0, Copyright (c) 2022-2026 GS1 AISBL); modified for aidc.
// Covers: lint_couponcode.c, lint_couponposoffer.c.
import type { LintCode } from './lint-codes.gen.ts';
import { yymmdd } from './datetime.ts';
import { type Linter, type LintResult, err, firstNonDigit } from './types.ts';

/**
 * Cursor over all-digit coupon data, mirroring the `p`/`q` pointers of the C code.
 * `p` is the current index and `q` the end of the data.
 */
class Cursor {
  p = 0;
  readonly q: number;
  constructor(len: number) {
    this.q = len;
  }
  get atEnd(): boolean {
    return this.p === this.q;
  }
  /** Error for a field whose leading character is absent: whole-data span. */
  missing(code: LintCode): LintResult {
    return err(code, 0, this.q);
  }
  /** Error for a field that is shorter than required: remainder, or whole data if none. */
  truncated(code: LintCode): LintResult {
    return this.p === this.q ? err(code, 0, this.q) : err(code, this.p, this.q - this.p);
  }
  /** Error spanning only the current character. */
  invalidHere(code: LintCode): LintResult {
    return err(code, this.p, 1);
  }
}

/** Value of the digit at index `i`, as `data[i] - '0'` in C. */
function digit(data: string, i: number): number {
  return data.charCodeAt(i) - 48;
}

// The C code lints each GCP with gcppos1 after the all-digits check. With digit-only data
// and a length of at least 6, gcppos1 (without a custom GCP lookup) cannot fail, so the
// call is omitted here and the GCP is only skipped.

/**
 * Validates a purchase requirement block: VLI (1-5) plus that many digits, a
 * one-digit requirement code (0-4 or 9), and a three-digit family code.
 */
function purchase(
  data: string,
  c: Cursor,
  codes: {
    missingVli: LintCode;
    invalidLen: LintCode;
    truncated: LintCode;
    missingCode: LintCode;
    invalidCode: LintCode;
    truncatedFamily: LintCode;
  },
): LintResult {
  if (c.atEnd) return c.missing(codes.missingVli);
  if (data[c.p]! < '1' || data[c.p]! > '5') return c.invalidHere(codes.invalidLen);
  const vli = digit(data, c.p);
  if (c.q - ++c.p < vli) return c.truncated(codes.truncated);
  c.p += vli;
  if (c.atEnd) return c.missing(codes.missingCode);
  if (data[c.p]! > '4' && data[c.p]! !== '9') return c.invalidHere(codes.invalidCode);
  if (c.q - ++c.p < 3) return c.truncated(codes.truncatedFamily);
  c.p += 3;
  return null;
}

/**
 * Validates an optional-purchase GCP: VLI 0-6 (length plus 6) or 9 (no GCP).
 */
function purchaseGcp(
  data: string,
  c: Cursor,
  codes: { missingVli: LintCode; invalidLen: LintCode; truncated: LintCode },
): LintResult {
  if (c.atEnd) return c.missing(codes.missingVli);
  if (data[c.p]! > '6' && data[c.p]! !== '9') return c.invalidHere(codes.invalidLen);
  const vli = data[c.p] !== '9' ? digit(data, c.p) + 6 : 0;
  if (c.q - ++c.p < vli) return c.truncated(codes.truncated);
  c.p += vli;
  return null;
}

/** lint_couponcode.c (AI 8110, North American Coupon Code). */
export const couponcode: Linter = (data) => {
  const bad = firstNonDigit(data);
  if (bad !== -1) return err('NON_DIGIT_CHARACTER', bad, 1);

  const c = new Cursor(data.length);
  let r: LintResult;
  let vli: number;

  // Primary GCP: VLI "0" to "6", length plus 6.
  if (c.atEnd) return c.missing('COUPON_MISSING_GCP_VLI');
  if (data[c.p]! > '6') return c.invalidHere('COUPON_INVALID_GCP_LENGTH');
  vli = digit(data, c.p) + 6;
  if (c.q - ++c.p < vli) return c.truncated('COUPON_TRUNCATED_GCP');
  c.p += vli;

  // Six digit Offer Code.
  if (c.q - c.p < 6) return c.truncated('COUPON_TRUNCATED_OFFER_CODE');
  c.p += 6;

  // Save Value: VLI "1" to "5".
  if (c.atEnd) return c.missing('COUPON_MISSING_SAVE_VALUE_VLI');
  if (data[c.p]! < '1' || data[c.p]! > '5')
    return c.invalidHere('COUPON_INVALID_SAVE_VALUE_LENGTH');
  vli = digit(data, c.p);
  if (c.q - ++c.p < vli) return c.truncated('COUPON_TRUNCATED_SAVE_VALUE');
  c.p += vli;

  // 1st Purchase Requirement, Requirement Code and Family Code.
  r = purchase(data, c, {
    missingVli: 'COUPON_MISSING_1ST_PURCHASE_REQUIREMENT_VLI',
    invalidLen: 'COUPON_INVALID_1ST_PURCHASE_REQUIREMENT_LENGTH',
    truncated: 'COUPON_TRUNCATED_1ST_PURCHASE_REQUIREMENT',
    missingCode: 'COUPON_MISSING_1ST_PURCHASE_REQUIREMENT_CODE',
    invalidCode: 'COUPON_INVALID_1ST_PURCHASE_REQUIREMENT_CODE',
    truncatedFamily: 'COUPON_TRUNCATED_1ST_PURCHASE_FAMILY_CODE',
  });
  if (r !== null) return r;

  // Optional field 1: Additional rules and 2nd purchase.
  if (c.p < c.q && data[c.p] === '1') {
    if (++c.p === c.q) return c.missing('COUPON_MISSING_ADDITIONAL_PURCHASE_RULES_CODE');
    if (data[c.p]! > '3') return c.invalidHere('COUPON_INVALID_ADDITIONAL_PURCHASE_RULES_CODE');
    c.p++;
    r = purchase(data, c, {
      missingVli: 'COUPON_MISSING_2ND_PURCHASE_REQUIREMENT_VLI',
      invalidLen: 'COUPON_INVALID_2ND_PURCHASE_REQUIREMENT_LENGTH',
      truncated: 'COUPON_TRUNCATED_2ND_PURCHASE_REQUIREMENT',
      missingCode: 'COUPON_MISSING_2ND_PURCHASE_REQUIREMENT_CODE',
      invalidCode: 'COUPON_INVALID_2ND_PURCHASE_REQUIREMENT_CODE',
      truncatedFamily: 'COUPON_TRUNCATED_2ND_PURCHASE_FAMILY_CODE',
    });
    if (r !== null) return r;
    r = purchaseGcp(data, c, {
      missingVli: 'COUPON_MISSING_2ND_PURCHASE_GCP_VLI',
      invalidLen: 'COUPON_INVALID_2ND_PURCHASE_GCP_LENGTH',
      truncated: 'COUPON_TRUNCATED_2ND_PURCHASE_GCP',
    });
    if (r !== null) return r;
  }

  // Optional field 2: 3rd purchase.
  if (c.p < c.q && data[c.p] === '2') {
    c.p++;
    r = purchase(data, c, {
      missingVli: 'COUPON_MISSING_3RD_PURCHASE_REQUIREMENT_VLI',
      invalidLen: 'COUPON_INVALID_3RD_PURCHASE_REQUIREMENT_LENGTH',
      truncated: 'COUPON_TRUNCATED_3RD_PURCHASE_REQUIREMENT',
      missingCode: 'COUPON_MISSING_3RD_PURCHASE_REQUIREMENT_CODE',
      invalidCode: 'COUPON_INVALID_3RD_PURCHASE_REQUIREMENT_CODE',
      truncatedFamily: 'COUPON_TRUNCATED_3RD_PURCHASE_FAMILY_CODE',
    });
    if (r !== null) return r;
    r = purchaseGcp(data, c, {
      missingVli: 'COUPON_MISSING_3RD_PURCHASE_GCP_VLI',
      invalidLen: 'COUPON_INVALID_3RD_PURCHASE_GCP_LENGTH',
      truncated: 'COUPON_TRUNCATED_3RD_PURCHASE_GCP',
    });
    if (r !== null) return r;
  }

  // Optional field 3: Expiration date (YYMMDD).
  let expiry: string | null = null;
  if (c.p < c.q && data[c.p] === '3') {
    if (c.q - ++c.p < 6) return c.truncated('COUPON_TOO_SHORT_FOR_EXPIRATION_DATE');
    expiry = data.slice(c.p, c.p + 6);
    if (yymmdd(expiry) !== null) return err('COUPON_INVALID_EXIPIRATION_DATE', c.p, 6);
    c.p += 6;
  }

  // Optional field 4: Start date (YYMMDD), which must not follow the expiration date.
  if (c.p < c.q && data[c.p] === '4') {
    if (c.q - ++c.p < 6) return c.truncated('COUPON_TOO_SHORT_FOR_START_DATE');
    const start = data.slice(c.p, c.p + 6);
    if (yymmdd(start) !== null) return err('COUPON_INVALID_START_DATE', c.p, 6);
    if (expiry !== null && start > expiry) {
      return err('COUPON_EXPIRATION_BEFORE_START', c.p - 8, 14);
    }
    c.p += 6;
  }

  // Optional field 5: Serial number, VLI plus 6.
  if (c.p < c.q && data[c.p] === '5') {
    if (++c.p === c.q) return c.missing('COUPON_MISSING_SERIAL_NUMBER_VLI');
    vli = digit(data, c.p) + 6;
    if (c.q - ++c.p < vli) return c.truncated('COUPON_TRUNCATED_SERIAL_NUMBER');
    c.p += vli;
  }

  // Optional field 6: Retailer GCP/GLN, VLI "1" to "7", length plus 6.
  if (c.p < c.q && data[c.p] === '6') {
    if (++c.p === c.q) return c.missing('COUPON_MISSING_RETAILER_GCP_OR_GLN_VLI');
    if (data[c.p]! < '1' || data[c.p]! > '7') {
      return c.invalidHere('COUPON_INVALID_RETAILER_GCP_OR_GLN_LENGTH');
    }
    vli = digit(data, c.p) + 6;
    if (c.q - ++c.p < vli) return c.truncated('COUPON_TRUNCATED_RETAILER_GCP_OR_GLN');
    c.p += vli;
  }

  // Optional field 9: Miscellaneous.
  if (c.p < c.q && data[c.p] === '9') {
    if (++c.p === c.q) return c.missing('COUPON_MISSING_SAVE_VALUE_CODE');
    const svc = data[c.p]!;
    if (svc !== '0' && svc !== '1' && svc !== '2' && svc !== '5' && svc !== '6') {
      return c.invalidHere('COUPON_INVALID_SAVE_VALUE_CODE');
    }
    if (++c.p === c.q) return c.missing('COUPON_MISSING_SAVE_VALUE_APPLIES_TO_ITEM');
    if (data[c.p]! > '2') return c.invalidHere('COUPON_INVALID_SAVE_VALUE_APPLIES_TO_ITEM');
    if (++c.p === c.q) return c.missing('COUPON_MISSING_STORE_COUPON_FLAG');
    if (++c.p === c.q) return c.missing('COUPON_MISSING_DONT_MULTIPLY_FLAG');
    if (data[c.p] !== '0' && data[c.p] !== '1') {
      return c.invalidHere('COUPON_INVALID_DONT_MULTIPLY_FLAG');
    }
    c.p++;
  }

  return c.atEnd ? null : err('COUPON_EXCESS_DATA', c.p, c.q - c.p);
};

/** lint_couponposoffer.c (AI 8112, Positive Offer File coupon). */
export const couponposoffer: Linter = (data) => {
  const bad = firstNonDigit(data);
  if (bad !== -1) return err('NON_DIGIT_CHARACTER', bad, 1);

  const c = new Cursor(data.length);
  let vli: number;

  // Format ID: "0" or "1".
  if (c.atEnd) return c.missing('COUPON_MISSING_FORMAT_CODE');
  if (data[c.p] !== '0' && data[c.p] !== '1') return c.invalidHere('COUPON_INVALID_FORMAT_CODE');

  // Funder VLI "0" to "6", Funder ID length plus 6.
  if (++c.p === c.q) return c.missing('COUPON_MISSING_FUNDER_VLI');
  if (data[c.p]! > '6') return c.invalidHere('COUPON_INVALID_FUNDER_LENGTH');
  vli = digit(data, c.p) + 6;
  if (c.q - ++c.p < vli) return c.truncated('COUPON_TRUNCATED_FUNDER');
  c.p += vli;

  // Six digit Offer Code.
  if (c.q - c.p < 6) return c.truncated('COUPON_TRUNCATED_OFFER_CODE');
  c.p += 6;

  // Serial Number VLI, length plus 6.
  if (c.atEnd) return c.missing('COUPON_MISSING_SERIAL_NUMBER_VLI');
  vli = digit(data, c.p) + 6;
  if (c.q - ++c.p < vli) return c.truncated('COUPON_TRUNCATED_SERIAL_NUMBER');
  c.p += vli;

  return c.atEnd ? null : err('COUPON_EXCESS_DATA', c.p, c.q - c.p);
};
