import { readFileSync } from 'node:fs';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import file from '../vectors/epc-plus.json' with { type: 'json' };
import { VALUE_ARBS } from '../support/arbitraries.ts';
import { validate } from '../../src/ai/index.ts';
import { BitReader, BitWriter } from '../../src/core/bits.ts';
import { Gs1Error } from '../../src/core/errors.ts';
import {
  decodeAiValue,
  decodeMethod,
  encodeAiValue,
  encodeMethod,
  integerBits,
} from '../../src/epc/aidc.ts';
import { TABLE_F, type TableFComponent } from '../../src/epc/tables.gen.ts';

interface MethodVector {
  readonly source: string;
  readonly method: string;
  readonly input: string;
  readonly bits: string;
  readonly correctBits?: string;
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON vector file shape
const methods = (file.vectors as unknown as { methods: MethodVector[] }).methods;

const enc = (ai: string, value: string): string | Gs1Error => {
  const w = new BitWriter();
  const e = encodeAiValue(ai, value, w);
  return e ?? w.toString();
};
const dec = (ai: string, bits: string): string | Gs1Error => decodeAiValue(ai, new BitReader(bits));

const tableF = (ai: string): readonly TableFComponent[] => {
  const row = TABLE_F.get(ai);
  if (row === undefined) throw new Error(`no Table F row for ${ai}`);
  return row;
};
const first = (ai: string): TableFComponent => {
  const c = tableF(ai)[0];
  if (c === undefined) throw new Error(`empty Table F row for ${ai}`);
  return c;
};
/** An ALN component with a 5-bit length field, as in Fig 14-4. */
const ALN5 = first('10');

const encM = (c: TableFComponent, part: string): string | Gs1Error => {
  const w = new BitWriter();
  return encodeMethod(c, part, w) ?? w.toString();
};
const decM = (c: TableFComponent, bits: string): string | Gs1Error =>
  decodeMethod(c, new BitReader(bits));

const bcd = (digits: string): string => {
  let out = '';
  for (const d of digits) out += Number(d).toString(2).padStart(4, '0');
  return out;
};

/** Splits "(ai)value(ai)value" into pairs. */
function pairs(s: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of s.split('(').slice(1)) {
    const [ai = '', value = ''] = part.split(')');
    out.push([ai, value]);
  }
  return out;
}

// Groups built up front: method vectors exercised through one component, vectors exercised
// through whole AIs (with or without the +AIDC AI header), and skipped ones with reasons.
interface ComponentCase {
  readonly name: string;
  readonly component: TableFComponent;
  readonly input: string;
  readonly bits: string;
}
interface AiCase {
  readonly name: string;
  readonly ai: string;
  readonly input: string;
  readonly bits: string;
}
interface MultiCase {
  readonly name: string;
  readonly pairs: [string, string][];
  readonly header: boolean;
  readonly bits: string;
}
const componentCases: ComponentCase[] = [];
const aiCases: AiCase[] = [];
const multiCases: MultiCase[] = [];
const skipped: { name: string; reason: string }[] = [];
for (const v of methods) {
  const bits = v.correctBits ?? v.bits;
  const name = `${v.method}: ${v.input}`;
  const m = v.method;
  if (m.startsWith('14.5.6.')) componentCases.push({ name, component: ALN5, input: v.input, bits });
  else if (m.startsWith('14.5.5 ')) aiCases.push({ name, ai: '8004', input: v.input, bits });
  else if (m === '14.5.8 YYMMDD') aiCases.push({ name, ai: '17', input: v.input, bits });
  else if (m === '14.5.9 YYMMDDhhmm') aiCases.push({ name, ai: '7003', input: v.input, bits });
  else if (m.startsWith('14.5.10 ')) aiCases.push({ name, ai: '7007', input: v.input, bits });
  else if (m.startsWith('14.5.11 ')) aiCases.push({ name, ai: '8008', input: v.input, bits });
  else if (m.startsWith('14.5.12 ')) aiCases.push({ name, ai: '4307', input: v.input, bits });
  else if (m.startsWith('+AIDC '))
    multiCases.push({ name, pairs: pairs(v.input), header: true, bits });
  else if (m.startsWith('SGTIN+ body'))
    multiCases.push({ name, pairs: pairs(v.input), header: false, bits });
  else if (m === '14.5.3 prioritised date')
    skipped.push({ name, reason: 'prioritised date header belongs to Task 4 (DSGTIN+)' });
  else if (m.startsWith('14.5.16 '))
    skipped.push({ name, reason: 'hostname codec, not a Table F method' });
  else throw new Error(`unmapped method vector ${name}`);
}

