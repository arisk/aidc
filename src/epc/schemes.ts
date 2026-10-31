import type { BinaryScheme, FieldDef } from './descriptor.ts';
import {
  CPI96_PARTITION,
  CPIVAR_PARTITION,
  GIAI202_PARTITION,
  GIAI96_PARTITION,
  GRAI_PARTITION,
  SGLN_PARTITION,
  SGTIN_PARTITION,
  SSCC_PARTITION,
} from './partitions.ts';

const filter3: FieldDef = { name: 'filter', spec: { kind: 'filter', bits: 3 } };
const gtin: FieldDef = {
  name: 'itemReference',
  spec: { kind: 'partition', table: SGTIN_PARTITION, other: 'padded' },
};

/** The 22 legacy binary schemes (TDS 14.6; USDOD-96 from TDT, plan decision E12). */
export const BINARY_SCHEMES: readonly BinaryScheme[] = [
  {
    name: 'sgtin-96',
    header: 0x30,
    bits: 96,
    epcScheme: 'sgtin',
    fields: [filter3, gtin, { name: 'serial', spec: { kind: 'integer', bits: 38 } }],
  },
  {
    name: 'sgtin-198',
    header: 0x36,
    bits: 198,
    epcScheme: 'sgtin',
    fields: [filter3, gtin, { name: 'serial', spec: { kind: 'string7', bits: 140, maxChars: 20 } }],
  },
  {
    name: 'sscc-96',
    header: 0x31,
    bits: 96,
    epcScheme: 'sscc',
    fields: [
      filter3,
      {
        name: 'serialReference',
        spec: { kind: 'partition', table: SSCC_PARTITION, other: 'padded' },
      },
      { name: 'reserved', spec: { kind: 'zeros', bits: 24 } },
    ],
  },
  {
    name: 'sgln-96',
    header: 0x32,
    bits: 96,
    epcScheme: 'sgln',
    fields: [
      filter3,
      {
        name: 'locationReference',
        spec: { kind: 'partition', table: SGLN_PARTITION, other: 'padded' },
      },
      { name: 'extension', spec: { kind: 'integer', bits: 41 } },
    ],
  },
  {
    name: 'sgln-195',
    header: 0x39,
    bits: 195,
    epcScheme: 'sgln',
    fields: [
      filter3,
      {
        name: 'locationReference',
        spec: { kind: 'partition', table: SGLN_PARTITION, other: 'padded' },
      },
      { name: 'extension', spec: { kind: 'string7', bits: 140, maxChars: 20 } },
    ],
  },
  {
    name: 'grai-96',
    header: 0x33,
    bits: 96,
    epcScheme: 'grai',
    fields: [
      filter3,
      { name: 'assetType', spec: { kind: 'partition', table: GRAI_PARTITION, other: 'padded' } },
      { name: 'serial', spec: { kind: 'integer', bits: 38 } },
    ],
  },
  {
    name: 'grai-170',
    header: 0x37,
    bits: 170,
    epcScheme: 'grai',
    fields: [
      filter3,
      { name: 'assetType', spec: { kind: 'partition', table: GRAI_PARTITION, other: 'padded' } },
      { name: 'serial', spec: { kind: 'string7', bits: 112, maxChars: 16 } },
    ],
  },
  {
    name: 'giai-96',
    header: 0x34,
    bits: 96,
    epcScheme: 'giai',
    fields: [
      filter3,
      {
        name: 'assetReference',
        spec: { kind: 'partition', table: GIAI96_PARTITION, other: 'unpadded' },
      },
    ],
  },
  {
    name: 'giai-202',
    header: 0x38,
    bits: 202,
    epcScheme: 'giai',
    fields: [
      filter3,
      {
        name: 'assetReference',
        spec: { kind: 'partition', table: GIAI202_PARTITION, other: 'string7' },
      },
    ],
  },
  {
    name: 'gsrn-96',
    header: 0x2d,
    bits: 96,
    epcScheme: 'gsrn',
    fields: [
      filter3,
      {
        name: 'serviceReference',
        spec: { kind: 'partition', table: SSCC_PARTITION, other: 'padded' },
      },
      { name: 'reserved', spec: { kind: 'zeros', bits: 24 } },
    ],
  },
  {
    name: 'gsrnp-96',
    header: 0x2e,
    bits: 96,
    epcScheme: 'gsrnp',
    fields: [
      filter3,
      {
        name: 'serviceReference',
        spec: { kind: 'partition', table: SSCC_PARTITION, other: 'padded' },
      },
      { name: 'reserved', spec: { kind: 'zeros', bits: 24 } },
    ],
  },
  {
    name: 'gdti-96',
    header: 0x2c,
    bits: 96,
    epcScheme: 'gdti',
    fields: [
      filter3,
      { name: 'documentType', spec: { kind: 'partition', table: SGLN_PARTITION, other: 'padded' } },
      { name: 'serial', spec: { kind: 'integer', bits: 41 } },
    ],
  },
  {
    name: 'gdti-113',
    header: 0x3a,
    bits: 113,
    epcScheme: 'gdti',
    deprecated: true,
    fields: [
      filter3,
      { name: 'documentType', spec: { kind: 'partition', table: SGLN_PARTITION, other: 'padded' } },
      { name: 'serial', spec: { kind: 'numericString', bits: 58, maxDigits: 17 } },
    ],
  },
  {
    name: 'gdti-174',
    header: 0x3e,
    bits: 174,
    epcScheme: 'gdti',
    fields: [
      filter3,
      { name: 'documentType', spec: { kind: 'partition', table: SGLN_PARTITION, other: 'padded' } },
      { name: 'serial', spec: { kind: 'string7', bits: 119, maxChars: 17 } },
    ],
  },
  {
    name: 'sgcn-96',
    header: 0x3f,
    bits: 96,
    epcScheme: 'sgcn',
    fields: [
      filter3,
      {
        name: 'couponReference',
        spec: { kind: 'partition', table: SGLN_PARTITION, other: 'padded' },
      },
      { name: 'serial', spec: { kind: 'numericString', bits: 41, maxDigits: 12 } },
    ],
  },
  {
    name: 'itip-110',
    header: 0x40,
    bits: 110,
    epcScheme: 'itip',
    fields: [
      filter3,
      gtin,
      { name: 'piece', spec: { kind: 'fixedWidthInteger', bits: 7, digits: 2 } },
      { name: 'total', spec: { kind: 'fixedWidthInteger', bits: 7, digits: 2 } },
      { name: 'serial', spec: { kind: 'integer', bits: 38 } },
    ],
  },
  {
    name: 'itip-212',
    header: 0x41,
    bits: 212,
    epcScheme: 'itip',
    fields: [
      filter3,
      gtin,
      { name: 'piece', spec: { kind: 'fixedWidthInteger', bits: 7, digits: 2 } },
      { name: 'total', spec: { kind: 'fixedWidthInteger', bits: 7, digits: 2 } },
      { name: 'serial', spec: { kind: 'string7', bits: 140, maxChars: 20 } },
    ],
  },
  {
    name: 'gid-96',
    header: 0x35,
    bits: 96,
    epcScheme: 'gid',
    fields: [
      { name: 'manager', spec: { kind: 'integer', bits: 28 } },
      { name: 'class', spec: { kind: 'integer', bits: 24 } },
      { name: 'serial', spec: { kind: 'integer', bits: 36 } },
    ],
  },
  {
    name: 'cpi-96',
    header: 0x3c,
    bits: 96,
    epcScheme: 'cpi',
    fields: [
      filter3,
      {
        name: 'partReference',
        spec: { kind: 'partition', table: CPI96_PARTITION, other: 'unpadded' },
      },
      { name: 'serial', spec: { kind: 'integer', bits: 31 } },
    ],
  },
  {
    name: 'cpi-var',
    header: 0x3d,
    bits: undefined,
    epcScheme: 'cpi',
    fields: [
      filter3,
      {
        name: 'partReference',
        spec: { kind: 'partition', table: CPIVAR_PARTITION, other: 'cpref6' },
      },
      { name: 'serial', spec: { kind: 'integer', bits: 40, maxDigits: 12 } },
    ],
  },
  {
    name: 'usdod-96',
    header: 0x2f,
    bits: 96,
    epcScheme: 'usdod',
    fields: [
      { name: 'filter', spec: { kind: 'filter', bits: 4 } },
      { name: 'cageOrDodaac', spec: { kind: 'ascii8', chars: 6 } },
      { name: 'serial', spec: { kind: 'integer', bits: 36 } },
    ],
  },
  {
    name: 'adi-var',
    header: 0x3b,
    bits: undefined,
    epcScheme: 'adi',
    fields: [
      { name: 'filter', spec: { kind: 'filter', bits: 6 } },
      { name: 'cageOrDodaac', spec: { kind: 'cage6' } },
      { name: 'partNumber', spec: { kind: 'string6Var', min: 0, max: 32, hash: 'none' } },
      { name: 'serial', spec: { kind: 'string6Var', min: 1, max: 30, hash: 'first' } },
    ],
  },
];

const BY_NAME: ReadonlyMap<string, BinaryScheme> = /* @__PURE__ */ new Map(
  BINARY_SCHEMES.map((s) => [s.name, s]),
);
const BY_HEADER: ReadonlyMap<number, BinaryScheme> = /* @__PURE__ */ new Map(
  BINARY_SCHEMES.map((s) => [s.header, s]),
);

export function schemeByName(name: string): BinaryScheme | undefined {
  return BY_NAME.get(name);
}

export function schemeByHeader(header: number): BinaryScheme | undefined {
  return BY_HEADER.get(header);
}

/** Headers of the TDS 2.x "+" and "++" schemes (Table 14-1): decodeBinary sends them to decodePlus. */
export function isPlusHeader(header: number): boolean {
  return header >= 0xe6 && header <= 0xfd;
}
