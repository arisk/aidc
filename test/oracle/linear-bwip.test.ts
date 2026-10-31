import bwipjs from 'bwip-js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { format, parse, tryParse } from '../../src/ai/index.ts';
import { fromScan } from '../../src/scan/index.ts';
import {
  ean13,
  ean8,
  eanUpc,
  gs1128,
  itf14,
  upcA,
  upcE,
  upceCompress,
} from '../../src/symbology/linear/index.ts';
import type { EanUpcOptions } from '../../src/symbology/linear/index.ts';
import { linearPattern } from '../../src/symbology/render/index.ts';
import type { LinearPattern, PatternRow } from '../../src/symbology/render/index.ts';
import { type Message, messageArb } from '../support/arbitraries.ts';
import { addOnArb, gtinArb, upceGtinArb } from '../support/symbology.ts';

const RUNS = Number(process.env['ORACLE_RUNS'] ?? 2000);
/** One symbol may hold part of a label's data: no association rules (controller ruling, Task 6). */
const LOOSE = { validateAssociations: false } as const;

interface LinearRaw {
  readonly sbs: readonly number[];
  readonly bbs: readonly number[];
}

/** bwip-js `raw` for a linear symbology (BWIPP options such as `addongap` are not in its types). */
function lin(bcid: string, text: string, extra: Readonly<Record<string, unknown>> = {}): LinearRaw {
  const opts: bwipjs.RawOptions = { ...extra, bcid, text };
  const r = bwipjs.raw(opts)[0];
  if (r === undefined || !('sbs' in r)) throw new Error(`bwip-js gave no linear output: ${bcid}`);
  return r;
}

const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0);
const rowOf = (p: LinearPattern, role: PatternRow['role']): PatternRow | undefined =>
  p.rows.find((r) => r.role === role);

/** The main row, then (with an add-on) the gap and the add-on row: one run list like bwip-js `sbs`. */
function runs(p: LinearPattern): number[] {
  const main = rowOf(p, 'symbol');
  const addOn = rowOf(p, 'add-on');
  if (main === undefined) throw new Error('no symbol row');
  if (addOn === undefined) return [...main.widths];
  return [...main.widths, addOn.x - main.x - sum(main.widths), ...addOn.widths];
}

/** Module columns covered by the dark runs of a row (absolute, from the content box's left edge). */
function darkColumns(row: PatternRow): number[] {
  const out: number[] = [];
  let x = row.x;
  row.widths.forEach((w, i) => {
    if (i % 2 === 0) for (let k = 0; k < w; k++) out.push(x + k);
    x += w;
  });
  return out;
}

/** Columns of the main symbol's bars that bwip-js extends (`bbs < 0` with `includetext`). */
function bwipGuardColumns(raw: LinearRaw, mainLength: number): number[] {
  const out: number[] = [];
  let x = 0;
  for (let i = 0; i < mainLength; i++) {
    const w = raw.sbs[i] ?? 0;
    if (i % 2 === 0 && (raw.bbs[i / 2] ?? 0) < 0) for (let k = 0; k < w; k++) out.push(x + k);
    x += w;
  }
  return out;
}

interface EanCase {
  /** Our symbology object, its bwip-js name, our input and bwip-js's text (both with check digit). */
  readonly codec: typeof ean13;
  readonly bcid: string;
  readonly input: string;
  readonly text: string;
  readonly gtin: string;
  readonly addOn: string | undefined;
  readonly gap: number;
  readonly mainLength: number;
}

const gapArb = (min: number): fc.Arbitrary<number> => fc.integer({ min, max: 12 });
const maybeAddOn = fc.option(addOnArb, { nil: undefined });

const ean13Case: fc.Arbitrary<EanCase> = fc
  .tuple(
    gtinArb(13).filter((g) => ean13.tryEncode(g).ok),
    maybeAddOn,
    gapArb(7),
  )
  .map(([g, addOn, gap]) => ({
    codec: ean13,
    bcid: 'ean13',
    input: g,
    text: g,
    gtin: `0${g}`,
    addOn,
    gap,
    mainLength: 59,
  }));

const upcACase: fc.Arbitrary<EanCase> = fc
  .tuple(
    gtinArb(12).filter((g) => upcA.tryEncode(g).ok),
    maybeAddOn,
    gapArb(9),
  )
  .map(([g, addOn, gap]) => ({
    codec: upcA,
    bcid: 'upca',
    input: g,
    text: g,
    gtin: `00${g}`,
    addOn,
    gap,
    mainLength: 59,
  }));

const upcECase: fc.Arbitrary<EanCase> = fc
  .tuple(
    upceGtinArb.filter((g) => upcE.tryEncode(g).ok),
    maybeAddOn,
    gapArb(7),
  )
  .map(([g, addOn, gap]) => ({
    codec: upcE,
    bcid: 'upce',
    input: g,
    text: `0${upceCompress(g) ?? ''}${g.slice(11)}`,
    gtin: `00${g}`,
    addOn,
    gap,
    mainLength: 33,
  }));

const ean8Case: fc.Arbitrary<EanCase> = gtinArb(8).map((g) => ({
  codec: ean8,
  bcid: 'ean8',
  input: g,
  text: g,
  gtin: `000000${g}`,
  addOn: undefined,
  gap: 0,
  mainLength: 43,
}));

const eanCase = fc.oneof(ean13Case, upcACase, upcECase, ean8Case);