describe('method vectors (research 4.2)', () => {
  it('accounts for all 29 vectors', () => {
    expect(componentCases.length + aiCases.length + multiCases.length + skipped.length).toBe(29);
    expect(methods).toHaveLength(29);
    expect(skipped).toHaveLength(6);
  });

  it.each(componentCases)('ALN component $name', ({ component, input, bits }) => {
    expect(encM(component, input)).toBe(bits);
    expect(decM(component, bits)).toBe(input);
  });

  it.each(aiCases)('($ai) $name', ({ ai, input, bits }) => {
    expect(enc(ai, input)).toBe(bits);
    expect(dec(ai, bits)).toBe(input);
  });

  it.each(multiCases)('$name', ({ pairs: ps, header, bits }) => {
    const w = new BitWriter();
    for (const [ai, value] of ps) {
      if (header) w.write(BigInt(`0b${bcd(ai)}`), 4 * ai.length);
      expect(encodeAiValue(ai, value, w)).toBeUndefined();
    }
    expect(w.toString()).toBe(bits);
    const r = new BitReader(bits);
    const decoded: [string, string][] = [];
    for (const [ai] of ps) {
      if (header) r.read(4 * ai.length);
      decoded.push([ai, String(decodeAiValue(ai, r))]);
    }
    expect(decoded).toEqual(ps);
    expect(r.remaining).toBe(0);
  });
});

describe('ALN encoding indicator choice (F3)', () => {
  it.each([
    ['12345', '000'],
    ['abc123', '010'],
    ['X73nA', '011'],
    ['TDS2.1', '101'],
    ['a/b', '100'],
    ['29C38A', '001'],
  ])('%s uses indicator %s', (value, indicator) => {
    expect(String(encM(ALN5, value)).slice(0, 3)).toBe(indicator);
  });

  it('X73nA takes 30 data bits in base64url (Fig 15-3)', () => {
    expect(String(encM(ALN5, 'X73nA'))).toHaveLength(3 + 5 + 30);
  });
});

