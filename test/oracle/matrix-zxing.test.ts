import * as fc from 'fast-check';
import { readBarcodes, type ReadResult } from 'zxing-wasm/reader';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ElementString, parse } from '../../src/ai/index.ts';
import { dataMatrix, gs1DataMatrix, gs1Qr, qr } from '../../src/symbology/matrix/index.ts';
import type { DmSizeOption, QrEcLevel } from '../../src/symbology/matrix/index.ts';
import { EC_LEVELS, qrVersion } from '../../src/symbology/matrix/qr-tables.ts';
import { DM_SIZES, dmBlockEc, type DmSize } from '../../src/symbology/matrix/dm-tables.ts';
import { fromScan } from '../../src/scan/index.ts';
import type { ModuleMatrix } from '../../src/symbology/render/index.ts';
import {
  damageCodewords,
  damageQrCodewords,
  dlUriArb,
  gs1MessageArb,
  rasteriseMatrix,
  toBracketed,
} from '../support/matrix.ts';
import { initZxingNode } from '../support/symbology.ts';

const RUNS = Number(process.env['ORACLE_RUNS'] ?? 2000);
/** Sizes above 64x64 are slow to rasterise and read: at most 50 runs (plan Task 7). */
const LARGE_RUNS = Math.min(RUNS, 50);
const NON_PURE_RUNS = 50;
/** One symbol may hold part of a label's data: no association rules (decision H8). */
const LOOSE = { validateAssociations: false } as const;

beforeAll(initZxingNode);

const isLarge = (s: DmSize): boolean => s.rows * s.columns > 64 * 64;

/** zxing's only DataMatrix result for a raster of `m`. */
async function read(m: ModuleMatrix, pure: boolean): Promise<ReadResult> {
  const results = await readBarcodes(rasteriseMatrix(m, 2, pure ? 2 : 1), {
    formats: ['DataMatrix'],
    isPure: pure,
  });
  expect(results).toHaveLength(1);
  const r = results[0];
  if (r === undefined) throw new Error('zxing read nothing');
  return r;
}

interface ZxingExtra {
  readonly Version?: string;
  readonly ECLevel?: string;
  readonly DataMask?: number;
  readonly UEC?: number;
}

function extraOf(r: ReadResult): ZxingExtra {
  // oxlint-disable-next-line no-unsafe-type-assertion -- zxing documents extra as JSON of this shape
  return JSON.parse(r.extra) as ZxingExtra;
}

const scanOf = (r: ReadResult): string => r.symbologyIdentifier + new TextDecoder().decode(r.bytes);

/** Smallest data codeword count of a symbol's data: its 'auto' symbol, read by our decoder. */
const needed = (auto: ModuleMatrix): number => dataMatrix.decode(auto).metadata.codewords.length;

/** A size option for a symbol of `n` data codewords: a shape, or one exact size that fits. */
function sizeOptionArb(n: number, large: boolean): fc.Arbitrary<DmSizeOption> {
  const exact = DM_SIZES.filter((s) => s.dataCodewords >= n && isLarge(s) === large).map(
    (s): DmSizeOption => ({ rows: s.rows, columns: s.columns }),
  );
  if (large) return fc.constantFrom(...exact);
  const shapes: DmSizeOption[] = ['square', 'auto', ...(n <= 49 ? ['rectangular' as const] : [])];
  return exact.length === 0 ? fc.constantFrom(...shapes) : fc.constantFrom(...shapes, ...exact);
}

interface Case {
  readonly matrix: ModuleMatrix;
  /** The element string the symbol carries (the input's, or for a URI our decoder's). */
  readonly elementString: ElementString;
  /** The input URI, or undefined for a GS1 message. */
  readonly digitalLink: string | undefined;
}

const gs1CaseArb = (large: boolean): fc.Arbitrary<Case> =>
  gs1MessageArb.map(toBracketed).chain((s) =>
    sizeOptionArb(needed(gs1DataMatrix.encode(s, { size: 'auto' })), large).map((size) => ({
      matrix: gs1DataMatrix.encode(s, { size }),
      elementString: parse(s, LOOSE),
      digitalLink: undefined,
    })),
  );

