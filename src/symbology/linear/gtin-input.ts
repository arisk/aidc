import { Gs1Error, fail, isDigits, isValidCheckDigit, ok } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import { ElementString, tryParse } from '../../ai/index.ts';
import { notRepresentable } from '../render/internal.ts';
import type { SymbologyName } from '../render/index.ts';

function checkFail(ai: string, position: number): Result<string> {
  return fail([
    new Gs1Error({
      code: 'CHECK_DIGIT',
      message: 'Incorrect GTIN check digit',
      ai,
      position,
    }),
  ]);
}

/** The 14-digit GTIN of a single-element (01) element string, checked. */
function fromElementString(es: ElementString, symbology: SymbologyName): Result<string> {
  const gtin = es.gtin;
  if (es.size !== 1 || gtin === undefined)
    return fail([notRepresentable(symbology, 'only a lone GTIN (01) can be carried')]);
  if (!isValidCheckDigit(gtin)) return checkFail('01', gtin.length - 1);
  return ok(gtin);
}

/**
 * The 14-digit GTIN of EAN/UPC or ITF-14 input (plan decision G6): an ElementString holding only
 * (01), a digit string of length 8, 12, 13 or 14 (a GTIN with its check digit, validated, never
 * computed), or any other string, which is parsed as an element string. Representability per
 * symbology stays with each encoder. Never throws.
 */
export function gtinInput(data: unknown, symbology: SymbologyName): Result<string> {
  try {
    if (data instanceof ElementString) return fromElementString(data, symbology);
    if (typeof data !== 'string') {
      return fail([
        new Gs1Error({
          code: 'INVALID_VALUE',
          message: 'Data must be a string or an ElementString',
          details: { option: 'data' },
        }),
      ]);
    }
    const n = data.length;
    if ((n === 8 || n === 12 || n === 13 || n === 14) && isDigits(data)) {
      if (!isValidCheckDigit(data)) return checkFail('01', n - 1);
      return ok(data.padStart(14, '0'));
    }
    const parsed = tryParse(data);
    if (!parsed.ok) return fail(parsed.errors);
    return fromElementString(parsed.value, symbology);
  } catch {
    return fail([
      new Gs1Error({
        code: 'INVALID_VALUE',
        message: 'Data could not be read',
        details: { option: 'data' },
      }),
    ]);
  }
}