describe('EAN/UPC patterns equal bwip-js', () => {
  it('main and add-on widths, guard extensions, cross-decoding', () => {
    fc.assert(
      fc.property(eanCase, (c) => {
        const opts: EanUpcOptions =
          c.addOn === undefined ? {} : { addOn: c.addOn, addOnGap: c.gap };
        const ours = c.codec.encode(c.input, opts);
        const text = c.addOn === undefined ? c.text : `${c.text} ${c.addOn}`;
        const theirs = lin(c.bcid, text, {
          includetext: true,
          ...(c.addOn === undefined ? {} : { addongap: c.gap }),
        });

        expect(runs(ours)).toEqual(theirs.sbs);
        const ext = rowOf(ours, 'guard-extension');
        expect(ext === undefined ? [] : darkColumns(ext)).toEqual(
          bwipGuardColumns(theirs, c.mainLength),
        );

        // Our decoders read bwip-js's bars (one row, add-on after the gap).
        const d = c.codec.decode(linearPattern(theirs.sbs));
        expect(d.elementString.gtin).toBe(c.gtin);
        expect(d.addOn).toBe(c.addOn);
        expect(eanUpc.decode(linearPattern(theirs.sbs)).elementString.gtin).toBe(c.gtin);
        const scanned = fromScan(d.aimId + d.rawData);
        expect(scanned.elementString.gtin).toBe(c.gtin);
        expect(scanned.addOn).toBe(c.addOn);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('ITF-14 patterns equal bwip-js', () => {
  it('width classes and cross-decoding', () => {
    fc.assert(
      fc.property(gtinArb(14), fc.constantFrom(2.25, 2.5, 2.75, 3), (g, ratio) => {
        const ours = itf14.encode(g, { wideToNarrow: ratio });
        const theirs = lin('itf14', g);
        // bwip-js ends its runs with a 1-module light run (part of the quiet zone); ours end dark.
        expect(theirs.sbs.length).toBe(78);
        expect(theirs.sbs[77]).toBe(1);
        const main = rowOf(ours, 'symbol');
        expect(main?.widths.map((w) => (w > 1.5 ? 2 : 1))).toEqual(theirs.sbs.slice(0, 77));

        const d = itf14.decode(linearPattern(theirs.sbs));
        expect(d.elementString.gtin).toBe(g);
        expect(d.metadata.wideToNarrow).toBe(2);
        expect(fromScan(d.aimId + d.rawData).elementString.gtin).toBe(g);
      }),
      { numRuns: RUNS },
    );
  });
});

/** bwip-js reads bracketed AI syntax; it has no escape for a literal parenthesis in a value. */
const bracketed = (m: Message): string => m.map(([a, v]) => `(${a})${v}`).join('');
/**
 * ISO 4217 codes that bwip-js 4.11.4 (BWIPP) does not know yet: 924 (ZWG) and 926 (VED). The GS1
 * Syntax Engine's lint_iso4217 list, which ours is built from, accepts both (checked with gs1encoder
 * 1.4.1). bwip-js still accepts the withdrawn 191, 694, 931 and 932, which we never generate.
 */
const BWIP_UNKNOWN_CURRENCY = new Set(['924', '926']);
/**
 * UN/ECE Rec 21 package types that bwip-js 4.11.4 (BWIPP) rejects for AI (7041) with
 * "GS1unknownPackageType": APE and AT. The GS1 Syntax Engine's lint_packagetype list, which ours is
 * built from, accepts both; bwip-js accepts the other 429 codes.
 */
const BWIP_UNKNOWN_PACKAGE_TYPE = new Set(['APE', 'AT']);
const bwipKnows = ([ai, v]: readonly [string, string]): boolean =>
  ((!ai.startsWith('391') && !ai.startsWith('393')) || !BWIP_UNKNOWN_CURRENCY.has(v.slice(0, 3))) &&
  (ai !== '7041' || !BWIP_UNKNOWN_PACKAGE_TYPE.has(v));
const gs1128Message = messageArb
  .filter((m) => m.every(([, v]) => !v.includes('(') && !v.includes(')')))
  .filter((m) => m.every(bwipKnows))
  .map(bracketed)
  .filter((s) => {
    // Full validation (associations included): bwip-js runs its GS1 linters on the data.
    const r = tryParse(s);
    return r.ok && format(r.value, 'raw').length <= 48;
  });

/** Element strings with a unique minimal encodation: our bars must equal bwip-js's exactly. */
const CURATED = [
  '(01)09506000134352(17)201225(10)ABC123',
  '(00)030123456789012340',
  '(01)09506000134352',
  '(01)09506000134352(10)abc',
  '(02)09506000134352(37)12',
  '(410)9506000134352(420)ABC',
];

describe('GS1-128 against bwip-js', () => {
  it('is never longer and cross-decodes to the same element string', () => {
    fc.assert(
      fc.property(gs1128Message, (s) => {
        const es = parse(s);
        const ours = gs1128.encode(es);
        const theirs = lin('gs1-128', s);
        expect(sum(rowOf(ours, 'symbol')?.widths ?? [])).toBeLessThanOrEqual(sum(theirs.sbs));

        const d = gs1128.decode(linearPattern(theirs.sbs));
        expect(d.elementString.equals(es)).toBe(true);
        expect(d.rawData).toBe(format(es, 'raw'));
        expect(fromScan(d.aimId + d.rawData, LOOSE).elementString.equals(es)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it.each(CURATED)('equals bwip-js bar for bar: %s', (s) => {
    expect(rowOf(gs1128.encode(s), 'symbol')?.widths).toEqual(lin('gs1-128', s).sbs);
  });
});
