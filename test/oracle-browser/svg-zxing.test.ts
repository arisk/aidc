/// <reference lib="dom" />
import * as fc from 'fast-check';
import { type ReaderOptions, prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { beforeAll, describe, expect, it } from 'vitest';
import { format, parse, tryParse } from '../../src/ai/index.ts';
import { fromScan } from '../../src/scan/index.ts';
import { ean13, ean8, gs1128, itf14, upcA, upcE } from '../../src/symbology/linear/index.ts';
import { dataMatrix, gs1DataMatrix, gs1Qr, qr } from '../../src/symbology/matrix/index.ts';
import { toSvg, tryToSvg } from '../../src/symbology/render/index.ts';
import type { LinearPattern } from '../../src/symbology/render/index.ts';
import { messageArb } from '../support/arbitraries.ts';
import { dlUriArb, gs1MessageArb, toBracketed } from '../support/matrix.ts';
import { addOnArb, gtinArb, upceGtinArb } from '../support/symbology.ts';

const RUNS = 200;
/** One symbol may hold part of a label's data: no association rules (controller ruling, Task 6). */
const LOOSE = { validateAssociations: false } as const;
/** The HRI wrap estimate assumes 0.6 em per character (plan decision G17), plus a margin. */
const MAX_ADVANCE_EM = 0.62;

beforeAll(async () => {
  // The wasm comes from the installed package through Vite, never from the CDN.
  await prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm') ? wasmUrl : prefix + path,
    },
    fireImmediately: true,
  });
});

type Format = NonNullable<ReaderOptions['formats']>[number];

interface Case {
  readonly name: string;
  readonly pattern: LinearPattern;
  readonly format: Format;
  readonly addOn: string | undefined;
  /** What our own decoder says a scanner transmits: AIM identifier plus data. */
  readonly scan: string;
  /** SVG pixels per module. */
  readonly moduleSize: number;
}

function eanCase(
  codec: typeof ean13,
  input: string,
  formatName: Format,
  addOn: string | undefined,
  gap: number,
): Case {
  const pattern = codec.encode(input, addOn === undefined ? {} : { addOn, addOnGap: gap });
  const d = codec.decode(pattern);
  return {
    name: codec.name,
    pattern,
    format: formatName,
    addOn,
    scan: d.aimId + d.rawData,
    moduleSize: 3,
  };
}

/** zxing reads add-ons only up to a 10X gap: use 7 or 9 (UPC-A's minimum is 9). */
const maybeAddOn = fc.option(addOnArb, { nil: undefined });

const ARBS: ReadonlyArray<readonly [string, fc.Arbitrary<Case>]> = [
  [
    'ean-13',
    fc
      .tuple(
        gtinArb(13).filter((g) => !g.startsWith('0') && ean13.tryEncode(g).ok),
        maybeAddOn,
        fc.constantFrom(7, 9),
      )
      .map(([g, a, gap]) => eanCase(ean13, g, 'EAN13', a, gap)),
  ],
  [
    'upc-a',
    fc
      .tuple(
        gtinArb(12).filter((g) => upcA.tryEncode(g).ok),
        maybeAddOn,
      )
      .map(([g, a]) => eanCase(upcA, g, 'UPCA', a, 9)),
  ],
  [
    'upc-e',
    fc
      .tuple(
        upceGtinArb.filter((g) => upcE.tryEncode(g).ok),
        maybeAddOn,
        fc.constantFrom(7, 9),
      )
      .map(([g, a, gap]) => eanCase(upcE, g, 'UPCE', a, gap)),
  ],
  ['ean-8', gtinArb(8).map((g) => eanCase(ean8, g, 'EAN8', undefined, 0))],
  [
    'itf-14',
    fc
      .tuple(
        gtinArb(14),
        fc.constantFrom(2.25, 2.5, 2.75, 3),
        fc.constantFrom('frame', 'top-bottom', 'none'),
      )
      .map(([g, ratio, bearer]): Case => {
        const pattern = itf14.encode(g, { wideToNarrow: ratio, bearer });
        const d = itf14.decode(pattern);
        // 4 px per module puts every wide bar edge (2.25 to 3 modules) on a whole pixel. At 3 px a
        // 2.25 wide bar is 6.75 px, and WebKit, which also truncates the fractional SVG width
        // (399.75 px becomes 399) and resamples, occasionally leaves zxing unable to classify it.
        return {
          name: 'itf-14',
          pattern,
          format: 'ITF14',
          addOn: undefined,
          scan: d.aimId + d.rawData,
          moduleSize: 4,
        };
      }),
  ],
  [
    'gs1-128',
    messageArb
      .map((m) => m.map(([a, v]) => `(${a})${v.replaceAll('(', '\\(')}`).join(''))
      .filter((s) => {
        const r = tryParse(s);
        return r.ok && format(r.value, 'raw').length <= 48;
      })
      .map((s): Case => {
        const pattern = gs1128.encode(parse(s));
        const d = gs1128.decode(pattern);
        return {
          name: 'gs1-128',
          pattern,
          format: 'Code128',
          addOn: undefined,
          scan: d.aimId + d.rawData,
          moduleSize: 3,
        };
      }),
  ],
];