const dlCaseArb = (large: boolean): fc.Arbitrary<Case> =>
  dlUriArb.chain((uri) =>
    sizeOptionArb(needed(dataMatrix.encode(uri, { size: 'auto' })), large).map((size) => {
      const matrix = dataMatrix.encode(uri, { size });
      return { matrix, elementString: dataMatrix.decode(matrix).elementString, digitalLink: uri };
    }),
  );

describe('zxing-wasm reads our DataMatrix symbols', () => {
  it.each([
    ['GS1 messages (pure)', gs1CaseArb(false), RUNS, true],
    ['Digital Link URIs (pure)', dlCaseArb(false), RUNS, true],
    ['GS1 messages, sizes above 64x64 (pure)', gs1CaseArb(true), LARGE_RUNS, true],
    ['Digital Link URIs, sizes above 64x64 (pure)', dlCaseArb(true), LARGE_RUNS, true],
    ['GS1 messages (not pure, 1-module quiet zone)', gs1CaseArb(false), NON_PURE_RUNS, false],
    ['Digital Link URIs (not pure, 1-module quiet zone)', dlCaseArb(false), NON_PURE_RUNS, false],
  ] as const)('%s', async (_name, arb, numRuns, pure) => {
    await fc.assert(
      fc.asyncProperty(arb, async (c) => {
        const ours = dataMatrix.decode(c.matrix);
        const r = await read(c.matrix, pure);
        const theirs = scanOf(r);
        expect(theirs).toBe(ours.aimId + ours.rawData);
        expect(extraOf(r).Version).toBe(`${ours.metadata.rows}x${ours.metadata.columns}`);
        const scanned = fromScan(theirs, LOOSE);
        expect(scanned.digitalLink).toBe(c.digitalLink);
        expect(scanned.elementString.equals(c.elementString)).toBe(true);
      }),
      { numRuns: Math.min(RUNS, numRuns) },
    );
  });
});

/** Single-block sizes (every rectangle and the squares up to 44x44). */
const SINGLE_BLOCK = DM_SIZES.filter((s) => s.blocks === 1);

interface DamageCase {
  readonly input: string;
  readonly size: DmSize;
  readonly plan: readonly { codeword: number; xor: number }[];
}

const damageCaseArb: fc.Arbitrary<DamageCase> = gs1MessageArb.map(toBracketed).chain((s) => {
  const n = needed(gs1DataMatrix.encode(s, { size: 'auto' }));
  const sizes = SINGLE_BLOCK.filter((z) => z.dataCodewords >= n);
  return fc.constantFrom(...sizes).chain((size) => {
    const total = size.dataCodewords + size.ecCodewords;
    const t = Math.floor(dmBlockEc(size) / 2);
    return fc
      .uniqueArray(fc.integer({ min: 0, max: total - 1 }), { minLength: 0, maxLength: t })
      .chain((positions) =>
        fc
          .array(fc.integer({ min: 1, max: 255 }), {
            minLength: positions.length,
            maxLength: positions.length,
          })
          .map((xors) => ({
            input: s,
            size,
            plan: positions.map((codeword, i) => ({ codeword, xor: xors[i] ?? 1 })),
          })),
      );
  });
});

