import bwipjs from 'bwip-js';
import * as fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from '../../src/ai/index.ts';
import { dataMatrix, gs1DataMatrix, gs1Qr, qr } from '../../src/symbology/matrix/index.ts';
import type { QrEcLevel } from '../../src/symbology/matrix/index.ts';
import { buildSymbol } from '../../src/symbology/matrix/qr-place.ts';
import { EC_LEVELS } from '../../src/symbology/matrix/qr-tables.ts';
import type { DmSizeOption } from '../../src/symbology/matrix/index.ts';
import { placeCodewords } from '../../src/symbology/matrix/dm-place.ts';
import { DM_SIZES, dmSize, type DmSize } from '../../src/symbology/matrix/dm-tables.ts';
import type { ModuleMatrix } from '../../src/symbology/render/index.ts';
import { type Message, messageArb } from '../support/arbitraries.ts';
import { bwipRawToMatrix, dlUriArbOf, gs1MessageArb } from '../support/matrix.ts';

const RUNS = Number(process.env['ORACLE_RUNS'] ?? 2000);
/** bwip-js takes about 80 ms for the largest sizes: at most 50 runs above 64x64 (plan Task 7). */
const LARGE_RUNS = Math.min(RUNS, 50);
/** One symbol may hold part of a label's data: no association rules (decision H8). */
const LOOSE = { validateAssociations: false } as const;

/** bwip-js `raw` for a Data Matrix bcid (BWIPP options such as `dontlint` are not in its types). */
function bwipMatrix(
  bcid: string,
  text: string,
  extra: Readonly<Record<string, unknown>> = {},
): ModuleMatrix {
  const opts: bwipjs.RawOptions = { ...extra, bcid, text };
  const r = bwipjs.raw(opts)[0];
  if (r === undefined || !('pixs' in r)) throw new Error(`bwip-js gave no matrix: ${bcid}`);
  return bwipRawToMatrix(r);
}

/** bwip-js's symbol, or undefined when it cannot make one (data too long for the forced shape). */
function tryBwipMatrix(
  bcid: string,
  text: string,
  extra: Readonly<Record<string, unknown>> = {},
): ModuleMatrix | undefined {
  try {
    return bwipMatrix(bcid, text, extra);
  } catch (e) {
    if (e instanceof Error && /too long|exceeds|no valid symbol|maximum/i.test(e.message))
      return undefined;
    throw e;
  }
}

/**
 * ISO 4217 codes (924, 926) and AI (7041) package types (APE, AT) that bwip-js 4.11.4 does not
 * know, as in the linear bwip-js oracle. bwip-js has no escape for a parenthesis in a value.
 */
const BWIP_UNKNOWN_CURRENCY = new Set(['924', '926']);
const BWIP_UNKNOWN_PACKAGE_TYPE = new Set(['APE', 'AT']);
const bwipKnows = ([ai, v]: readonly [string, string]): boolean =>
  ((!ai.startsWith('391') && !ai.startsWith('393')) || !BWIP_UNKNOWN_CURRENCY.has(v.slice(0, 3))) &&
  (ai !== '7041' || !BWIP_UNKNOWN_PACKAGE_TYPE.has(v)) &&
  !v.includes('(') &&
  !v.includes(')');
const bracketed = (m: Message): string => m.map(([a, v]) => `(${a})${v}`).join('');
const gs1Arb = gs1MessageArb.filter((m) => m.every(bwipKnows)).map(bracketed);
/** bwip-js lints the element string a Digital Link URI carries: the same filter applies. */
const dlUriArb = dlUriArbOf(messageArb.filter((m) => m.every(bwipKnows)));

const area = (m: ModuleMatrix): number => m.width * m.height;
const sizeOf = (m: ModuleMatrix): DmSize => {
  const s = dmSize(m.height, m.width);
  if (s === undefined) throw new Error(`not an ECC 200 size: ${m.height}x${m.width}`);
  return s;
};
const isLarge = (s: DmSize): boolean => s.rows * s.columns > 64 * 64;

