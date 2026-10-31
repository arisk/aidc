import { type Result, fail, guard, ok, unwrap } from '../core/errors.ts';
import { ElementString, format, tryParse } from '../ai/index.ts';
import { type DigitalLinkOptions, tryToDigitalLink } from '../digital-link/index.ts';
import { SCAN_AIM_ID, type ScanSymbology } from './aim.ts';
import { scanError } from './from-scan.ts';

export interface ToScanOptions {
  /** A 2 or 5 digit add-on for 'ean-13', giving ]E3. */
  readonly addOn?: string;
  /** For AI-data symbologies: place predefined fixed-length AIs first (see format). */
  readonly optimizeOrder?: boolean;
  /** For 'qr', 'datamatrix' and 'dotcode': how to build the Digital Link URI. */
  readonly digitalLink?: DigitalLinkOptions;
}

function isAddOn(s: string): boolean {
  if (s.length !== 2 && s.length !== 5) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function gtinScan(
  es: ElementString,
  symbology: 'ean-13' | 'ean-8' | 'itf-14',
  addOn: string | undefined,
): Result<string> {
  const gtin = es.size === 1 ? es.gtin : undefined;
  const no = (why: string): Result<string> =>
    fail([scanError('not-representable', `${symbology} cannot carry this data: ${why}`)]);
  if (gtin === undefined) return no('it carries exactly one GTIN, AI (01)');
  if (addOn !== undefined && (symbology !== 'ean-13' || !isAddOn(addOn)))
    return no('an add-on is 2 or 5 digits on ean-13');
  if (symbology === 'itf-14') return ok(`]I1${gtin}`);
  if (symbology === 'ean-8')
    return gtin.startsWith('000000') ? ok(`]E4${gtin.slice(6)}`) : no('the GTIN is not a GTIN-8');
  if (!gtin.startsWith('0')) return no('the GTIN is a GTIN-14');
  // GenSpecs Table 1-4: 00000 + a GTIN-8 prefix is unused, so a 13-digit value there is no EAN-13.
  if (gtin.startsWith('000000') && gtin.slice(6, 8) !== '00')
    return no('the 13-digit value is in the unused GTIN-8 range');
  return ok(addOn === undefined ? `]E0${gtin.slice(1)}` : `]E3${gtin.slice(1)}${addOn}`);
}

/** The scan string a reader would transmit for `input` in `symbology`, collecting errors. */
export function tryToScan(
  input: ElementString | string,
  symbology: ScanSymbology,
  opts: ToScanOptions = {},
): Result<string> {
  return guard(() => tryToScanUnguarded(input, symbology, opts));
}

function tryToScanUnguarded(
  input: ElementString | string,
  symbology: ScanSymbology,
  opts: ToScanOptions = {},
): Result<string> {
  let es: ElementString;
  if (input instanceof ElementString) es = input;
  else {
    const r = tryParse(input);
    if (!r.ok) return fail(r.errors);
    es = r.value;
  }
  if (!Object.hasOwn(SCAN_AIM_ID, symbology))
    return fail([scanError('not-representable', `Unknown symbology: ${symbology}`)]);
  const id = SCAN_AIM_ID[symbology];
  if (opts.addOn !== undefined && symbology !== 'ean-13')
    return fail([scanError('not-representable', 'an add-on is only valid for ean-13')]);
  switch (symbology) {
    case 'gs1-128':
    case 'gs1-databar':
    case 'gs1-datamatrix':
    case 'gs1-qr':
    case 'gs1-dotcode':
      return ok(
        id +
          format(
            es,
            'raw',
            opts.optimizeOrder === undefined ? {} : { optimizeOrder: opts.optimizeOrder },
          ),
      );
    case 'ean-13':
    case 'ean-8':
    case 'itf-14':
      return gtinScan(es, symbology, opts.addOn);
    case 'qr':
    case 'datamatrix':
    case 'dotcode': {
      const u = tryToDigitalLink(es, opts.digitalLink ?? {});
      return u.ok ? ok(id + u.value) : fail(u.errors);
    }
    default: {
      const unreachable: never = symbology;
      return unreachable;
    }
  }
}

/** Like tryToScan, but throws the first Gs1Error. */
export function toScan(
  input: ElementString | string,
  symbology: ScanSymbology,
  opts: ToScanOptions = {},
): string {
  return unwrap(tryToScan(input, symbology, opts));
}