describe('integer bit counts', () => {
  it('match TDT Table B column b for L = 1..90', () => {
    const text = readFileSync(
      'docs/specifications/data/tdt-2.3-draft-2026-09-15a/TDT_TableB.json',
      'utf8',
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- trusted TDT JSON
    const { rows } = JSON.parse(text) as { rows: { a: string; b: string }[] };
    expect(rows).toHaveLength(90);
    expect(rows.map((r) => integerBits(Number(r.a)))).toEqual(rows.map((r) => Number(r.b)));
  });
});

/** The most characters a Table F row holds (12 for the variable date methods). */
const maxChars = (ai: string): number =>
  tableF(ai).reduce(
    (n, c) => n + (c.maxChars > 0 ? c.maxChars : c.fixedChars > 0 ? c.fixedChars : 12),
    0,
  );

describe('round trip for every Table F row', () => {
  const ais = [...TABLE_F.keys()].filter((ai) => VALUE_ARBS.has(ai));
  const arb = fc
    .constantFrom(...ais)
    .chain((ai) => (VALUE_ARBS.get(ai) ?? fc.constant('')).map((v) => [ai, v] as const))
    .filter(
      ([ai, v]) =>
        v.length <= maxChars(ai) && validate([[ai, v]], { validateAssociations: false }).ok,
    );

  it('covers every Table F AI that the AI table knows', () => {
    expect(ais).toHaveLength(TABLE_F.size);
  });

  it('draws values for every method, the minus sign and FBL leading zeros', () => {
    const sample = fc.sample(arb, { numRuns: 3000, seed: 42 });
    const seen = new Set(sample.flatMap(([ai]) => tableF(ai).map((c) => c.method)));
    expect(seen).toEqual(new Set([...TABLE_F.values()].flatMap((cs) => cs.map((c) => c.method))));
    expect(sample.some(([ai, v]) => ai.startsWith('433') && v.endsWith('-'))).toBe(true);
    expect(sample.some(([ai, v]) => tableF(ai)[0]?.method === 'FBL' && v.startsWith('0'))).toBe(
      true,
    );
  });

  it('decodes what it encodes', () => {
    fc.assert(
      fc.property(arb, ([ai, v]) => {
        const bits = enc(ai, v);
        expect(typeof bits).toBe('string');
        const r = new BitReader(String(bits));
        expect(decodeAiValue(ai, r)).toBe(v);
        expect(r.remaining).toBe(0);
      }),
      { numRuns: 1000 },
    );
  });

  it.each([
    ['4330', '012345-'],
    ['4330', '012345'],
    ['8001', '00000000000001'],
    ['20', '07'],
    ['8003', '01234567890128'],
    ['7258', '1/2'],
    ['4321', '1'],
    ['7011', '2205311953'],
    ['8008', '22053119'],
    ['3103', '000350'],
    ['3912', '978123'],
    ['421', '528'],
  ])('(%s) %s', (ai, v) => {
    expect(dec(ai, String(enc(ai, v)))).toBe(v);
  });
});

const errorOf = (x: unknown): Gs1Error => {
  if (!(x instanceof Gs1Error)) throw new Error(`expected a Gs1Error, got ${String(x)}`);
  return x;
};
const binary = (x: unknown): unknown => {
  const e = errorOf(x);
  return { code: e.code, reason: e.details?.['reason'] };
};
const BINARY = { code: 'INVALID_EPC', reason: 'binary' };

const COMPONENT = (ai: string): unknown => ({ code: 'INVALID_EPC', reason: 'component', ai });
const shape = (x: unknown): unknown => {
  const e = errorOf(x);
  return { code: e.code, reason: e.details?.['reason'], ai: e.details?.['ai'] };
};

describe('errors', () => {
  it.each([
    ['8014', 'ABC'],
    ['03', '12345678901231'],
  ])('(%s) is not in Table F', (ai, v) => {
    const e = errorOf(enc(ai, v));
    expect([e.code, e.details]).toEqual([
      'EPC_FIELD_OVERFLOW',
      { field: ai, why: 'not-encodable' },
    ]);
  });

  it('(8007) over 24 characters is too long', () => {
    const e = errorOf(enc('8007', 'A'.repeat(25)));
    expect([e.code, e.details]).toEqual(['EPC_FIELD_OVERFLOW', { field: '8007', why: 'too-long' }]);
  });

  it('a non-digit in FLN is INVALID_EPC component', () => {
    const e = errorOf(enc('01', '0950600013435A'));
    expect([e.code, e.details]).toEqual(['INVALID_EPC', { reason: 'component', ai: '01' }]);
  });

  it('ALN indicators 110 and 111 fail', () => {
    expect(binary(dec('10', '1100000100000000'))).toEqual(BINARY);
    expect(binary(dec('10', '1110000100000000'))).toEqual(BINARY);
  });

  it('decode errors carry the AI and the start bit of the component', () => {
    const r = new BitReader(`${'0'.repeat(56)}110000010000`);
    r.read(56);
    const e = errorOf(decodeAiValue('10', r));
    expect(e.details).toEqual({ reason: 'binary', ai: '10', bit: 56 });
  });

  it('an FLN nibble 1010 fails', () => {
    expect(binary(dec('01', `1010${'0'.repeat(52)}`))).toEqual(BINARY);
  });

  it('a URN Code 40 group with r = 0 fails', () => {
    expect(binary(decM(ALN5, `10100011${'0'.repeat(16)}`))).toEqual(BINARY);
  });

  it('a URN Code 40 group over 64000 fails', () => {
    expect(binary(decM(ALN5, `10100011${(64001).toString(2)}`))).toEqual(BINARY);
  });

  it('DATE6 with month 13 fails', () => {
    expect(binary(dec('17', '0010110110111111'))).toEqual(BINARY);
  });

  it('FBL with too many digits fails', () => {
    // (20) has 2 digits in 7 bits; 100 needs 3 digits.
    expect(binary(dec('20', (100).toString(2).padStart(7, '0')))).toEqual(BINARY);
  });

  it('ALN numeric with a value of 10^L or more fails', () => {
    // L = 1 takes 4 bits; 10 is out of range.
    expect(binary(decM(ALN5, '000000011010'))).toEqual(BINARY);
  });

  it('7-bit ASCII outside CSET 82 and # fails', () => {
    expect(binary(decM(ALN5, `10000001${(0x24).toString(2).padStart(7, '0')}`))).toEqual(BINARY);
  });

  it('running out of bits throws RangeError', () => {
    expect(() => dec('01', '0000')).toThrow(RangeError);
  });

  it.each([
    ['01', '123'],
    ['20', '7A'],
    ['10', 'café'],
    ['17', '22053'],
    ['17', '221331'],
    ['17', '220532'],
    ['7003', '22053119'],
    ['7003', '2205312553'],
    ['7003', '2205311960'],
    ['7007', '2205312206'],
    ['7007', '22A531'],
    ['8008', '2205311'],
    ['8008', '220531196'],
    ['8008', '22053119A0'],
    ['4307', 'D1'],
    ['4307', 'DEU'],
    ['4321', '2'],
    ['4330', '123456+'],
    ['7258', '1/0'],
    ['7258', '12/'],
    ['7258', '1-2'],
    ['3912', '12'],
    ['30', '12A'],
  ])('(%s) %s is INVALID_EPC component', (ai, v) => {
    expect(shape(enc(ai, v))).toEqual(COMPONENT(ai));
  });

  it.each([
    ['8004', 'A'.repeat(31)],
    ['8004', '1'.repeat(31)],
    ['30', '1'.repeat(9)],
    ['421', `123${'A'.repeat(10)}`],
  ])('(%s) %s is too long', (ai, v) => {
    const e = errorOf(enc(ai, v));
    expect([e.code, e.details]).toEqual(['EPC_FIELD_OVERFLOW', { field: ai, why: 'too-long' }]);
  });

  it('encodeMethod without an AI names the method', () => {
    const long = errorOf(encM(ALN5, 'A'.repeat(21)));
    const bad = errorOf(encM(first('01'), '1'));
    expect([long.code, long.details, bad.code, bad.details, bad.ai]).toEqual([
      'EPC_FIELD_OVERFLOW',
      { field: 'ALN', why: 'too-long' },
      'INVALID_EPC',
      { reason: 'component' },
      undefined,
    ]);
  });

  it.each([
    ['ALN length over the maximum', ALN5, '00010101'],
    ['URN Code 40 PAD inside the value', ALN5, `10100001${(41).toString(2).padStart(16, '0')}`],
    ['URN Code 40 padding not PAD', ALN5, `10100001${(1641).toString(2).padStart(16, '0')}`],
    ['DATE6 year 100', first('17'), '1100100000100001'],
    ['DATE10 hour 25', first('7003'), ['0010110010111111', '11001', '000000'].join('')],
    ['DATE10 minute 60', first('7003'), ['001011001011111110011', '111100'].join('')],
    ['DATETIME second 60', first('8008'), ['10001011001011111110011110101', '111100'].join('')],
    ['DTN nibble 1010', first('8004'), '1010'],
    ['DTN over 30 digits', first('8004'), '0001'.repeat(31)],
    ['VN length over the maximum', first('30'), '1001'],
    ['VN value of 10^L', first('30'), '00011010'],
    ['COUNTRY code 26', first('4307'), '011010000000'],
    ['SEQ n = 0', first('7258'), '00000001'],
    ['SEQ m = 10', first('7258'), '00011010'],
  ])('%s fails', (_name, c, bits) => {
    const e = errorOf(decM(c, bits));
    expect([e.code, e.details]).toEqual(['INVALID_EPC', { reason: 'binary', bit: 0 }]);
  });

  it('decoding an AI without a Table F row fails', () => {
    const e = errorOf(dec('03', '0000'));
    expect([e.code, e.details]).toEqual(['INVALID_EPC', { reason: 'binary', ai: '03', bit: 0 }]);
  });
});

describe('ALN edge cases', () => {
  const ONE: TableFComponent = {
    method: 'ALN',
    fixedChars: 0,
    fixedBits: 0,
    indicatorBits: 3,
    lengthBits: 1,
    maxChars: 1,
  };

  it('a maximum of one character has no length field (14.5.6)', () => {
    expect([encM(ONE, '7'), decM(ONE, '0000111')]).toEqual(['0000111', '7']);
  });

  it('a maximum of one character rejects other lengths', () => {
    expect(errorOf(encM(ONE, '')).details).toEqual({ reason: 'component' });
  });

  it.each(['ABCD.', 'XY.Z:', 'X.Y-Z:A'])('URN Code 40 with a padded last group: %s', (v) => {
    const bits = String(encM(ALN5, v));
    expect([bits.slice(0, 3), decM(ALN5, bits)]).toEqual(['101', v]);
  });

  it('(8003) with an empty serial writes a zero length', () => {
    const bits = `${bcd('01234567890128')}00000000`;
    expect([enc('8003', '01234567890128'), dec('8003', bits)]).toEqual([bits, '01234567890128']);
  });
});