/** Cases where our data codeword count or symbol area is strictly below bwip-js's, per property. */
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
      `bwip-js ${name}: ${t.runs} runs, fewer data codewords in ${t.codewords}, smaller symbol in ${t.area}`,
    );
});

/**
 * Pinned bit equality (decision H19): our RS, interleaving, placement and finder patterns, given
 * the data codewords our decoder reads from bwip-js's symbol, rebuild that symbol bit for bit.
 */
function expectPinned(theirs: ModuleMatrix, codewords: readonly number[]): void {
  expect(placeCodewords(sizeOf(theirs), codewords).rows).toEqual(theirs.rows);
}

/** A message and one exact size it fits in (by bwip-js's count, the larger one). */
const forcedArb = (large: boolean): fc.Arbitrary<readonly [string, DmSize]> =>
  gs1Arb.chain((s) => {
    const t = gs1DataMatrix.decode(bwipMatrix('gs1datamatrix', s, { dontlint: true }));
    const fits = DM_SIZES.filter(
      (z) => z.dataCodewords >= t.metadata.codewords.length && isLarge(z) === large,
    );
    return fc.constantFrom(...fits).map((z) => [s, z] as const);
  });

describe('GS1 DataMatrix against bwip-js gs1datamatrix', () => {
  it.each([
    ['square', 'square', {}],
    ['rectangular', 'rectangular', { format: 'rectangle' }],
  ] as const)(
    '%s: cross-decodes, is never larger and never uses more codewords',
    (name, size, extra) => {
      fc.assert(
        fc.property(gs1Arb, (s) => {
          const theirs = tryBwipMatrix('gs1datamatrix', s, {
            ...extra,
            dontlint: true,
          });
          const ours = gs1DataMatrix.tryEncode(s, { size });
          // bwip-js fails only when the data does not fit the shape; it never fits where ours does not.
          if (theirs === undefined) return;
          expect(ours.ok).toBe(true);
          if (!ours.ok) return;
          const t = gs1DataMatrix.decode(theirs);
          expect(t.elementString.equals(parse(s, LOOSE))).toBe(true);
          expect(t.metadata.shape).toBe(size);
          const o = gs1DataMatrix.decode(ours.value);
          expect(o.elementString.equals(t.elementString)).toBe(true);
          expect(area(ours.value)).toBeLessThanOrEqual(area(theirs));
          expect(o.metadata.codewords.length).toBeLessThanOrEqual(t.metadata.codewords.length);
          tally(
            `gs1datamatrix ${name}`,
            o.metadata.codewords.length,
            t.metadata.codewords.length,
            area(ours.value),
            area(theirs),
          );
          expectPinned(theirs, t.metadata.codewords);
        }),
        { numRuns: RUNS },
      );
    },
  );

  it.each([
    ['up to 64x64', false, RUNS],
    ['above 64x64', true, LARGE_RUNS],
  ] as const)(
    'forced version %s: cross-decodes and matches bit for bit once pinned',
    (_n, large, numRuns) => {
      fc.assert(
        fc.property(forcedArb(large), ([s, z]) => {
          const theirs = bwipMatrix('gs1datamatrix', s, {
            version: `${z.rows}x${z.columns}`,
            dontlint: true,
          });
          expect([theirs.height, theirs.width]).toEqual([z.rows, z.columns]);
          const t = gs1DataMatrix.decode(theirs);
          expect(t.elementString.equals(parse(s, LOOSE))).toBe(true);
          const ours = gs1DataMatrix.encode(s, {
            size: { rows: z.rows, columns: z.columns },
          });
          expect(gs1DataMatrix.decode(ours).elementString.equals(t.elementString)).toBe(true);
          expectPinned(theirs, t.metadata.codewords);
        }),
        { numRuns },
      );
    },
  );

  it('matches bit for bit once pinned at every one of the 30 sizes', () => {
    // FNC1, '90' and '1': 3 data codewords, which even 10x10 holds.
    const s = '(90)1';
    for (const z of DM_SIZES) {
      const theirs = bwipMatrix('gs1datamatrix', s, {
        version: `${z.rows}x${z.columns}`,
      });
      const t = gs1DataMatrix.decode(theirs);
      expect(t.rawData).toBe(gs1DataMatrix.decode(gs1DataMatrix.encode(s)).rawData);
      expectPinned(theirs, t.metadata.codewords);
    }
  });
});

