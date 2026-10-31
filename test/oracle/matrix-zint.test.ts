import * as fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareZXingModule, writeBarcode } from 'zxing-wasm/writer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from '../../src/ai/index.ts';
import { dataMatrix, gs1DataMatrix, gs1Qr, qr } from '../../src/symbology/matrix/index.ts';
import type { QrEcLevel } from '../../src/symbology/matrix/index.ts';
import { EC_LEVELS } from '../../src/symbology/matrix/qr-tables.ts';
import type { ModuleMatrix } from '../../src/symbology/render/index.ts';
import type { Message } from '../support/arbitraries.ts';
import { dlUriArb, gs1MessageArb, symbolToMatrix } from '../support/matrix.ts';

/** zint is a third, slower check of the same bounds: a few hundred runs (plan Task 7). */
const RUNS = Math.min(Number(process.env['ORACLE_RUNS'] ?? 2000), 300);
/** One symbol may hold part of a label's data: no association rules (decision H8). */
const LOOSE = { validateAssociations: false } as const;

// The writer's wasm comes from the installed package, never from the CDN. Kept out of
// test/support so that browser projects importing it never see zxing-wasm/writer.
beforeAll(async () => {
  const wasm = readFileSync(
    createRequire(import.meta.url).resolve('zxing-wasm/writer/zxing_writer.wasm'),
  );
  await prepareZXingModule({
    overrides: {
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    },
    fireImmediately: true,
  });
});

/**
 * zint's symbol as a module grid. `forceSquare` keeps it to the 24 squares: without it zint picks
 * DMRE sizes, which are out of scope (DataMatrix research key fact 10).
 */
async function zintMatrix(text: string, gs1: boolean): Promise<ModuleMatrix> {
  const w = await writeBarcode(text, {
    format: 'DataMatrix',
    options: gs1 ? 'gs1,forceSquare' : 'forceSquare',
    scale: 1,
    addQuietZones: false,
  });
  expect(w.error).toBe('');
  return symbolToMatrix(w.symbol);
}

/** zint reads bracketed AI syntax with no escape for a parenthesis in a value. */
const bracketed = (m: Message): string => m.map(([a, v]) => `(${a})${v}`).join('');
/**
 * zint (as built into zxing-wasm 3.1.5) omits the FNC1 separator after AI (235), treating every AI
 * starting with 23 as predefined length (the withdrawn AI 23n). GenSpecs 26.0 Table 7-6 has no 23
 * entry and says AIs not listed there are variable length, so (235) needs a separator when another
 * element string follows; zint's symbol then reads back as one long (235) value. We follow
 * GenSpecs, so (235) is kept only in last position here.
 */
const zintSeparates = (m: Message): boolean => m.slice(0, -1).every(([a]) => !a.startsWith('23'));
const gs1Arb = gs1MessageArb
  .filter((m) => m.every(([, v]) => !v.includes('(') && !v.includes(')')))
  .filter(zintSeparates)
  .map(bracketed);

const area = (m: ModuleMatrix): number => m.width * m.height;

const smaller = new Map<string, { runs: number; codewords: number; area: number }>();
function tally(
  name: string,
  oursCw: number,
  theirsCw: number,
  oursArea: number,
  theirsArea: number,
) {
  const t = smaller.get(name) ?? { runs: 0, codewords: 0, area: 0 };
  smaller.set(name, {
    runs: t.runs + 1,
    codewords: t.codewords + (oursCw < theirsCw ? 1 : 0),
    area: t.area + (oursArea < theirsArea ? 1 : 0),
  });
}
afterAll(() => {
  // Reported so the strictly-smaller rates are visible in the run output.
  for (const [name, t] of smaller)
    console.info(
      `zint ${name}: ${t.runs} runs, fewer data codewords in ${t.codewords}, smaller symbol in ${t.area}`,
    );
});

