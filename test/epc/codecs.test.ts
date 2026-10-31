import { describe, expect, it } from 'vitest';
import { BitReader, BitWriter } from '../../src/core/bits.ts';
import { Gs1Error } from '../../src/core/errors.ts';
import { componentCount, decodeField, encodeField } from '../../src/epc/codecs.ts';
import type { FieldDef, FieldSpec } from '../../src/epc/descriptor.ts';
import {
  CPIVAR_PARTITION,
  GIAI202_PARTITION,
  GIAI96_PARTITION,
  SGLN_PARTITION,
  SGTIN_PARTITION,
} from '../../src/epc/partitions.ts';

const def = (spec: FieldSpec, name = 'f'): FieldDef => ({ name, spec });

function enc(spec: FieldSpec, ...components: string[]): string | Gs1Error {
  const w = new BitWriter();
  const e = encodeField(def(spec), components, w);
  return e ?? w.toString();
}
function dec(spec: FieldSpec, bits: string): string[] | Gs1Error {
  return decodeField(def(spec), new BitReader(bits));
}
function str(r: string | Gs1Error): string {
  if (r instanceof Gs1Error) throw r;
  return r;
}
function codeOf(r: unknown): unknown {
  return r instanceof Gs1Error ? [r.code, r.details?.['reason'] ?? r.details?.['why']] : r;
}

describe('component counts', () => {
  it('partition takes two, filter and zeros none, others one', () => {
    expect(componentCount({ kind: 'partition', table: SGTIN_PARTITION, other: 'padded' })).toBe(2);
    expect(componentCount({ kind: 'filter', bits: 3 })).toBe(0);
    expect(componentCount({ kind: 'zeros', bits: 24 })).toBe(0);
    expect(componentCount({ kind: 'integer', bits: 38 })).toBe(1);
  });
});

describe('Integer (TDS 14.3.1 / 14.4.1)', () => {
  const spec: FieldSpec = { kind: 'integer', bits: 38 };
  it('encodes NumericComponent values that fit', () => {
    expect(enc(spec, '6789')).toBe((6789).toString(2).padStart(38, '0'));
    expect(enc(spec, '0')).toBe('0'.repeat(38));
    expect(dec(spec, (6789).toString(2).padStart(38, '0'))).toEqual(['6789']);
  });
  it('rejects leading zeros, letters and values of 2^bits or more (E10)', () => {
    expect(codeOf(enc(spec, '0123'))).toEqual(['EPC_FIELD_OVERFLOW', 'leading-zero']);
    expect(codeOf(enc(spec, '12a'))).toEqual(['EPC_FIELD_OVERFLOW', 'not-numeric']);
    expect(codeOf(enc(spec, String(2 ** 38)))).toEqual(['EPC_FIELD_OVERFLOW', 'too-large']);
    expect(codeOf(enc({ kind: 'integer', bits: 40, maxDigits: 12 }, '1000000000000'))).toEqual([
      'EPC_FIELD_OVERFLOW',
      'too-many-digits',
    ]);
  });
});

describe('Fixed Width Integer (TDS 14.3.10 / 14.4.10)', () => {
  const spec: FieldSpec = { kind: 'fixedWidthInteger', bits: 7, digits: 2 };
  it('encodes exactly two digits, 00 to 99', () => {
    expect(enc(spec, '01')).toBe('0000001');
    expect(enc(spec, '99')).toBe('1100011');
    expect(dec(spec, '0000001')).toEqual(['01']);
    expect(codeOf(enc(spec, '1'))).toEqual(['EPC_FIELD_OVERFLOW', 'length']);
    expect(codeOf(dec(spec, '1111111'))).toEqual(['INVALID_EPC', 'binary']);
  });
});

