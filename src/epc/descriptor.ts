/** One partition table row (TDS 14.6): GCP bits M, GCP digits L, other bits N, other digits or max characters K. */
export type PartitionRow = readonly [
  gcpBits: number,
  gcpDigits: number,
  otherBits: number,
  otherDigits: number,
];
/** Rows indexed by partition value P = 0..6. */
export type PartitionTable = readonly PartitionRow[];

/** One binary field and its TDS 14.3/14.4 encoding method. */
export type FieldSpec =
  | { readonly kind: 'filter'; readonly bits: number }
  | { readonly kind: 'zeros'; readonly bits: number }
  | { readonly kind: 'integer'; readonly bits: number; readonly maxDigits?: number }
  | { readonly kind: 'fixedWidthInteger'; readonly bits: number; readonly digits: number }
  | { readonly kind: 'string7'; readonly bits: number; readonly maxChars: number }
  | { readonly kind: 'numericString'; readonly bits: number; readonly maxDigits: number }
  | { readonly kind: 'cage6' }
  | {
      readonly kind: 'string6Var';
      readonly min: number;
      readonly max: number;
      readonly hash: 'first' | 'none';
    }
  | { readonly kind: 'ascii8'; readonly chars: number }
  | {
      readonly kind: 'partition';
      readonly table: PartitionTable;
      readonly other: 'padded' | 'unpadded' | 'string7' | 'cpref6';
    };

export interface FieldDef {
  /** Name used in errors ('filter', 'companyPrefix', 'serial', ...). A partition field names both parts. */
  readonly name: string;
  readonly spec: FieldSpec;
}

/** EPC schemes with a pure identity (or class) URI (TDS 6.3, 6.4). */
export type PureSchemeName =
  | 'sgtin'
  | 'sscc'
  | 'sgln'
  | 'grai'
  | 'giai'
  | 'gsrn'
  | 'gsrnp'
  | 'gdti'
  | 'cpi'
  | 'sgcn'
  | 'ginc'
  | 'gsin'
  | 'itip'
  | 'upui'
  | 'pgln'
  | 'gid'
  | 'usdod'
  | 'adi'
  | 'bic'
  | 'imovn'
  | 'lgtin';

/** The 22 legacy binary schemes (TDS 14.6). */
export type BinarySchemeName =
  | 'sgtin-96'
  | 'sgtin-198'
  | 'sscc-96'
  | 'sgln-96'
  | 'sgln-195'
  | 'grai-96'
  | 'grai-170'
  | 'giai-96'
  | 'giai-202'
  | 'gsrn-96'
  | 'gsrnp-96'
  | 'gdti-96'
  | 'gdti-113'
  | 'gdti-174'
  | 'sgcn-96'
  | 'itip-110'
  | 'itip-212'
  | 'gid-96'
  | 'cpi-96'
  | 'cpi-var'
  | 'usdod-96'
  | 'adi-var';

export interface BinaryScheme {
  readonly name: BinarySchemeName;
  /** The 8-bit header (TDS Table 14-1). */
  readonly header: number;
  /** Total bits; undefined for the variable-length schemes (cpi-var, adi-var). */
  readonly bits: number | undefined;
  readonly epcScheme: PureSchemeName;
  /** Fields after the header, in bit order. The filter field, when present, comes first. */
  readonly fields: readonly FieldDef[];
  readonly deprecated?: true;
}

/** The 24 TDS 2.x "+" and "++" binary schemes (TDS 14.6). */
export type PlusSchemeName =
  | 'sgtin+'
  | 'dsgtin+'
  | 'sscc+'
  | 'sgln+'
  | 'grai+'
  | 'giai+'
  | 'gsrn+'
  | 'gsrnp+'
  | 'gdti+'
  | 'sgcn+'
  | 'itip+'
  | 'cpi+'
  | 'sgtin++'
  | 'dsgtin++'
  | 'sscc++'
  | 'sgln++'
  | 'grai++'
  | 'giai++'
  | 'gsrn++'
  | 'gsrnp++'
  | 'gdti++'
  | 'sgcn++'
  | 'itip++'
  | 'cpi++';

/** Every binary scheme name: legacy and "+"/"++". */
export type EpcBinarySchemeName = BinarySchemeName | PlusSchemeName;
