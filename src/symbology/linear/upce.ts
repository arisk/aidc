import { Gs1Error, checkDigit } from '../../core/index.ts';

const ZERO = 48;
const NINE = 57;

function isDigit(c: number): boolean {
  return c >= ZERO && c <= NINE;
}

/**
 * Zero suppression of a GTIN-12 (GenSpecs 5.2.2.4.1, rules 2a to 2d): the six UPC-E digits, or
 * undefined when the GTIN-12 does not start with 0, is not 12 digits or fits no rule. The check
 * digit is not verified.
 */
export function upceCompress(gtin12: string): string | undefined {
  if (typeof gtin12 !== 'string' || gtin12.length !== 12) return undefined;
  const c = (i: number): number => gtin12.charCodeAt(i) - ZERO;
  for (let i = 0; i < 12; i++) if (!isDigit(gtin12.charCodeAt(i))) return undefined;
  if (c(0) !== 0) return undefined;
  // Digit Dk is c(k - 1). Rules are mutually exclusive.
  const zeros = (from: number, to: number): boolean => {
    for (let i = from; i <= to; i++) if (c(i) !== 0) return false;
    return true;
  };
  const d4 = c(3);
  if (c(10) >= 5 && zeros(6, 9) && c(5) !== 0) return gtin12.slice(1, 6) + gtin12[10];
  if (zeros(5, 9) && c(4) !== 0) return gtin12.slice(1, 5) + gtin12[10] + '4';
  if (d4 <= 2 && zeros(4, 7)) return gtin12.slice(1, 3) + gtin12.slice(8, 11) + gtin12[3];
  if (d4 >= 3 && zeros(4, 8)) return gtin12.slice(1, 4) + gtin12.slice(9, 11) + '3';
  return undefined;
}

function invalid(
  code: 'INVALID_LENGTH' | 'INVALID_CHAR',
  message: string,
  position?: number,
): Gs1Error {
  return new Gs1Error({
    code,
    message,
    ...(position === undefined ? {} : { position }),
  });
}

/**
 * Expands six UPC-E digits to the GTIN-12 (Table 5-7). The check digit is computed; when
 * `check` is given it must equal the computed one. Throws Gs1Error INVALID_LENGTH, INVALID_CHAR
 * or CHECK_DIGIT.
 */
export function upceExpand(digits6: string, check?: string): string {
  if (typeof digits6 !== 'string') throw invalid('INVALID_CHAR', 'UPC-E digits must be a string');
  if (digits6.length !== 6)
    throw invalid('INVALID_LENGTH', `UPC-E needs 6 digits, got ${digits6.length}`);
  for (let i = 0; i < 6; i++)
    if (!isDigit(digits6.charCodeAt(i)))
      throw invalid('INVALID_CHAR', 'UPC-E digits must be 0-9', i);
  const s = digits6;
  const x6 = s.charCodeAt(5) - ZERO;
  let body: string;
  if (x6 <= 2) body = s.slice(0, 2) + s[5] + '0000' + s.slice(2, 5);
  else if (x6 === 3) body = s.slice(0, 3) + '00000' + s.slice(3, 5);
  else if (x6 === 4) body = s.slice(0, 4) + '00000' + s[4];
  else body = s.slice(0, 5) + '0000' + s[5];
  const base = '0' + body;
  const cd = checkDigit(base);
  if (check !== undefined) {
    if (typeof check !== 'string' || check.length !== 1 || !isDigit(check.charCodeAt(0)))
      throw invalid('INVALID_CHAR', 'UPC-E check digit must be one digit', 6);
    if (check !== cd)
      throw new Gs1Error({
        code: 'CHECK_DIGIT',
        message: `Incorrect UPC-E check digit, expected ${cd}`,
        position: 6,
      });
  }
  return base + cd;
}

/**
 * True when `upceCompress(upceExpand(digits6)) === digits6`: the body the encoder would
 * produce. Non-canonical bodies are valid in old symbols (GenSpecs 7.10) and decode only.
 */
export function isCanonicalUpce(digits6: string): boolean {
  if (typeof digits6 !== 'string' || digits6.length !== 6) return false;
  const v = (i: number): number => digits6.charCodeAt(i) - ZERO;
  for (let i = 0; i < 6; i++) if (!isDigit(digits6.charCodeAt(i))) return false;
  const x6 = v(5);
  if (x6 <= 2) return true;
  if (x6 === 3) return v(2) > 2;
  if (x6 === 4) return v(3) > 0;
  return v(4) > 0;
}