describe('String (TDS 14.3.2 / 14.4.2)', () => {
  const spec: FieldSpec = { kind: 'string7', bits: 140, maxChars: 20 };
  it('7 bits per character, zero padded, URI escapes undone and redone', () => {
    const bits = enc(spec, '32a%2Fb');
    expect(str(bits).slice(0, 35)).toBe(
      Array.from('32a/b', (c) => c.charCodeAt(0).toString(2).padStart(7, '0')).join(''),
    );
    expect(str(bits).length).toBe(140);
    expect(dec(spec, str(bits))).toEqual(['32a%2Fb']);
  });
  it('rejects too many characters, bad escapes and malformed binary', () => {
    expect(codeOf(enc(spec, 'A'.repeat(21)))).toEqual(['EPC_FIELD_OVERFLOW', 'too-many-chars']);
    expect(codeOf(enc(spec, 'a/b'))).toEqual(['INVALID_EPC', 'escape']);
    expect(codeOf(dec(spec, '0'.repeat(140)))).toEqual(['INVALID_EPC', 'binary']); // empty
    expect(codeOf(dec(spec, `100000100000001000001${'0'.repeat(119)}`))).toEqual([
      'INVALID_EPC',
      'binary',
    ]); // gap
  });
});

describe('Numeric String (TDS 14.3.6 / 14.4.6)', () => {
  const spec: FieldSpec = { kind: 'numericString', bits: 41, maxDigits: 12 };
  it('keeps leading zeros by prefixing 1', () => {
    expect(enc(spec, '04711')).toBe((104711).toString(2).padStart(41, '0'));
    expect(dec(spec, (104711).toString(2).padStart(41, '0'))).toEqual(['04711']);
    expect(codeOf(dec(spec, (204711).toString(2).padStart(41, '0')))).toEqual([
      'INVALID_EPC',
      'binary',
    ]);
    expect(codeOf(enc(spec, '1234567890123'))).toEqual(['EPC_FIELD_OVERFLOW', 'too-many-digits']);
  });
});

describe('Partition (TDS 14.3.3 to 14.3.5, 14.3.9)', () => {
  it('padded: picks the row by company prefix length', () => {
    const spec: FieldSpec = { kind: 'partition', table: SGTIN_PARTITION, other: 'padded' };
    const bits = enc(spec, '95060001343', '05');
    expect(bits).toBe(
      '001' + (95060001343).toString(2).padStart(37, '0') + (5).toString(2).padStart(7, '0'),
    );
    expect(dec(spec, str(bits))).toEqual(['95060001343', '05']);
    expect(codeOf(enc(spec, '95060', '0512345'))).toEqual(['INVALID_EPC', 'gcp-length']);
    expect(codeOf(enc(spec, '95060001343', '5'))).toEqual(['EPC_FIELD_OVERFLOW', 'length']);
    expect(codeOf(dec(spec, '111' + '0'.repeat(44)))).toEqual(['INVALID_EPC', 'partition']);
  });
  it('padded with K = 0 writes an empty reference', () => {
    const spec: FieldSpec = { kind: 'partition', table: SGLN_PARTITION, other: 'padded' };
    expect(dec(spec, str(enc(spec, '952656789012', '')))).toEqual(['952656789012', '']);
  });
  it('unpadded (GIAI-96)', () => {
    const spec: FieldSpec = { kind: 'partition', table: GIAI96_PARTITION, other: 'unpadded' };
    expect(dec(spec, str(enc(spec, '9521141', '5678')))).toEqual(['9521141', '5678']);
    expect(codeOf(enc(spec, '9521141', '05678'))).toEqual(['EPC_FIELD_OVERFLOW', 'leading-zero']);
  });
  it('string (GIAI-202) and 6-bit CPRef (CPI-var)', () => {
    const giai: FieldSpec = { kind: 'partition', table: GIAI202_PARTITION, other: 'string7' };
    expect(dec(giai, str(enc(giai, '9521141', '32a%2Fb')))).toEqual(['9521141', '32a%2Fb']);
    const cpi: FieldSpec = { kind: 'partition', table: CPIVAR_PARTITION, other: 'cpref6' };
    const bits = enc(cpi, '9521141', '5PQ7%2FZ43');
    expect(dec(cpi, `${str(bits)}1111`)).toEqual(['9521141', '5PQ7%2FZ43']);
  });
});