function parseSvg(svg: string): Document {
  return new DOMParser().parseFromString(svg, 'image/svg+xml');
}

async function svgToImageData(svg: string): Promise<ImageData> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d context');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

describe('zxing-wasm reads our SVG drawn by the browser', () => {
  it.each(ARBS)('%s', async (_name, arb) => {
    await fc.assert(
      fc.asyncProperty(arb, async (c) => {
        const svg = toSvg(c.pattern, { moduleSize: c.moduleSize });
        expect(parseSvg(svg).getElementsByTagName('parsererror')).toHaveLength(0);
        const results = await readBarcodes(await svgToImageData(svg), {
          formats: [c.format],
          ...(c.addOn === undefined ? {} : { eanAddOnSymbol: 'Require' as const }),
        });
        expect(results).toHaveLength(1);
        const r = results[0];
        if (r === undefined) throw new Error('zxing read nothing');
        const theirs = r.symbologyIdentifier + new TextDecoder().decode(r.bytes);
        expect(theirs).toBe(c.scan);
        expect(
          fromScan(theirs, LOOSE).elementString.equals(fromScan(c.scan, LOOSE).elementString),
        ).toBe(true);
        expect(fromScan(theirs, LOOSE).addOn).toBe(c.addOn);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('zxing-wasm reads our DataMatrix SVG drawn by the browser', () => {
  it.each([
    ['GS1 DataMatrix', gs1MessageArb.map((m) => gs1DataMatrix.encode(toBracketed(m)))],
    ['Data Matrix Digital Link', dlUriArb.map((uri) => dataMatrix.encode(uri))],
  ] as const)('%s', async (_name, arb) => {
    await fc.assert(
      fc.asyncProperty(arb, async (m) => {
        const ours = dataMatrix.decode(m);
        const svg = toSvg(m, { moduleSize: 3 });
        expect(parseSvg(svg).getElementsByTagName('parsererror')).toHaveLength(0);
        const results = await readBarcodes(await svgToImageData(svg), { formats: ['DataMatrix'] });
        expect(results).toHaveLength(1);
        const r = results[0];
        if (r === undefined) throw new Error('zxing read nothing');
        expect(r.symbologyIdentifier + new TextDecoder().decode(r.bytes)).toBe(
          ours.aimId + ours.rawData,
        );
      }),
      { numRuns: RUNS },
    );
  });
});

describe('zxing-wasm reads our QR Code SVG drawn by the browser', () => {
  const level = fc.constantFrom('L', 'M', 'Q', 'H');
  it.each([
    [
      'GS1 QR Code',
      fc
        .tuple(gs1MessageArb.map(toBracketed), level)
        .map(([s, ecLevel]) => gs1Qr.encode(s, { ecLevel })),
    ],
    [
      'QR Code Digital Link',
      fc.tuple(dlUriArb, level).map(([uri, ecLevel]) => qr.encode(uri, { ecLevel })),
    ],
  ] as const)('%s', async (_name, arb) => {
    await fc.assert(
      fc.asyncProperty(arb, async (m) => {
        const ours = qr.decode(m);
        const svg = toSvg(m, { moduleSize: 3 });
        expect(parseSvg(svg).getElementsByTagName('parsererror')).toHaveLength(0);
        const results = await readBarcodes(await svgToImageData(svg), { formats: ['QRCode'] });
        expect(results).toHaveLength(1);
        const r = results[0];
        if (r === undefined) throw new Error('zxing read nothing');
        expect(r.symbologyIdentifier + new TextDecoder().decode(r.bytes)).toBe(
          ours.aimId + ours.rawData,
        );
      }),
      { numRuns: RUNS },
    );
  });
});

describe('toSvg output is well-formed SVG', () => {
  it('parses without a parsererror for hostile option strings', () => {
    const anyCase = fc.oneof(...ARBS.map(([, a]) => a));
    const text = fc.string({ unit: 'binary', maxLength: 20 });
    fc.assert(
      fc.property(
        anyCase,
        text,
        text,
        text,
        text,
        (c, title, foreground, background, fontFamily) => {
          const r = tryToSvg(c.pattern, { title, foreground, background, fontFamily });
          // Control characters in the title are INVALID_CHAR, so there is nothing to parse.
          if (!r.ok) return;
          expect(parseSvg(r.value).getElementsByTagName('parsererror')).toHaveLength(0);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('HRI character advance', () => {
  it(`is at most ${MAX_ADVANCE_EM} em for the default font stack`, () => {
    const svg = toSvg(ean13.encode('9506000134352'));
    const fontFamily = parseSvg(svg).getElementsByTagName('text')[0]?.getAttribute('font-family');
    expect(fontFamily).toBe('OCR-B,OCRB,monospace');
    const ctx = new OffscreenCanvas(10, 10).getContext('2d');
    if (ctx === null) throw new Error('no 2d context');
    const size = 100;
    ctx.font = `${size}px ${fontFamily ?? ''}`;
    const em = ctx.measureText('0').width / size;
    // Reported so the measured value is visible in the run output.
    console.info(`HRI advance of '0' in ${navigator.userAgent}: ${em} em`);
    expect(em).toBeLessThanOrEqual(MAX_ADVANCE_EM);
  });
});
