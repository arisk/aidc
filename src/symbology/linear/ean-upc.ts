import { Gs1Error, fail, unwrap } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import type { ElementString } from '../../ai/index.ts';
import type { DecodedSymbol, LinearPattern, Symbology, SymbologyName } from '../render/index.ts';
import { decodeEanUpc } from './ean-decode.ts';
import type { EanUpcAccept, EanUpcMetadata } from './ean-decode.ts';
import { encodeEanUpc } from './ean-encode.ts';
import type { EanUpcForm, EanUpcOptions } from './ean-encode.ts';
import { gtinInput } from './gtin-input.ts';

export { upceCompress, upceExpand } from './upce.ts';
export type { EanUpcForm, EanUpcOptions } from './ean-encode.ts';
export type { EanUpcMetadata } from './ean-decode.ts';

/** Options of `eanUpc`: the form defaults to `'auto'`. */
export interface EanUpcAnyOptions extends EanUpcOptions {
  readonly form?: EanUpcForm | 'auto';
}

function asForm(v: unknown): EanUpcForm | 'auto' | undefined {
  switch (v) {
    case 'ean-13':
    case 'upc-a':
    case 'ean-8':
    case 'upc-e':
    case 'auto':
      return v;
    default:
      return undefined;
  }
}

function make<O extends object>(
  name: SymbologyName,
  accept: EanUpcAccept,
  encodeWith: (data: ElementString | string, options: O | undefined) => Result<LinearPattern>,
): Symbology<O, EanUpcMetadata> {
  const tryEncode = (data: ElementString | string, options?: O): Result<LinearPattern> => {
    try {
      return encodeWith(data, options);
    } catch {
      return fail([
        new Gs1Error({
          code: 'INVALID_VALUE',
          message: 'Input could not be encoded',
        }),
      ]);
    }
  };
  const tryDecode = (symbol: LinearPattern): Result<DecodedSymbol<EanUpcMetadata>> =>
    decodeEanUpc(symbol, accept);
  return Object.freeze({
    name,
    encode: (data: ElementString | string, options?: O): LinearPattern =>
      unwrap(tryEncode(data, options)),
    tryEncode,
    decode: (symbol: LinearPattern): DecodedSymbol<EanUpcMetadata> => unwrap(tryDecode(symbol)),
    tryDecode,
  });
}

function fixed(
  form: EanUpcForm,
): (data: ElementString | string, options: EanUpcOptions | undefined) => Result<LinearPattern> {
  return (data, options) => encodeEanUpc(form, data, options);
}

/** EAN-13 (also reads UPC-A bars): encode, decode. */
export const ean13: Symbology<EanUpcOptions, EanUpcMetadata> = /* @__PURE__ */ make(
  'ean-13',
  'ean-13',
  fixed('ean-13'),
);
/** UPC-A: encode, decode (any 59 element symbol; `symbology` is `upc-a` for a leading 0). */
export const upcA: Symbology<EanUpcOptions, EanUpcMetadata> = /* @__PURE__ */ make(
  'upc-a',
  'ean-13',
  fixed('upc-a'),
);
/** EAN-8: encode, decode. */
export const ean8: Symbology<EanUpcOptions, EanUpcMetadata> = /* @__PURE__ */ make(
  'ean-8',
  'ean-8',
  fixed('ean-8'),
);
/** UPC-E (number system 0): encode, decode. */
export const upcE: Symbology<EanUpcOptions, EanUpcMetadata> = /* @__PURE__ */ make(
  'upc-e',
  'upc-e',
  fixed('upc-e'),
);

function autoForm(gtin14: string): EanUpcForm {
  if (gtin14.startsWith('000000')) return 'ean-8';
  return gtin14.startsWith('00') ? 'upc-a' : 'ean-13';
}

/** All four forms: `form` picks one, default `'auto'` (EAN-8, UPC-A, EAN-13 by prefix). */
export const eanUpc: Symbology<EanUpcAnyOptions, EanUpcMetadata> = /* @__PURE__ */ make(
  'ean-13',
  'any',
  (data, options) => {
    if (options !== undefined && (typeof options !== 'object' || options === null))
      return encodeEanUpc('ean-13', data, options);
    const raw: unknown = options === undefined ? undefined : Reflect.get(options, 'form');
    const form = raw === undefined ? 'auto' : asForm(raw);
    if (form === undefined)
      return fail([
        new Gs1Error({
          code: 'INVALID_VALUE',
          message: 'form must be ean-13, upc-a, ean-8, upc-e or auto',
          details: { option: 'form' },
        }),
      ]);
    if (form !== 'auto') return encodeEanUpc(form, data, options);
    const gtin = gtinInput(data, 'ean-13');
    if (!gtin.ok) return fail(gtin.errors);
    return encodeEanUpc(autoForm(gtin.value), data, options);
  },
);
