import { unwrap } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import type { ElementString } from '../../ai/index.ts';
import type { DecodedSymbol, LinearPattern, Symbology } from '../render/index.ts';
import { decodeGs1128 } from './gs1-128-decode.ts';
import type { Gs1128Metadata } from './gs1-128-decode.ts';
import { encodeGs1128 } from './gs1-128-encode.ts';
import type { Gs1128Options } from './gs1-128-encode.ts';

export type { Gs1128Metadata } from './gs1-128-decode.ts';
export type { Gs1128Options } from './gs1-128-encode.ts';

function tryEncode(data: ElementString | string, options?: Gs1128Options): Result<LinearPattern> {
  return encodeGs1128(data, options);
}

/**
 * GS1-128: encode an element string with minimal code sets, at most 48 data
 * characters (GenSpecs 5.4.4.3); decode a pattern, reporting a composite linkage flag.
 */
export const gs1128: Symbology<Gs1128Options, Gs1128Metadata> = /* @__PURE__ */ Object.freeze({
  name: 'gs1-128',
  encode: (data: ElementString | string, options?: Gs1128Options): LinearPattern =>
    unwrap(tryEncode(data, options)),
  tryEncode,
  decode: (symbol: LinearPattern): DecodedSymbol<Gs1128Metadata> => unwrap(decodeGs1128(symbol)),
  tryDecode: decodeGs1128,
} as const);