describe('errorsCorrected agrees with zxing-wasm', () => {
  it('on single-block symbols with codeword errors within capacity', async () => {
    await fc.assert(
      fc.asyncProperty(damageCaseArb, async (c) => {
        const clean = gs1DataMatrix.encode(c.input, {
          size: { rows: c.size.rows, columns: c.size.columns },
        });
        const damaged = damageCodewords(clean, c.size, c.plan);
        const ours = gs1DataMatrix.decode(damaged);
        expect(ours.errorsCorrected).toBe(c.plan.length);
        expect(ours.rawData).toBe(gs1DataMatrix.decode(clean).rawData);
        const r = await read(damaged, true);
        expect(scanOf(r)).toBe(ours.aimId + ours.rawData);
        const uec = extraOf(r).UEC;
        expect(uec).toBeTypeOf('number');
        const t = Math.floor(dmBlockEc(c.size) / 2);
        expect(Math.round((1 - (uec ?? Number.NaN)) * t)).toBe(ours.errorsCorrected);
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// QR Code

/** The 4-module quiet zone of a QR symbol (decision Q14), or the nominal 2 modules when pure. */
async function readQrSymbol(m: ModuleMatrix, pure: boolean): Promise<ReadResult> {
  const results = await readBarcodes(rasteriseMatrix(m, 2, pure ? 2 : 4), {
    formats: ['QRCode'],
    isPure: pure,
  });
  expect(results).toHaveLength(1);
  const r = results[0];
  if (r === undefined) throw new Error('zxing read nothing');
  return r;
}

const QR_LARGE_RUNS = Math.min(RUNS, 50);
const levelArb: fc.Arbitrary<QrEcLevel> = fc.constantFrom(...EC_LEVELS);
const QR_VERSIONS = Array.from({ length: 40 }, (_, i) => i + 1);

interface QrCase {
  readonly matrix: ModuleMatrix;
  readonly elementString: ElementString;
  readonly digitalLink: string | undefined;
}

/** A version choice: 'auto', or one version that holds the data (above 20 only when `large`). */
const versionArb = (minimum: number, large: boolean): fc.Arbitrary<'auto' | number> =>
  large
    ? fc.constantFrom(...QR_VERSIONS.filter((v) => v > 20 && v >= minimum))
    : fc.constantFrom('auto' as const, ...QR_VERSIONS.filter((v) => v <= 20 && v >= minimum));
const maskArb: fc.Arbitrary<'auto' | number> = fc.constantFrom<'auto' | number>(
  'auto',
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
);

const qrGs1CaseArb = (large: boolean): fc.Arbitrary<QrCase> =>
  fc.tuple(gs1MessageArb.map(toBracketed), levelArb, maskArb).chain(([s, ecLevel, mask]) =>
    versionArb(gs1Qr.decode(gs1Qr.encode(s, { ecLevel })).metadata.version, large).map(
      (version) => ({
        matrix: gs1Qr.encode(s, { ecLevel, version, mask }),
        elementString: parse(s, LOOSE),
        digitalLink: undefined,
      }),
    ),
  );

const qrDlCaseArb = (large: boolean): fc.Arbitrary<QrCase> =>
  fc.tuple(dlUriArb, levelArb, maskArb).chain(([uri, ecLevel, mask]) =>
    versionArb(qr.decode(qr.encode(uri, { ecLevel })).metadata.version, large).map((version) => {
      const matrix = qr.encode(uri, { ecLevel, version, mask });
      return { matrix, elementString: qr.decode(matrix).elementString, digitalLink: uri };
    }),
  );

describe('zxing-wasm reads our QR Code symbols', () => {
  it.each([
    ['GS1 messages (pure)', qrGs1CaseArb(false), RUNS, true],
    ['Digital Link URIs (pure)', qrDlCaseArb(false), RUNS, true],
    ['GS1 messages, versions above 20 (pure)', qrGs1CaseArb(true), QR_LARGE_RUNS, true],
    ['Digital Link URIs, versions above 20 (pure)', qrDlCaseArb(true), QR_LARGE_RUNS, true],
    ['GS1 messages (not pure, 4-module quiet zone)', qrGs1CaseArb(false), NON_PURE_RUNS, false],
    ['Digital Link URIs (not pure, 4-module quiet zone)', qrDlCaseArb(false), NON_PURE_RUNS, false],
  ] as const)('%s', async (_name, arb, numRuns, pure) => {
    await fc.assert(
      fc.asyncProperty(arb, async (c) => {
        const ours = qr.decode(c.matrix);
        const r = await readQrSymbol(c.matrix, pure);
        const theirs = scanOf(r);
        expect(theirs).toBe(ours.aimId + ours.rawData);
        const extra = extraOf(r);
        expect(extra.Version).toBe(String(ours.metadata.version));
        expect(extra.ECLevel).toBe(ours.metadata.ecLevel);
        expect(extra.DataMask).toBe(ours.metadata.mask);
        const scanned = fromScan(theirs, LOOSE);
        expect(scanned.digitalLink).toBe(c.digitalLink);
        expect(scanned.elementString.equals(c.elementString)).toBe(true);
      }),
      { numRuns: Math.min(RUNS, numRuns) },
    );
  });

  it('reads a literal % and separators in GS1 data at every level', async () => {
    const set = ['(10)%A', '(99)%%%', '(10)ABC%(99)X', '(10)A%B%%(21)%', '(10)ab%(99)%C'];
    const cases = set.flatMap((s) => EC_LEVELS.map((ecLevel) => ({ s, ecLevel })));
    await Promise.all(
      cases.map(async ({ s, ecLevel }) => {
        const m = gs1Qr.encode(s, { ecLevel });
        const ours = gs1Qr.decode(m);
        expect(scanOf(await readQrSymbol(m, true))).toBe(ours.aimId + ours.rawData);
        expect(ours.elementString.equals(parse(s, LOOSE))).toBe(true);
      }),
    );
  });
});

/** Single-block version and level combinations among versions 1 to 5. */
const SINGLE_BLOCK_QR = QR_VERSIONS.filter((v) => v <= 5).flatMap((version) =>
  EC_LEVELS.filter((l) => qrVersion(version).levels[l].blockData.length === 1).map(
    (ecLevel) => [version, ecLevel] as const,
  ),
);

/**
 * The errors to inject: zxing corrects floor(ec / 2); we apply the ISO misdecode limit
 * (decision Q8), so 1-L, 1-M and 2-L, where they differ, stay one error below the limit.
 */
function maxInjected(version: number, level: QrEcLevel): number {
  const info = qrVersion(version).levels[level];
  const limit = Math.floor(info.ecPerBlock / 2);
  return info.correctable < limit ? info.correctable - 1 : limit;
}

interface QrDamageCase {
  readonly input: string;
  readonly version: number;
  readonly ecLevel: QrEcLevel;
  readonly plan: readonly { codeword: number; xor: number }[];
}

const qrDamageCaseArb: fc.Arbitrary<QrDamageCase> = gs1MessageArb.map(toBracketed).chain((s) =>
  fc.constantFrom(...SINGLE_BLOCK_QR).chain(([version, ecLevel]) => {
    const info = qrVersion(version).levels[ecLevel];
    const total = info.dataCodewords + info.ecPerBlock;
    return fc
      .uniqueArray(fc.integer({ min: 0, max: total - 1 }), {
        minLength: 0,
        maxLength: maxInjected(version, ecLevel),
      })
      .chain((positions) =>
        fc
          .array(fc.integer({ min: 1, max: 255 }), {
            minLength: positions.length,
            maxLength: positions.length,
          })
          .map((xors) => ({
            input: s,
            version,
            ecLevel,
            plan: positions.map((codeword, i) => ({ codeword, xor: xors[i] ?? 1 })),
          })),
      );
  }),
);

describe('QR errorsCorrected agrees with zxing-wasm', () => {
  it('on single-block symbols with codeword errors within capacity', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A message that does not fit the chosen version is skipped (encode would fail).
        qrDamageCaseArb.filter(
          (c) => gs1Qr.tryEncode(c.input, { ecLevel: c.ecLevel, version: c.version }).ok,
        ),
        async (c) => {
          const clean = gs1Qr.encode(c.input, { ecLevel: c.ecLevel, version: c.version });
          const damaged = damageQrCodewords(clean, c.version, c.plan);
          const ours = gs1Qr.decode(damaged);
          expect(ours.errorsCorrected).toBe(c.plan.length);
          expect(ours.rawData).toBe(gs1Qr.decode(clean).rawData);
          const r = await readQrSymbol(damaged, true);
          expect(scanOf(r)).toBe(ours.aimId + ours.rawData);
          const uec = extraOf(r).UEC;
          expect(uec).toBeTypeOf('number');
          const t = Math.floor(qrVersion(c.version).levels[c.ecLevel].ecPerBlock / 2);
          expect(Math.round((1 - (uec ?? Number.NaN)) * t)).toBe(ours.errorsCorrected);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
