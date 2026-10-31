import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  METHOD_BY_TEXT,
  TDT_DIR,
  renderEpcTables,
  tableFMethodTexts,
} from '../../scripts/gen-epc-tables.ts';
import { integerBits } from '../../src/epc/aidc.ts';
import { aiKeyLength } from '../../src/epc/table-k.ts';
import {
  HOSTNAME_TABLE_A,
  HOSTNAME_TABLE_B,
  TABLE_F,
  TDT_TABLES_RELEASE,
} from '../../src/epc/tables.gen.ts';

interface Row {
  readonly a: string;
  readonly b: string;
}

function rowsOf(name: string): Row[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- trusted TDT JSON
  return (JSON.parse(readFileSync(`${TDT_DIR}/TDT_Table${name}.json`, 'utf8')) as { rows: Row[] })
    .rows;
}

describe('generated EPC tables', () => {
  it('matches the committed src/epc/tables.gen.ts', () => {
    expect(renderEpcTables()).toBe(readFileSync('src/epc/tables.gen.ts', 'utf8'));
  });

  it('names the release', () => {
    expect(TDT_TABLES_RELEASE).toBe('2.3 draft 2026-09-15a');
  });
});

describe('Table F', () => {
  it('sizes every component so a maximum-length value cannot overflow', () => {
    const short: string[] = [];
    for (const [ai, components] of TABLE_F) {
      for (const c of components) {
        const fits =
          c.method === 'FBL'
            ? integerBits(c.fixedChars) <= c.fixedBits
            : c.lengthBits === 0 || c.maxChars <= 1 || 2 ** c.lengthBits - 1 >= c.maxChars;
        if (!fits) short.push(`(${ai}) ${c.method}`);
      }
    }
    expect(short).toEqual([]);
  });

  it('has 532 rows', () => {
    expect(TABLE_F.size).toBe(532);
  });

  it('(01) is FLN 14/56', () => {
    expect(TABLE_F.get('01')).toEqual([
      {
        method: 'FLN',
        fixedChars: 14,
        fixedBits: 56,
        indicatorBits: 0,
        lengthBits: 0,
        maxChars: 0,
      },
    ]);
  });

  it('(253) is FLN then ALN', () => {
    expect(TABLE_F.get('253')).toEqual([
      {
        method: 'FLN',
        fixedChars: 13,
        fixedBits: 52,
        indicatorBits: 0,
        lengthBits: 0,
        maxChars: 0,
      },
      { method: 'ALN', fixedChars: 0, fixedBits: 0, indicatorBits: 3, lengthBits: 5, maxChars: 17 },
    ]);
  });

  it('(4330) is FBL then MINUS', () => {
    expect(TABLE_F.get('4330')?.map((c) => c.method)).toEqual(['FBL', 'MINUS']);
    expect(TABLE_F.get('4330')?.[0]).toMatchObject({ fixedChars: 6, fixedBits: 20 });
  });

  it('(7007) is DATERANGE', () => {
    expect(TABLE_F.get('7007')?.map((c) => c.method)).toEqual(['DATERANGE']);
  });

  it('(7040) is ALN 3/3/4', () => {
    expect(TABLE_F.get('7040')).toEqual([
      { method: 'ALN', fixedChars: 0, fixedBits: 0, indicatorBits: 3, lengthBits: 3, maxChars: 4 },
    ]);
  });

  it('(7254) allows 40 characters (F4)', () => {
    expect(TABLE_F.get('7254')?.[0]?.maxChars).toBe(40);
  });

  it('omits (8014) and (03)', () => {
    expect(TABLE_F.has('8014')).toBe(false);
    expect(TABLE_F.has('03')).toBe(false);
  });

  it('knows exactly the 13 TDT method texts', () => {
    expect(new Set(tableFMethodTexts())).toEqual(new Set(METHOD_BY_TEXT.keys()));
    expect(METHOD_BY_TEXT.size).toBe(13);
  });
});

describe('hostname tables', () => {
  it('Table A keeps only the special codes', () => {
    expect(HOSTNAME_TABLE_A.size).toBe(13);
    expect(HOSTNAME_TABLE_A.get('0011111')).toBe('www.');
    expect(HOSTNAME_TABLE_A.get('1011011')).toBe('.com');
  });

  it('Table B holds B1 to B4 without reserved codes', () => {
    expect(HOSTNAME_TABLE_B.get('00000110000000')).toBe('.tech');
    expect(HOSTNAME_TABLE_B.get('00000100000000')).toBe('.com.au');
    expect(HOSTNAME_TABLE_B.size).toBe(128 + 117 + 32 + 1);
    expect([...HOSTNAME_TABLE_B.values()].some((v) => v.startsWith('Reserved'))).toBe(false);
  });
});

describe('Table K', () => {
  const rows = rowsOf('K');

  it('matches every TDT_TableK row', () => {
    const mismatches = rows.filter((r) => aiKeyLength(r.a) !== Number(r.b));
    expect(mismatches).toEqual([]);
  });

  it('returns undefined for unused prefixes', () => {
    expect(aiKeyLength('04')).toBeUndefined();
    expect(aiKeyLength('03')).toBe(2);
  });
});
