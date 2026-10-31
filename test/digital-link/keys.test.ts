import { describe, expect, it } from 'vitest';
import file from '../vectors/digital-link.json' with { type: 'json' };
import {
  choosePathQualifiers,
  isPrimaryKey,
  isValidKeyPath,
  shouldBeInPath,
} from '../../src/digital-link/keys.ts';

interface SeqVector {
  readonly kind: string;
  readonly input: string;
  readonly expect: boolean;
}
const all: readonly unknown[] = file.vectors;
function isSeqVector(v: unknown): v is SeqVector {
  return typeof v === 'object' && v !== null && 'kind' in v && v.kind === 'validPathSeq';
}
const seqs: readonly SeqVector[] = all.filter(isSeqVector);
const set = (...ais: string[]): ReadonlySet<string> => new Set(ais);

describe('isValidKeyPath (dl.c validPathSeq vectors)', () => {
  it('has the dl.c vectors', () => expect(seqs.length).toBe(37));
  for (const v of seqs) {
    it(`${v.input} -> ${v.expect}`, () =>
      expect(isValidKeyPath(v.input.split(' '))).toBe(v.expect));
  }
});

describe('primary keys (DL 4.3)', () => {
  it('are exactly the AIs with dlpkey', () => {
    const keys = [
      '00',
      '01',
      '253',
      '255',
      '401',
      '402',
      '414',
      '415',
      '417',
      '8003',
      '8004',
      '8006',
      '8010',
      '8013',
      '8017',
      '8018',
    ];
    expect(keys.filter((k) => !isPrimaryKey(k))).toEqual([]);
    expect(
      ['10', '21', '22', '99', '8020', '3103', 'gtin', ''].filter((k) => isPrimaryKey(k)),
    ).toEqual([]);
  });
});

describe('shouldBeInPath', () => {
  it('flags a qualifier that fits the path', () => {
    expect(shouldBeInPath(['01'], '10')).toBe(true);
    expect(shouldBeInPath(['01', '21'], '22')).toBe(true);
  });
  it('accepts attributes that cannot join the path', () => {
    expect(shouldBeInPath(['01', '235'], '10')).toBe(false);
    expect(shouldBeInPath(['00'], '10')).toBe(false);
    expect(shouldBeInPath(['01'], '17')).toBe(false);
  });
});

describe('choosePathQualifiers (plan decision D5)', () => {
  it('takes every present qualifier, in dlpkey order', () => {
    expect(choosePathQualifiers('01', set('01', '21', '10', '99'))).toEqual(['10', '21']);
    expect(choosePathQualifiers('01', set('01', '22', '10', '21'))).toEqual(['22', '10', '21']);
  });
  it('prefers the alternative that leaves only data attributes', () => {
    // (10) is a data attribute, (235) is not: put 235 in the path.
    expect(choosePathQualifiers('01', set('01', '235', '10'))).toEqual(['235']);
  });
  it('otherwise breaks ties lexically, as dl.c does', () => {
    expect(choosePathQualifiers('01', set('01', '22', '235'))).toEqual(['22']);
    expect(choosePathQualifiers('414', set('414', '254', '7040'))).toEqual(['254']);
  });
  it('returns nothing for keys without qualifiers', () => {
    expect(choosePathQualifiers('00', set('00', '10'))).toEqual([]);
  });
});
