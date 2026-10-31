import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import vectors from '../../vectors/qr.json' with { type: 'json' };
import {
  EC_LEVELS,
  countBits,
  decodeFormat,
  decodeVersion,
  formatBits,
  qrVersion,
  versionBits,
  versionGroup,
} from '../../../src/symbology/matrix/qr-tables.ts';
import type { QrEcLevel } from '../../../src/symbology/matrix/qr-tables.ts';

const { tables } = vectors;

function toLevel(s: string): QrEcLevel {
  const level = EC_LEVELS.find((l) => l === s);
  if (!level) throw new Error(`bad level ${s}`);
  return level;
}

function flip(bits: number, positions: readonly number[]): number {
  return positions.reduce((v, p) => v ^ (1 << p), bits);
}

function distinctBits(count: number, width: number) {
  return fc.uniqueArray(fc.integer({ min: 0, max: width - 1 }), {
    minLength: count,
    maxLength: count,
  });
}

describe('qrVersion', () => {
  it('has 40 rows of the vector table', () => {
    expect(tables.versions).toHaveLength(40);
  });

  for (const row of tables.versions) {
    it(`matches the vector for version ${row.version}`, () => {
      const v = qrVersion(row.version);
      expect(v.version).toBe(row.version);
      expect(v.size).toBe(row.size);
      expect([...v.alignment]).toEqual(row.alignmentCentres);
      expect(v.totalCodewords).toBe(row.totalCodewords);
      expect(Math.floor(row.dataModules / 8)).toBe(v.totalCodewords);
      expect(v.remainderBits).toBe(row.dataModules % 8);
      expect(v.remainderBits).toBe(row.remainderBits);
      for (const level of EC_LEVELS) {
        const want = row.levels[level];
        const got = v.levels[level];
        expect(got.dataCodewords).toBe(want.dataCodewords);
        expect(got.ecPerBlock).toBe(want.ecCodewordsPerBlock);
        const split = want.blocks.flatMap((g) => Array<number>(g.count).fill(g.dataCodewords));
        expect([...got.blockData]).toEqual(split);
        expect(got.blockData.reduce((a, b) => a + b, 0)).toBe(got.dataCodewords);
      }
    });
  }

  it('is frozen and cached', () => {
    const v = qrVersion(10);
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.levels.L)).toBe(true);
    expect(qrVersion(10)).toBe(v);
  });

  it('rejects versions outside 1..40', () => {
    expect(() => qrVersion(0)).toThrow(RangeError);
    expect(() => qrVersion(41)).toThrow(RangeError);
    expect(() => qrVersion(1.5)).toThrow(RangeError);
  });

  it('applies the Q8 correction limits', () => {
    expect(qrVersion(1).levels.L.correctable).toBe(2);
    expect(qrVersion(1).levels.M.correctable).toBe(4);
    expect(qrVersion(2).levels.L.correctable).toBe(4);
    expect(qrVersion(3).levels.L.correctable).toBe(7);
    expect(qrVersion(5).levels.Q.correctable).toBe(9);
    expect(qrVersion(40).levels.H.correctable).toBe(15);
  });

  it('reproduces the 40-L maxima of GenSpecs 5.7.2', () => {
    const b = 8 * qrVersion(40).levels.L.dataCodewords - 4 - countBits('numeric', 40);
    const numeric = 3 * Math.floor(b / 10) + (b % 10 >= 7 ? 2 : b % 10 >= 4 ? 1 : 0);
    const a = 8 * qrVersion(40).levels.L.dataCodewords - 4 - countBits('alphanumeric', 40);
    const alnum = 2 * Math.floor(a / 11) + (a % 11 >= 6 ? 1 : 0);
    const y = 8 * qrVersion(40).levels.L.dataCodewords - 4 - countBits('byte', 40);
    expect([numeric, alnum, Math.floor(y / 8)]).toEqual([7089, 4296, 2953]);
  });
});

describe('format information', () => {
  it('formatBits equals all 32 vector codes', () => {
    expect(tables.formatInfo).toHaveLength(32);
    for (const f of tables.formatInfo) {
      expect(formatBits(toLevel(f.level), f.mask)).toBe(f.bits);
    }
  });

  it('decodes every code with up to 3 flipped bits in one copy and a random other copy', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...tables.formatInfo),
        distinctBits(3, 15),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 0x7fff }),
        fc.boolean(),
        (f, positions, errors, other, firstCopy) => {
          const damaged = flip(f.bits, positions.slice(0, errors));
          const got = firstCopy ? decodeFormat(damaged, other) : decodeFormat(other, damaged);
          // A random other copy may itself be a different valid code at lower distance.
          const otherDistance = Math.min(...tables.formatInfo.map((c) => popcount(c.bits ^ other)));
          fc.pre(otherDistance > errors || otherDistance > 3);
          expect(got).toEqual({ level: f.level, mask: f.mask });
        },
      ),
    );
  });

  it('is undefined when both copies are at least 4 from every code', () => {
    const pairs: [number, number][] = [];
    for (let a = 0; a < 0x8000; a += 7) pairs.push([a, (a * 31 + 5) & 0x7fff]);
    const farPairs = pairs.filter(([a, b]) => far(a) && far(b));
    expect(farPairs.length).toBeGreaterThan(0);
    expect(farPairs.filter(([a, b]) => decodeFormat(a, b) !== undefined)).toEqual([]);
  });
});

describe('version information', () => {
  it('matches known values', () => {
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(33)).toBe(0x216f0);
  });

  it('matches every vector value', () => {
    for (const row of tables.versions) {
      expect(row.version >= 7 ? versionBits(row.version) : null).toBe(row.versionInfo);
    }
  });

  it('corrects up to 3 bit errors for every version 7..40', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 7, max: 40 }),
        distinctBits(3, 18),
        fc.integer({ min: 0, max: 3 }),
        (version, positions, errors) => {
          const got = decodeVersion(flip(versionBits(version), positions.slice(0, errors)));
          expect(got).toEqual({ version, distance: errors });
        },
      ),
    );
  });

  it("decodes the engine's wrong 0x216FD as version 33 at distance 3", () => {
    expect(decodeVersion(0x216fd)).toEqual({ version: 33, distance: 3 });
  });

  it('is undefined beyond distance 3', () => {
    expect(decodeVersion(flip(versionBits(20), [0, 1, 2, 3, 4]))).toBeUndefined();
    expect(decodeVersion(0)).toBeUndefined();
  });
});

describe('character count bits', () => {
  it('matches the vector for all modes and groups', () => {
    const versions = [1, 9, 10, 26, 27, 40];
    const groups = [0, 0, 1, 1, 2, 2];
    for (const mode of ['numeric', 'alphanumeric', 'byte', 'kanji'] as const) {
      versions.forEach((v, i) => {
        expect(versionGroup(v)).toBe(groups[i]);
        expect(countBits(mode, v)).toBe(tables.characterCountBits[mode][groups[i]!]);
      });
    }
  });
});

function popcount(x: number): number {
  let n = 0;
  for (let v = x; v; v &= v - 1) n++;
  return n;
}

function far(x: number): boolean {
  return tables.formatInfo.every((c) => popcount(c.bits ^ x) >= 4);
}