describe('6-bit fields (TDS 14.3.7, 14.3.8) and ASCII (USDOD, TDT)', () => {
  it('CAGE/DoDAAC: 5 characters get the 100000 prefix', () => {
    expect(enc({ kind: 'cage6' }, '2S194')).toBe(
      '100000' +
        Array.from('2S194', (c) => (c.charCodeAt(0) & 63).toString(2).padStart(6, '0')).join(''),
    );
    expect(dec({ kind: 'cage6' }, str(enc({ kind: 'cage6' }, 'W81X9C')))).toEqual(['W81X9C']);
  });
  it('variable 6-bit string with terminator and hash rule', () => {
    const serial: FieldSpec = { kind: 'string6Var', min: 1, max: 30, hash: 'first' };
    expect(dec(serial, `${str(enc(serial, '%23A1'))}11`)).toEqual(['%23A1']);
    expect(codeOf(enc(serial, 'A%23'))).toEqual(['INVALID_EPC', 'escape']);
    // TDS 6.3.18: ADIExtendedComponent = 0*1"%23" 1*ADIChar, so '#' alone is not a serial.
    expect(codeOf(enc(serial, '%23'))).toEqual(['EPC_FIELD_OVERFLOW', 'length']);
    expect(() => dec(serial, '000001')).toThrow(RangeError); // no terminator: the engine maps this to 'binary'
  });
  it('8-bit ASCII left-padded with spaces', () => {
    const spec: FieldSpec = { kind: 'ascii8', chars: 6 };
    expect(enc(spec, 'CAGEY')).toBe(
      Array.from(' CAGEY', (c) => c.charCodeAt(0).toString(2).padStart(8, '0')).join(''),
    );
    expect(dec(spec, str(enc(spec, 'CAGEY')))).toEqual(['CAGEY']);
  });
  it('zeros must be zero on decode', () => {
    expect(enc({ kind: 'zeros', bits: 24 })).toBe('0'.repeat(24));
    expect(codeOf(dec({ kind: 'zeros', bits: 24 }, `1${'0'.repeat(23)}`))).toEqual([
      'INVALID_EPC',
      'binary',
    ]);
  });
});

describe('engine-owned filter', () => {
  it('encodeField refuses the filter kind', () => {
    expect(codeOf(enc({ kind: 'filter', bits: 3 }))).toEqual(['INVALID_EPC', 'filter']);
  });
});

const b7 = (...v: number[]): string => v.map((x) => x.toString(2).padStart(7, '0')).join('');
const b6 = (...v: number[]): string => v.map((x) => x.toString(2).padStart(6, '0')).join('');
const a8 = (s: string): string =>
  Array.from(s, (c) => c.charCodeAt(0).toString(2).padStart(8, '0')).join('');
const BINARY = ['INVALID_EPC', 'binary'];

