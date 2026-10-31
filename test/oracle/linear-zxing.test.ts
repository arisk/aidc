import * as fc from 'fast-check';
import { type ReaderOptions, readBarcodes } from 'zxing-wasm/reader';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ElementString, format, parse, tryParse } from '../../src/ai/index.ts';
import { fromScan } from '../../src/scan/index.ts';
import { ean13, ean8, gs1128, itf14, upcA, upcE } from '../../src/symbology/linear/index.ts';
import type { LinearPattern } from '../../src/symbology/render/index.ts';
import { messageArb } from '../support/arbitraries.ts';
import { addOnArb, gtinArb, initZxingNode, rasterise, upceGtinArb } from '../support/symbology.ts';

const RUNS = Number(process.env['ORACLE_RUNS'] ?? 2000);
const NON_PURE_RUNS = 50;
/** One symbol may hold part of a label's data: no association rules (controller ruling, Task 6). */
const LOOSE = { validateAssociations: false } as const;

beforeAll(initZxingNode);

type Format = NonNullable<ReaderOptions['formats']>[number];

interface Case {
  readonly name: string;
  readonly pattern: LinearPattern;
  /** Our own decoder's AIM identifier and transmitted data for the pattern. */
  readonly aimId: string;
  readonly rawData: string;
  readonly format: Format;
  readonly elementString: ElementString;
  readonly addOn: string | undefined;
  /** Raster pixels per module (ITF-14 wide bars need an integer multiple). */
  readonly px: number;
}

function eanCase(
  name: string,
  codec: typeof ean13,
  input: string,
  formatName: Format,
  addOn: string | undefined,
  gap: number,
): Case {
  const pattern = codec.encode(input, addOn === undefined ? {} : { addOn, addOnGap: gap });
  const decoded = codec.decode(pattern);
  return {
    name,
    pattern,
    aimId: decoded.aimId,
    rawData: decoded.rawData,
    format: formatName,
    elementString: parse(`(01)${input.padStart(14, '0')}`),
    addOn,
    px: 3,
  };
}

/** zxing reads add-ons only up to a 10X gap: use 7 or 9 (UPC-A's minimum is 9). */
const maybeAddOn = fc.option(addOnArb, { nil: undefined });

const ean13Arb = fc
  .tuple(
    gtinArb(13).filter((g) => !g.startsWith('0') && ean13.tryEncode(g).ok),
    maybeAddOn,
    fc.constantFrom(7, 9),
  )
  .map(([g, a, gap]) => eanCase('ean-13', ean13, g, 'EAN13', a, gap));
const upcAArb = fc
  .tuple(
    gtinArb(12).filter((g) => upcA.tryEncode(g).ok),
    maybeAddOn,
  )
  .map(([g, a]) => eanCase('upc-a', upcA, g, 'UPCA', a, 9));
const upcEArb = fc
  .tuple(
    upceGtinArb.filter((g) => upcE.tryEncode(g).ok),
    maybeAddOn,
    fc.constantFrom(7, 9),
  )
  .map(([g, a, gap]) => eanCase('upc-e', upcE, g, 'UPCE', a, gap));
const ean8Arb = gtinArb(8).map((g) => eanCase('ean-8', ean8, g, 'EAN8', undefined, 0));

const itfArb = fc
  .tuple(
    gtinArb(14),
    fc.constantFrom(2.25, 2.5, 2.75, 3),
    fc.constantFrom('frame', 'top-bottom', 'none'),
  )
  .map(([g, ratio, bearer]): Case => {
    const pattern = itf14.encode(g, { wideToNarrow: ratio, bearer });
    const decoded = itf14.decode(pattern);
    return {
      name: 'itf-14',
      pattern,
      aimId: decoded.aimId,
      rawData: decoded.rawData,
      format: 'ITF14',
      elementString: parse(`(01)${g}`),
      addOn: undefined,
      px: 4,
    };
  });

const gs1128Arb = messageArb
  .map((m) => m.map(([a, v]) => `(${a})${v.replaceAll('(', '\\(')}`).join(''))
  .filter((s) => {
    const r = tryParse(s);
    return r.ok && format(r.value, 'raw').length <= 48;
  })
  .map((s): Case => {
    const elementString = parse(s);
    const pattern = gs1128.encode(elementString);
    return {
      name: 'gs1-128',
      pattern,
      aimId: ']C1',
      rawData: format(elementString, 'raw'),
      format: 'Code128',
      elementString,
      addOn: undefined,
      px: 3,
    };
  });

const anyCase = fc.oneof(ean13Arb, upcAArb, upcEArb, ean8Arb, itfArb, gs1128Arb);

async function read(c: Case, pure: boolean): Promise<{ aimId: string; data: string }> {
  const img = rasterise(c.pattern, c.px, pure ? 10 : 'pattern');
  const results = await readBarcodes(img, {
    formats: [c.format],
    isPure: pure,
    ...(c.addOn === undefined ? {} : { eanAddOnSymbol: 'Require' as const }),
  });
  expect(results).toHaveLength(1);
  const r = results[0];
  if (r === undefined) throw new Error(`zxing read nothing (${c.name})`);
  return { aimId: r.symbologyIdentifier, data: new TextDecoder().decode(r.bytes) };
}

/** The AIM identifier zxing must report for each symbology (UPC-A/UPC-E travel as ]E0). */
function expectedAim(c: Case): string {
  if (c.addOn !== undefined) return ']E3';
  switch (c.name) {
    case 'ean-8':
      return ']E4';
    case 'itf-14':
      return ']I1';
    case 'gs1-128':
      return ']C1';
    default:
      return ']E0';
  }
}

async function check(c: Case, pure: boolean): Promise<void> {
  const z = await read(c, pure);
  expect(z.aimId).toBe(expectedAim(c));
  expect(z.aimId).toBe(c.aimId);
  expect(z.data).toBe(c.rawData);
  const scanned = fromScan(z.aimId + z.data, LOOSE);
  expect(scanned.elementString.equals(c.elementString)).toBe(true);
  expect(scanned.addOn).toBe(c.addOn);
}

describe('zxing-wasm reads our rasterised patterns', () => {
  it('pure renders', async () => {
    expect.hasAssertions();
    await fc.assert(
      fc.asyncProperty(anyCase, (c) => check(c, true)),
      { numRuns: RUNS },
    );
  });

  it('with the patterns own quiet zones, not pure', async () => {
    expect.hasAssertions();
    await fc.assert(
      fc.asyncProperty(anyCase, (c) => check(c, false)),
      { numRuns: NON_PURE_RUNS },
    );
  });
});