describe('DataMatrix against zint (zxing-wasm writer), squares', () => {
  it('GS1: cross-decodes, is never larger and never uses more codewords', async () => {
    await fc.assert(
      fc.asyncProperty(gs1Arb, async (s) => {
        const theirs = await zintMatrix(s, true);
        const t = gs1DataMatrix.decode(theirs);
        expect(t.elementString.equals(parse(s, LOOSE))).toBe(true);
        const ours = gs1DataMatrix.encode(s);
        const o = gs1DataMatrix.decode(ours);
        expect(o.elementString.equals(t.elementString)).toBe(true);
        expect(area(ours)).toBeLessThanOrEqual(area(theirs));
        expect(o.metadata.codewords.length).toBeLessThanOrEqual(t.metadata.codewords.length);
        tally(
          'gs1',
          o.metadata.codewords.length,
          t.metadata.codewords.length,
          area(ours),
          area(theirs),
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('Digital Link: cross-decodes, is never larger and never uses more codewords', async () => {
    await fc.assert(
      fc.asyncProperty(dlUriArb, async (uri) => {
        const theirs = await zintMatrix(uri, false);
        const t = dataMatrix.decode(theirs);
        expect(t.digitalLink).toBe(uri);
        const ours = dataMatrix.encode(uri);
        const o = dataMatrix.decode(ours);
        expect(o.digitalLink).toBe(uri);
        expect(area(ours)).toBeLessThanOrEqual(area(theirs));
        expect(o.metadata.codewords.length).toBeLessThanOrEqual(t.metadata.codewords.length);
        tally(
          'digital link',
          o.metadata.codewords.length,
          t.metadata.codewords.length,
          area(ours),
          area(theirs),
        );
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// QR Code

/** zint's QR symbol at a fixed error correction level, as a module grid. */
async function zintQr(text: string, gs1: boolean, level: QrEcLevel): Promise<ModuleMatrix> {
  const w = await writeBarcode(text, {
    format: 'QRCode',
    ...(gs1 ? { options: 'gs1' } : {}),
    ecLevel: level,
    scale: 1,
    addQuietZones: false,
  });
  expect(w.error).toBe('');
  return symbolToMatrix(w.symbol);
}

const levelArb: fc.Arbitrary<QrEcLevel> = fc.constantFrom(...EC_LEVELS);

type QrMeta = ReturnType<typeof gs1Qr.decode>['metadata'];
const qrSmaller = new Map<string, { runs: number; version: number; bits: number }>();
function qrTally(name: string, o: QrMeta, t: QrMeta): void {
  const c = qrSmaller.get(name) ?? { runs: 0, version: 0, bits: 0 };
  qrSmaller.set(name, {
    runs: c.runs + 1,
    version: c.version + (o.version < t.version ? 1 : 0),
    bits: c.bits + (o.dataBits < t.dataBits ? 1 : 0),
  });
}
afterAll(() => {
  for (const [name, c] of qrSmaller)
    console.info(
      `zint ${name}: ${c.runs} runs, smaller version in ${c.version}, fewer data bits in ${c.bits}`,
    );
});

describe('QR Code against zint (zxing-wasm writer)', () => {
  it('GS1: cross-decodes, is never larger and never uses more bits', async () => {
    await fc.assert(
      fc.asyncProperty(gs1Arb, levelArb, async (s, level) => {
        const theirs = await zintQr(s, true, level);
        const t = gs1Qr.decode(theirs);
        expect(t.elementString.equals(parse(s, LOOSE))).toBe(true);
        expect(t.metadata.ecLevel).toBe(level);
        const o = gs1Qr.decode(gs1Qr.encode(s, { ecLevel: level }));
        expect(o.elementString.equals(t.elementString)).toBe(true);
        expect(o.metadata.version).toBeLessThanOrEqual(t.metadata.version);
        expect(o.metadata.dataBits).toBeLessThanOrEqual(t.metadata.dataBits);
        qrTally('gs1', o.metadata, t.metadata);
      }),
      { numRuns: RUNS },
    );
  });

  it('Digital Link: cross-decodes, is never larger and never uses more bits', async () => {
    await fc.assert(
      fc.asyncProperty(dlUriArb, levelArb, async (uri, level) => {
        const theirs = await zintQr(uri, false, level);
        const t = qr.decode(theirs);
        expect(t.digitalLink).toBe(uri);
        expect(t.metadata.ecLevel).toBe(level);
        const o = qr.decode(qr.encode(uri, { ecLevel: level }));
        expect(o.digitalLink).toBe(uri);
        expect(o.metadata.version).toBeLessThanOrEqual(t.metadata.version);
        expect(o.metadata.dataBits).toBeLessThanOrEqual(t.metadata.dataBits);
        qrTally('digital link', o.metadata, t.metadata);
      }),
      { numRuns: RUNS },
    );
  });
});
