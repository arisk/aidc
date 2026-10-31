import { describe, expect, it } from 'vitest';
import { ElementString, format, hri, parse } from '../../src/index.ts';

const GS = '\u001d';

describe('format', () => {
  const es = parse('(01)09506000134352(10)AB\\(C(17)201225');

  it('bracketed escapes "(" (Review Focus 1)', () => {
    expect(format(es)).toBe('(01)09506000134352(10)AB\\(C(17)201225');
    expect(parse(format(es)).equals(es)).toBe(true);
  });

  it('raw inserts GS only after AIs that need it, never at the end', () => {
    expect(format(es, 'raw')).toBe(`010950600013435210AB(C${GS}17201225`);
    expect(format(parse('(01)09506000134352(10)ABC'), 'raw')).toBe('010950600013435210ABC');
  });

  it('raw with optimizeOrder puts predefined-length AIs first', () => {
    expect(format(es, 'raw', { optimizeOrder: true })).toBe(`01095060001343521720122510AB(C`);
  });

  it('raw treats unknown AIs as needing a separator', () => {
    const u = ElementString.from(
      [
        ['0599', 'x'],
        ['0598', 'y'],
      ],
      { allowUnknownAIs: true },
    );
    expect(format(u, 'raw')).toBe(`0599x${GS}0598y`);
  });

  it('hri is unescaped', () => {
    expect(format(es, 'hri')).toBe('(01)09506000134352(10)AB(C(17)201225');
  });

  it('only bracketed text round-trips a value that looks like an AI (security review)', () => {
    const forged = parse('(01)09506000134352(10)X\\(17)991231');
    expect(forged.get('17')).toBeUndefined();
    expect(parse(format(forged)).equals(forged)).toBe(true);
    // HRI is display text: parsing it back reads the batch as a batch and an expiry date.
    expect(parse(format(forged, 'hri')).get('17')).toBe('991231');
    expect(parse(hri(forged).join(' ')).get('17')).toBe('991231');
  });

  // Known limitation (parse.ts): a value ending in a backslash cannot round-trip through the bracketed parser.
});

describe('hri lines', () => {
  const es = ElementString.from([
    ['01', '09506000134352'],
    ['10', 'ABC'],
  ]);
  it('matches the Syntax Engine layout', () => {
    expect(hri(es)).toEqual(['(01) 09506000134352', '(10) ABC']);
    expect(hri(es, { titles: true })).toEqual(['GTIN (01) 09506000134352', 'BATCH/LOT (10) ABC']);
  });

  it('titles unknown AIs UNKNOWN, as the Syntax Engine does (oracle regression)', () => {
    const u = ElementString.from([['0599', 'x']], { allowUnknownAIs: true });
    expect(hri(u, { titles: true })).toEqual(['UNKNOWN (0599) x']);
  });
});
