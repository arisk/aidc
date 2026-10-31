import { describe, expect, it } from 'vitest';
import { AI_TABLE } from '../../src/ai/table.gen.ts';
import {
  TABLE_F,
  TABLE_OPT,
  TABLE_P,
  lengthBits,
  valueBits,
} from '../../src/digital-link/compress/tables.ts';

describe('Table F (DL 1.1.4 section 2.5.2)', () => {
  it('covers exactly the Syntax Dictionary AIs', () => {
    expect(new Set(TABLE_F.keys())).toEqual(new Set(AI_TABLE.map((e) => e.ai)));
    expect(TABLE_F.size).toBe(541);
  });

  it('keeps the frozen values that differ from the Syntax Dictionary', () => {
    expect(TABLE_F.get('8007')).toEqual([{ enc: 'X', length: 24, variable: true }]);
    expect(TABLE_F.get('8013')).toEqual([{ enc: 'X', length: 30, variable: true }]);
    expect(TABLE_F.get('7040')).toEqual([
      { enc: 'N', length: 1, variable: false },
      { enc: 'X', length: 3, variable: false },
    ]);
    expect(TABLE_F.get('255')).toEqual([
      { enc: 'N', length: 13, variable: false },
      { enc: 'N', length: 12, variable: true },
    ]);
    expect(TABLE_F.get('3925')).toEqual([{ enc: 'N', length: 15, variable: true }]);
  });
});

describe('Table P (section 2.5.3)', () => {
  it('matches the spec table', () => {
    expect(Object.fromEntries(TABLE_P)).toEqual({
      '00': 2,
      '01': 2,
      '02': 2,
      '03': 2,
      '10': 2,
      '11': 2,
      '12': 2,
      '13': 2,
      '15': 2,
      '16': 2,
      '17': 2,
      '20': 2,
      '21': 2,
      '22': 2,
      '23': 3,
      '24': 3,
      '25': 3,
      '30': 2,
      '31': 4,
      '32': 4,
      '33': 4,
      '34': 4,
      '35': 4,
      '36': 4,
      '37': 2,
      '39': 4,
      '40': 3,
      '41': 3,
      '42': 3,
      '43': 4,
      '70': 4,
      '71': 3,
      '72': 4,
      '80': 4,
      '81': 4,
      '82': 4,
      '90': 2,
      '91': 2,
      '92': 2,
      '93': 2,
      '94': 2,
      '95': 2,
      '96': 2,
      '97': 2,
      '98': 2,
      '99': 2,
    });
  });
});

describe('Table Opt (section 2.6)', () => {
  it('has 52 codes in ascending order, all AIs in Table F', () => {
    expect(TABLE_OPT.length).toBe(52);
    for (let i = 1; i < TABLE_OPT.length; i++)
      expect((TABLE_OPT[i]?.[0] ?? 0) > (TABLE_OPT[i - 1]?.[0] ?? 0)).toBe(true);
    expect(TABLE_OPT.flatMap(([, ais]) => ais).filter((ai) => !TABLE_F.has(ai))).toEqual([]);
    expect(TABLE_OPT[0]).toEqual([0x0a, ['01', '22']]);
    expect(TABLE_OPT[6]).toEqual([0x1a, ['01', '10', '21', '17']]);
  });
});

describe('bit widths (C6-C9)', () => {
  it('lengthBits is bitLength(max)', () => {
    expect([1, 2, 3, 4, 7, 8, 20, 30, 34, 70, 90, 127].map(lengthBits)).toEqual([
      1, 2, 2, 3, 3, 4, 5, 5, 6, 7, 7, 7,
    ]);
  });

  it('valueBits matches the committed lookup, including the +0.01 quirks', () => {
    const LOOKUP = [
      1, 4, 7, 10, 14, 17, 20, 24, 27, 30, 34, 37, 40, 44, 47, 50, 54, 57, 60, 64, 67, 70, 74, 77,
      80, 84, 87, 90, 94, 97, 100, 103, 107, 110, 113, 117, 120, 123, 127, 130, 133, 137, 140, 143,
      147, 150, 153, 157, 160, 163, 167, 170, 173, 177, 180, 183, 187, 190, 193, 197, 200, 203, 206,
      210, 213, 216, 220, 223, 226, 230, 233, 236, 240, 243, 246, 250, 253, 256, 260, 263, 266, 270,
      273, 276, 280, 283, 286, 290, 293, 296, 299, 303, 306, 309, 313, 316, 319, 323, 326, 329, 333,
      336, 339, 343, 346, 349, 353, 356, 359, 363, 366, 369, 373, 376, 379, 383, 386, 389, 392, 396,
      399, 402, 406, 409, 412, 416, 419, 422,
    ];
    expect(Array.from({ length: 128 }, (_, l) => valueBits(l))).toEqual(LOOKUP);
    expect(valueBits(59)).toBe(197);
  });
});
