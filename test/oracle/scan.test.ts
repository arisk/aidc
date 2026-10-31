import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { GS1encoder } from 'gs1encoder';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDigit } from '../../src/core/index.ts';
import { parse, tryParse } from '../../src/ai/index.ts';
import { type ScanSymbology, fromScan, toScan } from '../../src/scan/index.ts';
import { type Message, messageArb } from '../support/arbitraries.ts';

const DICT = fileURLToPath(
  new URL('../../docs/specifications/data/gs1-syntax-dictionary-2026-01-27.txt', import.meta.url),
);
const RUNS = Number(process.env['ORACLE_RUNS'] ?? 2000);

let engine: GS1encoder;
beforeAll(async () => {
  engine = await GS1encoder.create({ syntaxDictionary: DICT });
});
afterAll(() => engine.free());

const toBracketed = (m: Message): string =>
  m.map(([a, v]) => `(${a})${v.replaceAll('(', '\\(')}`).join('');
const validMessage = messageArb.filter((m) => tryParse(toBracketed(m)).ok);

const SYMS: ReadonlyArray<readonly [number, ScanSymbology]> = [
  [GS1encoder.symbology.GS1_128_CCA, 'gs1-128'],
  [GS1encoder.symbology.DataBarExpanded, 'gs1-databar'],
  [GS1encoder.symbology.QR, 'gs1-qr'],
  [GS1encoder.symbology.DM, 'gs1-datamatrix'],
  [GS1encoder.symbology.DotCode, 'gs1-dotcode'],
];

describe('toScan and fromScan agree with the engine scanData', () => {
  it('for AI symbologies', () => {
    fc.assert(
      fc.property(validMessage, fc.constantFrom(...SYMS), (m, [sym, ours]) => {
        const bracketed = toBracketed(m);
        let theirs: string | null;
        try {
          engine.sym = sym;
          engine.aiDataStr = bracketed;
          theirs = engine.scanData;
        } catch {
          return; // a symbology-level limit of the engine (for example data too long)
        }
        if (theirs === null) return;
        expect(toScan(parse(bracketed), ours)).toBe(theirs);
        expect(fromScan(theirs).elementString.equals(parse(bracketed))).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('for EAN-13 GTINs', () => {
    const gtin13 = fc.stringMatching(/^\d{12}$/).map((d) => d + checkDigit(d));
    fc.assert(
      fc.property(gtin13, (g) => {
        engine.sym = GS1encoder.symbology.EAN13;
        engine.dataStr = g;
        const theirs = engine.scanData;
        expect(theirs).toBe(`]E0${g}`);
        expect(toScan(`(01)0${g}`, 'ean-13')).toBe(theirs);
        expect(fromScan(theirs ?? '').elementString.gtin).toBe(`0${g}`);
      }),
      { numRuns: RUNS },
    );
  });
});