describe('Data Matrix Digital Link against bwip-js gs1dldatamatrix and datamatrix', () => {
  it.each([
    ['gs1dldatamatrix', 'square', {}],
    ['gs1dldatamatrix', 'rectangular', { format: 'rectangle' }],
    ['datamatrix', 'square', {}],
    ['datamatrix', 'rectangular', { format: 'rectangle' }],
  ] as const)(
    '%s %s: cross-decodes, is never larger and never uses more codewords',
    (bcid, size, extra) => {
      fc.assert(
        fc.property(dlUriArb, (uri) => {
          const theirs = tryBwipMatrix(bcid, uri, extra);
          const ours = dataMatrix.tryEncode(uri, { size });
          if (theirs === undefined) return;
          expect(ours.ok).toBe(true);
          if (!ours.ok) return;
          const t = dataMatrix.decode(theirs);
          expect(t.aimId).toBe(']d1');
          expect(t.digitalLink).toBe(uri);
          const o = dataMatrix.decode(ours.value);
          expect(o.digitalLink).toBe(uri);
          expect(area(ours.value)).toBeLessThanOrEqual(area(theirs));
          expect(o.metadata.codewords.length).toBeLessThanOrEqual(t.metadata.codewords.length);
          tally(
            `${bcid} ${size}`,
            o.metadata.codewords.length,
            t.metadata.codewords.length,
            area(ours.value),
            area(theirs),
          );
          expectPinned(theirs, t.metadata.codewords);
        }),
        { numRuns: RUNS },
      );
    },
  );

  it('forced version: cross-decodes and matches bit for bit once pinned', () => {
    const arb = dlUriArb.chain((uri) => {
      const n = dataMatrix.decode(bwipMatrix('gs1dldatamatrix', uri)).metadata.codewords.length;
      const fits = DM_SIZES.filter((z) => z.dataCodewords >= n && !isLarge(z));
      return fc.constantFrom(...fits).map((z) => [uri, z] as const);
    });
    fc.assert(
      fc.property(arb, ([uri, z]) => {
        const size: DmSizeOption = { rows: z.rows, columns: z.columns };
        const theirs = bwipMatrix('gs1dldatamatrix', uri, {
          version: `${z.rows}x${z.columns}`,
        });
        const t = dataMatrix.decode(theirs);
        expect(t.digitalLink).toBe(uri);
        expect(dataMatrix.decode(dataMatrix.encode(uri, { size })).digitalLink).toBe(uri);
        expectPinned(theirs, t.metadata.codewords);
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// QR Code (decisions Q6, Q17)

/** bwip-js's QR symbol: always a fixed error correction level, ISO mask 0..7 passed 1-based. */
function bwipQr(
  bcid: 'gs1qrcode' | 'gs1dlqrcode' | 'qrcode',
  text: string,
  level: QrEcLevel,
  extra: { readonly version?: number; readonly mask?: number } = {},
): ModuleMatrix {
  const { mask, ...rest } = extra;
  return bwipMatrix(bcid, text, {
    ...rest,
    eclevel: level,
    fixedeclevel: true,
    ...(mask === undefined ? {} : { mask: mask + 1 }),
    ...(bcid === 'gs1qrcode' ? { dontlint: true } : {}),
  });
}

const levelArb: fc.Arbitrary<QrEcLevel> = fc.constantFrom(...EC_LEVELS);
/**
 * bwip-js 4.11.4 doubles a literal `%` of GS1 data (`%%`) even inside a byte segment, where ISO/IEC
 * 18004 keeps 0x25 (only alphanumeric segments double it: `%` is FNC1 there). Its symbol then reads
 * back with an extra `%`, so GS1 messages with a `%` in a value are left out of the bwip-js QR
 * comparisons; our `%` handling is read back by zxing-wasm in matrix-zxing.test.ts.
 */
const gs1QrArb = gs1Arb.filter((s) => !s.replaceAll(/\(\d+\)/g, '').includes('%'));
const QR_VERSIONS = Array.from({ length: 40 }, (_, i) => i + 1);

/** Cases where our version or data bits are strictly below theirs. */
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
      `bwip-js ${name}: ${c.runs} runs, smaller version in ${c.version}, fewer data bits in ${c.bits}`,
    );
});

type QrMeta = ReturnType<typeof gs1Qr.decode>['metadata'];

/**
 * Pinned bit equality (decision Q17): our RS, interleaving, placement, function patterns and
 * format/version information, given the version, level and codewords our decoder reads from
 * bwip-js's symbol, rebuild that symbol bit for bit, mask included (decision Q6).
 */
function expectQrPinned(theirs: ModuleMatrix, t: QrMeta): void {
  expect(buildSymbol(t.version, t.ecLevel, t.codewords, 'auto').rows).toEqual(theirs.rows);
  expectQrPinnedMask(theirs, t);
}

/** The same with the mask bwip-js was forced to use (the automatic choice may differ). */
function expectQrPinnedMask(theirs: ModuleMatrix, t: QrMeta): void {
  expect(buildSymbol(t.version, t.ecLevel, t.codewords, t.mask).rows).toEqual(theirs.rows);
}

const QR_LARGE_RUNS = Math.min(RUNS, 50);

describe('GS1 QR Code against bwip-js gs1qrcode', () => {
  it('cross-decodes, is never larger, never uses more bits and matches bit for bit once pinned', () => {
    fc.assert(
      fc.property(gs1QrArb, levelArb, (s, level) => {
        const theirs = tryBwipMatrix('gs1qrcode', s, {
          eclevel: level,
          fixedeclevel: true,
          dontlint: true,
        });
        const ours = gs1Qr.tryEncode(s, { ecLevel: level });
        if (theirs === undefined) return;
        expect(ours.ok).toBe(true);
        if (!ours.ok) return;
        const t = gs1Qr.decode(theirs);
        expect(t.aimId).toBe(']Q3');
        expect(t.elementString.equals(parse(s, LOOSE))).toBe(true);
        expect(t.metadata.ecLevel).toBe(level);
        const o = gs1Qr.decode(ours.value);
        expect(o.elementString.equals(t.elementString)).toBe(true);
        expect(o.metadata.version).toBeLessThanOrEqual(t.metadata.version);
        expect(o.metadata.dataBits).toBeLessThanOrEqual(t.metadata.dataBits);
        qrTally('gs1qrcode', o.metadata, t.metadata);
        expectQrPinned(theirs, t.metadata);
      }),
      { numRuns: RUNS },
    );
  });

  it.each([
    ['up to version 20', false, RUNS],
    ['above version 20', true, QR_LARGE_RUNS],
  ] as const)(
    'forced version %s: cross-decodes and matches bit for bit once pinned',
    (_n, large, numRuns) => {
      const arb = fc.tuple(gs1QrArb, levelArb).chain(([s, level]) => {
        const t = gs1Qr.decode(bwipQr('gs1qrcode', s, level));
        const versions = QR_VERSIONS.filter((v) => v >= t.metadata.version && v > 20 === large);
        return fc.constantFrom(...versions).map((v) => [s, level, v] as const);
      });
      fc.assert(
        fc.property(arb, ([s, level, version]) => {
          const theirs = bwipQr('gs1qrcode', s, level, { version });
          const t = gs1Qr.decode(theirs);
          expect(t.metadata.version).toBe(version);
          expect(t.elementString.equals(parse(s, LOOSE))).toBe(true);
          const ours = gs1Qr.decode(gs1Qr.encode(s, { ecLevel: level, version }));
          expect(ours.elementString.equals(t.elementString)).toBe(true);
          expectQrPinned(theirs, t.metadata);
        }),
        { numRuns },
      );
    },
  );

  it('matches bit for bit once pinned at all 160 version and level combinations', () => {
    const s = '(90)1';
    for (const version of QR_VERSIONS)
      for (const level of EC_LEVELS) {
        const theirs = bwipQr('gs1qrcode', s, level, { version });
        const t = gs1Qr.decode(theirs);
        expect([t.metadata.version, t.metadata.ecLevel]).toEqual([version, level]);
        expect(t.rawData).toBe(gs1Qr.decode(gs1Qr.encode(s)).rawData);
        expectQrPinned(theirs, t.metadata);
        const ours = gs1Qr.decode(gs1Qr.encode(s, { ecLevel: level, version }));
        expect(ours.metadata.codewords).toEqual(t.metadata.codewords);
      }
  });

  it('reads every level, forced version and mask 1..8 on a curated set', () => {
    const set = [
      '(01)09506000134352(17)201225(10)ABC123',
      '(01)09506000134352(10)A%B%%(21)%',
      '(8200)http://example.com/x?y=1&z=2',
      '(00)395060001343520018(400)ORDER-1(420)12345',
    ];
    for (const s of set)
      for (const level of EC_LEVELS)
        for (const version of [undefined, 6, 7, 14, 27]) {
          for (let mask = 0; mask < 8; mask++) {
            const theirs = bwipQr('gs1qrcode', s, level, {
              mask,
              ...(version === undefined ? {} : { version }),
            });
            const t = gs1Qr.decode(theirs);
            expect(t.elementString.equals(parse(s, LOOSE))).toBe(true);
            expect(t.metadata.mask).toBe(mask);
            expectQrPinnedMask(theirs, t.metadata);
            const ours = gs1Qr.decode(
              gs1Qr.encode(s, {
                ecLevel: level,
                mask,
                version: t.metadata.version,
              }),
            );
            expect(ours.metadata.mask).toBe(mask);
            expect(ours.elementString.equals(t.elementString)).toBe(true);
          }
        }
  });
});

describe('QR Code Digital Link against bwip-js gs1dlqrcode and qrcode', () => {
  it.each(['gs1dlqrcode', 'qrcode'] as const)(
    '%s: cross-decodes, is never larger, never uses more bits and matches bit for bit once pinned',
    (bcid) => {
      fc.assert(
        fc.property(dlUriArb, levelArb, (uri, level) => {
          const theirs = tryBwipMatrix(bcid, uri, {
            eclevel: level,
            fixedeclevel: true,
          });
          const ours = qr.tryEncode(uri, { ecLevel: level });
          if (theirs === undefined) return;
          expect(ours.ok).toBe(true);
          if (!ours.ok) return;
          const t = qr.decode(theirs);
          expect(t.aimId).toBe(']Q1');
          expect(t.digitalLink).toBe(uri);
          const o = qr.decode(ours.value);
          expect(o.digitalLink).toBe(uri);
          expect(o.metadata.version).toBeLessThanOrEqual(t.metadata.version);
          expect(o.metadata.dataBits).toBeLessThanOrEqual(t.metadata.dataBits);
          qrTally(bcid, o.metadata, t.metadata);
          expectQrPinned(theirs, t.metadata);
        }),
        { numRuns: RUNS },
      );
    },
  );

  it('forced version and mask: cross-decodes and matches bit for bit once pinned', () => {
    const arb = fc
      .tuple(dlUriArb, levelArb, fc.integer({ min: 0, max: 7 }))
      .chain(([uri, level, mask]) => {
        const t = qr.decode(bwipQr('gs1dlqrcode', uri, level));
        const versions = QR_VERSIONS.filter((v) => v >= t.metadata.version && v <= 20);
        return fc.constantFrom(...versions).map((v) => [uri, level, mask, v] as const);
      });
    fc.assert(
      fc.property(arb, ([uri, level, mask, version]) => {
        const theirs = bwipQr('gs1dlqrcode', uri, level, { version, mask });
        const t = qr.decode(theirs);
        expect(t.digitalLink).toBe(uri);
        expect(t.metadata.mask).toBe(mask);
        expectQrPinnedMask(theirs, t.metadata);
        expect(qr.decode(qr.encode(uri, { ecLevel: level, version, mask })).digitalLink).toBe(uri);
      }),
      { numRuns: RUNS },
    );
  });
});
