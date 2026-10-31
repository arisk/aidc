/**
 * Symbologies a scan string can come from. An AIM identifier cannot tell
 * some apart: ]E0 is EAN-13, UPC-A or UPC-E ('ean-13'), and ]e0 is any GS1 DataBar or GS1
 * Composite ('gs1-databar'). 'datamatrix', 'qr' and 'dotcode' are the plain (non-GS1 mode)
 * symbols that carry a GS1 Digital Link URI.
 */
export type ScanSymbology =
  | 'ean-13'
  | 'ean-8'
  | 'itf-14'
  | 'gs1-128'
  | 'gs1-databar'
  | 'gs1-datamatrix'
  | 'gs1-qr'
  | 'gs1-dotcode'
  | 'datamatrix'
  | 'qr'
  | 'dotcode';

export type AimIdInfo =
  | { readonly carrier: 'ai'; readonly symbology: ScanSymbology }
  | { readonly carrier: 'gtin'; readonly symbology: ScanSymbology; readonly digits: 8 | 13 | 14 }
  | { readonly carrier: 'gtin-add-on'; readonly symbology: 'ean-13' }
  | { readonly carrier: 'digital-link'; readonly symbology: ScanSymbology }
  | { readonly carrier: 'unsupported'; readonly why: string };

/** AIM symbology identifiers (GenSpecs 26.0 section 5.1.3, Table 5-2). Case sensitive. */
export const AIM_IDS: ReadonlyMap<string, AimIdInfo> = /* @__PURE__ */ new Map<string, AimIdInfo>([
  [']C1', { carrier: 'ai', symbology: 'gs1-128' }],
  [']e0', { carrier: 'ai', symbology: 'gs1-databar' }],
  [']d2', { carrier: 'ai', symbology: 'gs1-datamatrix' }],
  [']Q3', { carrier: 'ai', symbology: 'gs1-qr' }],
  [']J1', { carrier: 'ai', symbology: 'gs1-dotcode' }],
  [']E0', { carrier: 'gtin', symbology: 'ean-13', digits: 13 }],
  [']E4', { carrier: 'gtin', symbology: 'ean-8', digits: 8 }],
  [']I1', { carrier: 'gtin', symbology: 'itf-14', digits: 14 }],
  [']I0', { carrier: 'gtin', symbology: 'itf-14', digits: 14 }],
  [']E3', { carrier: 'gtin-add-on', symbology: 'ean-13' }],
  [']d1', { carrier: 'digital-link', symbology: 'datamatrix' }],
  [']Q1', { carrier: 'digital-link', symbology: 'qr' }],
  [']J0', { carrier: 'digital-link', symbology: 'dotcode' }],
  [
    ']E1',
    { carrier: 'unsupported', why: 'a 2-digit add-on is read with its EAN/UPC symbol (]E3)' },
  ],
  [
    ']E2',
    { carrier: 'unsupported', why: 'a 5-digit add-on is read with its EAN/UPC symbol (]E3)' },
  ],
  [
    ']e1',
    {
      carrier: 'unsupported',
      why: 'GS1 Composite data after an encoded symbol separator is reserved for future use (GenSpecs 5.11.4.3)',
    },
  ],
  [
    ']e2',
    {
      carrier: 'unsupported',
      why: 'GS1 Composite data after a 2D escape is reserved for future use (GenSpecs 5.11.4.4)',
    },
  ],
]);

/** The AIM identifier toScan emits for each symbology. */
export const SCAN_AIM_ID: Readonly<Record<ScanSymbology, string>> = {
  'ean-13': ']E0',
  'ean-8': ']E4',
  'itf-14': ']I1',
  'gs1-128': ']C1',
  'gs1-databar': ']e0',
  'gs1-datamatrix': ']d2',
  'gs1-qr': ']Q3',
  'gs1-dotcode': ']J1',
  datamatrix: ']d1',
  qr: ']Q1',
  dotcode: ']J0',
};
