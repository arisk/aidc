import type { SymbologyName } from './types.ts';

/**
 * GenSpecs 26.0 dimension metadata for one symbol specification table. Millimetres, except the
 * quiet zones (modules). Metadata only: nothing in the library enforces it.
 */
export interface SymbolSpec {
  /** Smallest X-dimension in mm. */
  readonly xMin: number;
  /** Target X-dimension in mm. */
  readonly xTarget: number;
  /** Largest X-dimension in mm. */
  readonly xMax: number;
  /** Minimum bar height in mm at the target X-dimension; absent for two-dimensional symbols. */
  readonly minHeight?: number;
  /** Minimum quiet zones in modules. */
  readonly quietZone: { readonly left: number; readonly right: number };
  /** Maximum symbol length in mm, where the specification defines one. */
  readonly maxLength?: number;
  /** Where the values come from. */
  readonly source: string;
}

function spec(
  xMin: number,
  xTarget: number,
  xMax: number,
  minHeight: number | undefined,
  left: number,
  right: number,
  source: string,
  maxLength?: number,
): SymbolSpec {
  const quietZone = Object.freeze({ left, right });
  const base = {
    xMin,
    xTarget,
    xMax,
    ...(minHeight === undefined ? {} : { minHeight }),
    quietZone,
    source,
  };
  return Object.freeze(maxLength === undefined ? base : { ...base, maxLength });
}

const T1 = 'GenSpecs 26.0 symbol specification table 1 (retail POS)';
const T2 = 'GenSpecs 26.0 symbol specification table 2 (general distribution)';
const T46 = 'GenSpecs 26.0 symbol specification table 1 addendum 2 (Table 5-46, 2D at retail POS)';
const T47 = 'GenSpecs 26.0 symbol specification table 2 (Table 5-47, general distribution)';
const T5 = 'GenSpecs 26.0 symbol specification table 5 (logistic units)';
const T45 =
  'GenSpecs 26.0 symbol specification table 1 addendum 1 (Table 5-45, AI (8200) at retail POS)';
const T49 = 'GenSpecs 26.0 symbol specification table 3 addendum 1 (Table 5-49, Digital Link URI)';

/** GenSpecs 26.0 dimension metadata by symbology (a list of specification tables each). */
export const SYMBOL_SPECS: Readonly<Record<SymbologyName, readonly SymbolSpec[]>> =
  /* @__PURE__ */ (() =>
    Object.freeze({
      'ean-13': Object.freeze([
        spec(0.264, 0.33, 0.66, 22.85, 11, 7, T1),
        spec(0.495, 0.66, 0.66, 45.7, 11, 7, T2),
      ]),
      'upc-a': Object.freeze([
        spec(0.264, 0.33, 0.66, 22.85, 9, 9, T1),
        spec(0.495, 0.66, 0.66, 45.7, 9, 9, T2),
      ]),
      'ean-8': Object.freeze([spec(0.264, 0.33, 0.66, 18.23, 7, 7, T1)]),
      'upc-e': Object.freeze([
        spec(0.264, 0.33, 0.66, 22.85, 9, 7, T1),
        spec(0.495, 0.66, 0.66, 45.7, 9, 7, T2),
      ]),
      'itf-14': Object.freeze([spec(0.495, 0.495, 1.016, 31.75, 10, 10, T2)]),
      'gs1-128': Object.freeze([
        spec(0.495, 0.495, 1.016, 31.75, 10, 10, T2, 165.1),
        spec(0.495, 0.495, 0.94, 31.75, 10, 10, T5, 165.1),
      ]),
      'gs1-datamatrix': Object.freeze([
        spec(0.396, 0.495, 0.99, undefined, 1, 1, T46),
        spec(0.743, 0.743, 1.5, undefined, 1, 1, T47),
      ]),
      datamatrix: Object.freeze([
        spec(0.396, 0.495, 0.99, undefined, 1, 1, T46),
        spec(0.743, 0.743, 1.5, undefined, 1, 1, T47),
      ]),
      'gs1-qr': Object.freeze([
        spec(0.396, 0.495, 0.743, undefined, 4, 4, T45),
        spec(0.743, 0.743, 1.5, undefined, 4, 4, T47),
      ]),
      qr: Object.freeze([
        spec(0.396, 0.495, 0.99, undefined, 4, 4, T46),
        spec(0.743, 0.99, 0.99, undefined, 4, 4, T49),
      ]),
    }))();