describe('decode error paths', () => {
  const s7: FieldSpec = { kind: 'string7', bits: 21, maxChars: 3 };
  it('string7 rejects a character after the end', () => {
    expect(codeOf(dec(s7, b7(65, 0, 65)))).toEqual(BINARY);
  });
  it('string7 rejects a character outside Table A-1', () => {
    expect(codeOf(dec(s7, b7(127, 0, 0)))).toEqual(BINARY);
  });
  it('string7 rejects non-zero padding bits', () => {
    expect(codeOf(dec({ kind: 'string7', bits: 10, maxChars: 1 }, `${b7(65)}001`))).toEqual(BINARY);
  });
  it('string7 rejects more characters than allowed', () => {
    expect(codeOf(dec({ kind: 'string7', bits: 21, maxChars: 2 }, b7(65, 65, 65)))).toEqual(BINARY);
  });

  it('string6 rejects a character outside Table G-1', () => {
    expect(codeOf(dec({ kind: 'string6Var', min: 1, max: 5, hash: 'none' }, b6(27, 0)))).toEqual(
      BINARY,
    );
  });
  it('string6 rejects # where the hash rule forbids it', () => {
    expect(codeOf(dec({ kind: 'string6Var', min: 1, max: 5, hash: 'none' }, b6(35, 0)))).toEqual(
      BINARY,
    );
  });
  it('string6 rejects # after the first character for hash first', () => {
    expect(
      codeOf(dec({ kind: 'string6Var', min: 1, max: 5, hash: 'first' }, b6(1, 35, 0))),
    ).toEqual(BINARY);
  });
  it('string6 stops at too many characters without needing a terminator', () => {
    expect(codeOf(dec({ kind: 'string6Var', min: 1, max: 2, hash: 'none' }, b6(1, 1, 1)))).toEqual(
      BINARY,
    );
  });
  it("string6 rejects a lone '#' for hash first (TDS 6.3.18: '#' needs a character after it)", () => {
    expect(codeOf(dec({ kind: 'string6Var', min: 1, max: 5, hash: 'first' }, b6(35, 0)))).toEqual(
      BINARY,
    );
  });
  it('string6 rejects an empty value', () => {
    expect(codeOf(dec({ kind: 'string6Var', min: 1, max: 2, hash: 'none' }, b6(0)))).toEqual(
      BINARY,
    );
  });

  const padded: FieldSpec = { kind: 'partition', table: SGTIN_PARTITION, other: 'padded' };
  it('partition rejects a company prefix of 10^L or more', () => {
    const bits = `001${(10 ** 11).toString(2).padStart(37, '0')}${(5).toString(2).padStart(7, '0')}`;
    expect(codeOf(dec(padded, bits))).toEqual(BINARY);
  });
  it('partition rejects a padded other part of 10^K or more', () => {
    const bits = `001${(95060001343).toString(2).padStart(37, '0')}${(100).toString(2).padStart(7, '0')}`;
    expect(codeOf(dec(padded, bits))).toEqual(BINARY);
  });

  it('cage6 rejects an invalid 6-bit group anywhere', () => {
    expect(codeOf(dec({ kind: 'cage6' }, b6(0, 2, 19, 49, 57, 52)))).toEqual(BINARY);
    expect(codeOf(dec({ kind: 'cage6' }, b6(50, 19, 49, 57, 52, 0)))).toEqual(BINARY);
    expect(codeOf(dec({ kind: 'cage6' }, b6(32, 50, 19, 49, 57, 27)))).toEqual(BINARY);
  });
  it('cage6 rejects characters I and O and 6-char codes with a prefix-like start', () => {
    expect(codeOf(dec({ kind: 'cage6' }, b6(9, 50, 19, 49, 57, 52)))).toEqual(BINARY);
  });
  it('ascii8 rejects invalid and tab-padded values', () => {
    expect(codeOf(dec({ kind: 'ascii8', chars: 6 }, a8(' ABC!1')))).toEqual(BINARY);
    expect(codeOf(dec({ kind: 'ascii8', chars: 6 }, a8('\tCAGEY')))).toEqual(BINARY);
  });
});

describe('encode error paths', () => {
  it('cage6 and ascii8 reject non-CAGE values', () => {
    expect(codeOf(enc({ kind: 'cage6' }, '2S19'))).toEqual(['INVALID_EPC', 'component']);
    expect(codeOf(enc({ kind: 'ascii8', chars: 6 }, 'AAAIO'))).toEqual([
      'INVALID_EPC',
      'component',
    ]);
  });
  it('partition rejects a non-digit company prefix', () => {
    expect(
      codeOf(enc({ kind: 'partition', table: SGTIN_PARTITION, other: 'padded' }, '95A601', '1')),
    ).toEqual(['INVALID_EPC', 'component']);
  });
});
