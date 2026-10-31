import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compressBits, compressSegment } from '../../src/digital-link/compress/encode.ts';
import { decompressSegment } from '../../src/digital-link/compress/decode.ts';
import { TABLE_F } from '../../src/digital-link/compress/tables.ts';
import { bitsToBase64url } from '../../src/core/base64url.ts';
import { VALUE_ARBS } from '../support/arbitraries.ts';

const bits = (entries: [string, string][]): unknown => compressBits(entries);
const cause = (segment: string): unknown => {
  const d = decompressSegment(segment);
  return 'cause' in d ? d.cause : 'ok';
};
const seg = (b: string): string => bitsToBase64url(b);
const fits = (ai: string, v: string): boolean => {
  let at = 0;
  for (const c of TABLE_F.get(ai) ?? []) {
    const part = c.variable ? v.slice(at) : v.slice(at, at + c.length);
    if (c.variable ? part.length > c.length : part.length !== c.length) return false;
    if (c.enc === 'N' && !/^\d*$/.test(part)) return false;
    if (part.split('').some((ch) => ch.charCodeAt(0) > 127)) return false; // 7-bit ASCII only
    at += part.length;
  }
  return at === v.length;
};
const segmentOf = (entries: [string, string][]): string => {
  const out = compressSegment(entries);
  if (typeof out !== 'string') throw new Error(`compression failed: ${out.why}`);
  return out;
};

describe('bit-level figures of DL 1.1.4 section 2.7', () => {
  it('2.7.1.1 (01)10614141123459', () => {
    expect(bits([['01', '10614141123459']])).toBe(
      '0000000100010011010011101001100000111000111101110000011',
    );
  });
  it('2.7.1.2 (7003)1903111228', () => {
    expect(bits([['7003', '1903111228']])).toBe(
      '01110000000000110001110001011011110010110000111100',
    );
  });
  it('2.7.2.1 (30)5000 uses a 4-bit length (bitLength(8); the spec figure shows 3 bits, see research 3.2)', () => {
    expect(bits([['30', '5000']])).toBe('00110000010001001110001000');
  });
  it('2.7.3.1 to 2.7.3.4 encoding indicators', () => {
    expect(bits([['10', 'XYZ*8765']])).toBe(
      '0001000010001000' +
        'XYZ*8765'
          .split('')
          .map((c) => c.charCodeAt(0).toString(2).padStart(7, '0'))
          .join(''),
    );
    expect(bits([['10', 'XYZ98765']])).toBe(
      '0001000001101000010111011000011001111101111100111011111010111001',
    );
    expect(bits([['10', 'ABC98765']])).toBe('000100000100100010101011110010011000011101100101');
    expect(bits([['10', '12398765']])).toBe('0001000000001000000101111010011000010101101');
  });
  it('2.7.4.1 optimisation 0E', () => {
    expect(
      compressSegment([
        ['01', '10614141123459'],
        ['7003', '1903111228'],
      ]),
    ).toBe('DhNOmDj3Bji3lh4');
  });
});

describe('optimisation choice (prototype greedy, ties by table order)', () => {
  it('prefers the longest sequence, then the earlier code', () => {
    const s = compressBits([
      ['01', '09506000134352'],
      ['10', 'A'],
      ['21', 'B'],
      ['17', '261231'],
    ]);
    expect(typeof s === 'string' && s.startsWith('00011010')).toBe(true); // 1A
    const t = compressBits([
      ['01', '09506000134352'],
      ['10', 'A'],
      ['21', 'B'],
    ]);
    expect(typeof t === 'string' && t.startsWith('00001011')).toBe(true); // 0B beats 0C
  });
});

describe('decompressSegment errors', () => {
  it('reports each cause', () => {
    expect(cause('ab+c')).toBe('base64url');
    expect(cause(seg('000000010001'))).toBe('truncated');
    expect(cause(seg('00010100'))).toBe('table-p'); // "14" is not in Table P
    expect(cause(seg('001000111010'))).toBe('ai-digit'); // 23 then nibble 10
    expect(cause(seg('01001010'))).toBe('reserved-code'); // 4A
    expect(cause(seg('11010001'))).toBe('version'); // D1
    expect(cause(seg('00010000101000010000000'))).toBe('encoding'); // (10) E=5
    expect(cause(seg('0001000010011111'))).toBe('length'); // (10) length 31 > 20
    expect(cause(seg('000100011111111111111111111111'))).toBe('overflow'); // (11) N6 > 999999
    expect(cause(seg('11110000000'))).toBe('non-gs1-key');
    expect(cause('ARFKk4XBoB')).toBe('padding'); // last char sets a padding bit
  });

  it('stops at a handover code (E0 to EF) without error', () => {
    const d = decompressSegment(
      seg('0000000100010011010011101001100000111000111101110000011111000001'),
    );
    expect('cause' in d ? d.cause : d.handover).toBe(true);
  });

  it('decodes non-GS1 pairs', () => {
    const d = decompressSegment(seg('111100000110000000000010000100110000010000000000001'));
    expect('cause' in d ? d : d.other).toEqual([['ABC', 'AB']]);
  });
});

describe('round trip over every Table F AI', () => {
  const entryArb = fc
    .constantFrom(...TABLE_F.keys())
    .chain((ai) => (VALUE_ARBS.get(ai) ?? fc.constant('')).map((v) => [ai, v] as [string, string]))
    .filter(([ai, v]) => fits(ai, v));

  it('decompress(compress(x)) gives x, keyed by AI and sorted as the encoder emits', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(entryArb, { selector: ([ai]) => ai, minLength: 1, maxLength: 6 }),
        (entries) => {
          const d = decompressSegment(segmentOf(entries));
          expect('cause' in d ? d : new Map(d.ais)).toEqual(new Map(entries));
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('keeps leading zeros (the prototype decoder drops them)', () => {
    const d = decompressSegment(
      segmentOf([
        ['01', '09506000134352'],
        ['21', '0012345'],
      ]),
    );
    expect('cause' in d ? d : d.ais).toEqual([
      ['01', '09506000134352'],
      ['21', '0012345'],
    ]);
  });
});

describe('encoder failures', () => {
  it('reports AIs outside Table F limits', () => {
    expect(compressBits([['8007', 'A'.repeat(25)]])).toEqual({ ai: '8007', why: 'length' });
    expect(compressBits([['89', 'X']])).toEqual({ ai: '89', why: 'not-in-table' });
    expect(compressBits([['11', '12345X']])).toEqual({ ai: '11', why: 'not-numeric' });
  });
});
