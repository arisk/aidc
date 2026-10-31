import { describe, expect, it } from 'vitest';
import vectorsFile from '../vectors/linters.json' with { type: 'json' };
import { LINTERS } from '../../src/ai/linters/index.ts';

const ALL_REFERENCE_LINTERS = [
  'couponcode',
  'couponposoffer',
  'cset39',
  'cset64',
  'cset82',
  'csetnumeric',
  'csum',
  'csumalpha',
  'gcppos1',
  'gcppos2',
  'hasnondigit',
  'hh',
  'hhmi',
  'hyphen',
  'iban',
  'importeridx',
  'iso3166',
  'iso3166999',
  'iso3166alpha2',
  'iso4217',
  'iso5218',
  'latitude',
  'longitude',
  'mediatype',
  'mi',
  'nonzero',
  'nozeroprefix',
  'packagetype',
  'pcenc',
  'pieceoftotal',
  'posinseqslash',
  'ss',
  'winding',
  'yesno',
  'yymmd0',
  'yymmdd',
  'yyyymmd0',
  'yyyymmdd',
  'zero',
];

describe('linter registry', () => {
  it('implements every GS1 reference linter', () => {
    expect(new Set(Object.keys(LINTERS))).toEqual(new Set(ALL_REFERENCE_LINTERS));
  });

  it('every linter with vectors is registered', () => {
    const named = new Set((vectorsFile.vectors as Array<{ linter: string }>).map((v) => v.linter));
    for (const n of named) expect(Object.keys(LINTERS)).toContain(n);
  });
});
