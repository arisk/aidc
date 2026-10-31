import { Gs1Error, fail, isValidCheckDigit, ok, unwrap } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import { tryParse } from '../../ai/index.ts';
import type { ElementString } from '../../ai/index.ts';
import { freezeDecoded, freezePattern, readPlacedRows, symbolError } from '../render/internal.ts';
import type { Bearer, DecodedSymbol, HriText, LinearPattern, Symbology } from '../render/index.ts';
import { gtinInput } from './gtin-input.ts';

export interface Itf14Options {
  /** Wide to narrow ratio, 2.25 to 3.0 (default 2.5). */
  readonly wideToNarrow?: number;
  /** Bearer bars (default `'frame'`). */
  readonly bearer?: 'frame' | 'top-bottom' | 'none';
  /** Bearer bar width in modules, at least 2 (default 5). */
  readonly bearerWidth?: number;
  /** Bar height in modules (default 64). */
  readonly height?: number;
  /** Human readable digits (default true). */
  readonly hri?: boolean;
}

export interface Itf14Metadata {
  readonly reversed: boolean;
  readonly wideToNarrow: number;
}

/** Table 5-23 of GenSpecs: five elements per digit, 1 is wide. */
const BINARY: readonly string[] = [
  '00110',
  '10001',
  '01001',
  '11000',
  '00101',
  '10100',
  '01100',
  '00011',
  '10010',
  '01010',
];

const ELEMENTS = 77;
const PAIRS = 7;
const MIN_RATIO = 2.25;
const MAX_RATIO = 3;
const DEFAULT_RATIO = 2.5;
const DEFAULT_BEARER = 5;
const MAX_BEARER = 100;
const DEFAULT_HEIGHT = 64;
/** The tallest bars, in modules: far above any real symbol, it keeps rendered images sane. */
const MAX_HEIGHT = 1000;
const HRI_GAP = 3;
const HRI_CAP = 6.4;
const HRI_SIZE = 8;
const QUIET = 10;
/** Decode accepts ratios a little wider than encode (research ITF 5.4). */
const READ_MIN = 2;
const EPS = 1e-9;
const MAX_ROWS = 8;
const MAX_ELEMENTS = 2000;

function invalidOption(option: string, message: string): Gs1Error {
  return new Gs1Error({ code: 'INVALID_VALUE', message, details: { option } });
}

interface Settings {
  readonly ratio: number;
  readonly bearer: 'frame' | 'top-bottom' | 'none';
  readonly bearerWidth: number;
  readonly height: number;
  readonly hri: boolean;
}

function readOptions(options: unknown): Result<Settings> {
  if (options !== undefined && (typeof options !== 'object' || options === null))
    return fail([invalidOption('options', 'Options must be an object')]);
  const o: object = options ?? {};
  const get = (name: string): unknown => Reflect.get(o, name);
  const errors: Gs1Error[] = [];
  let ratio = DEFAULT_RATIO;
  const r = get('wideToNarrow');
  if (r !== undefined) {
    if (typeof r !== 'number' || !Number.isFinite(r) || r < MIN_RATIO || r > MAX_RATIO)
      errors.push(invalidOption('wideToNarrow', 'wideToNarrow must be 2.25 to 3'));
    else ratio = r;
  }
  let bearer: Settings['bearer'] = 'frame';
  const b = get('bearer');
  if (b !== undefined) {
    if (b === 'frame' || b === 'top-bottom' || b === 'none') bearer = b;
    else errors.push(invalidOption('bearer', 'bearer must be frame, top-bottom or none'));
  }
  let bearerWidth = DEFAULT_BEARER;
  const bw = get('bearerWidth');
  if (bw !== undefined) {
    if (typeof bw !== 'number' || !Number.isFinite(bw) || bw < 2 || bw > MAX_BEARER)
      errors.push(invalidOption('bearerWidth', `bearerWidth must be from 2 to ${MAX_BEARER}`));
    else bearerWidth = bw;
  }
  let height = DEFAULT_HEIGHT;
  const h = get('height');
  if (h !== undefined) {
    if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0 || h > MAX_HEIGHT)
      errors.push(invalidOption('height', `height must be above 0 and at most ${MAX_HEIGHT}`));
    else height = h;
  }
  let hri = true;
  const f = get('hri');
  if (f !== undefined) {
    if (typeof f !== 'boolean') errors.push(invalidOption('hri', 'hri must be a boolean'));
    else hri = f;
  }
  if (errors.length > 0) return fail(errors);
  return ok({ ratio, bearer, bearerWidth, height, hri });
}

function digitAt(s: string, i: number): number {
  return s.charCodeAt(i) - 48;
}

function widthsOf(gtin: string, wide: number): number[] {
  const out: number[] = [1, 1, 1, 1];
  for (let p = 0; p < PAIRS; p++) {
    const bars = BINARY[digitAt(gtin, 2 * p)] ?? '';
    const spaces = BINARY[digitAt(gtin, 2 * p + 1)] ?? '';
    for (let k = 0; k < 5; k++) {
      out.push(bars.charCodeAt(k) === 49 ? wide : 1);
      out.push(spaces.charCodeAt(k) === 49 ? wide : 1);
    }
  }
  out.push(wide, 1, 1);
  return out;
}

function build(gtin: string, s: Settings): LinearPattern {
  const widths = widthsOf(gtin, s.ratio);
  let width = 0;
  for (const w of widths) width += w;
  const hri: HriText[] = s.hri
    ? [
        {
          text: gtin,
          x: width / 2,
          y: s.height + HRI_GAP + HRI_CAP,
          size: HRI_SIZE,
          anchor: 'middle',
          role: 'hri',
        },
      ]
    : [];
  const base = {
    kind: 'linear' as const,
    symbology: 'itf-14' as const,
    width,
    height: s.height,
    rows: [{ role: 'symbol' as const, x: 0, y: 0, height: s.height, widths }],
    hri,
    quietZone: { left: QUIET, right: QUIET, top: 0, bottom: 0 },
  };
  if (s.bearer === 'none') return freezePattern(base);
  const bearer: Bearer = { sides: s.bearer, width: s.bearerWidth };
  return freezePattern({ ...base, bearer });
}

function encodeItf14(data: ElementString | string, options?: Itf14Options): Result<LinearPattern> {
  try {
    const opts = readOptions(options);
    if (!opts.ok) return fail(opts.errors);
    const gtin = gtinInput(data, 'itf-14');
    if (!gtin.ok) return fail(gtin.errors);
    return ok(build(gtin.value, opts.value));
  } catch {
    return fail([new Gs1Error({ code: 'INVALID_VALUE', message: 'Input could not be encoded' })]);
  }
}

interface Origin {
  readonly row: number;
  readonly element: number;
}

/** Merged alternating runs of one row, starting and ending dark. */
function runsOf(
  row: number,
  widths: readonly number[],
): Result<{ runs: number[]; origins: Origin[] }> {
  if (widths.length > MAX_ELEMENTS)
    return fail([symbolError('length', 'Too many elements for an ITF-14 symbol', 0, row)]);
  const runs: number[] = [];
  const dark: boolean[] = [];
  const origins: Origin[] = [];
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i] ?? 0;
    if (w === 0) continue;
    const isDark = i % 2 === 0;
    if (dark.length > 0 && dark[dark.length - 1] === isDark)
      runs[runs.length - 1] = (runs.at(-1) ?? 0) + w;
    else {
      runs.push(w);
      dark.push(isDark);
      origins.push({ row, element: i });
    }
  }
  let from = 0;
  let to = runs.length;
  if (from < to && dark[from] === false) from++;
  if (from < to && dark[to - 1] === false) to--;
  return ok({ runs: runs.slice(from, to), origins: origins.slice(from, to) });
}

/** True for wide, per element; or an error at a run index. */
function classify(runs: readonly number[]): Result<{ wide: boolean[]; ratio: number }> {
  let min = Infinity;
  let max = 0;
  for (const w of runs) {
    if (w < min) min = w;
    if (w > max) max = w;
  }
  const mid = (min + max) / 2;
  const wide: boolean[] = [];
  for (let i = 0; i < runs.length; i++) {
    const w = runs[i] ?? 0;
    const isWide = w > mid;
    const ref = isWide ? max : min;
    if (Math.abs(w - ref) > EPS * ref + 1e-6 * ref)
      return fail([symbolError('pattern', 'Element is neither narrow nor wide', i)]);
    wide.push(isWide);
  }
  const ratio = max / min;
  if (max === min || ratio < READ_MIN - EPS || ratio > MAX_RATIO + EPS)
    return fail([symbolError('pattern', 'Wide to narrow ratio must be 2 to 3')]);
  return ok({ wide, ratio });
}

function bitsOf(wide: readonly boolean[], from: number, step: number): string {
  let s = '';
  for (let k = 0; k < 5; k++) s += wide[from + step * k] === true ? '1' : '0';
  return s;
}

function reversedCopy(a: readonly boolean[]): boolean[] {
  const out: boolean[] = [];
  for (let i = a.length - 1; i >= 0; i--) out.push(a[i] === true);
  return out;
}

function decodeBits(wide: readonly boolean[]): Result<string> {
  for (let i = 0; i < 4; i++)
    if (wide[i] === true) return fail([symbolError('no-start', 'Bad start pattern', i)]);
  if (wide[74] !== true || wide[75] === true || wide[76] === true)
    return fail([symbolError('no-stop', 'Bad stop pattern', 74)]);
  let digits = '';
  for (let p = 0; p < PAIRS; p++) {
    const from = 4 + 10 * p;
    const a = BINARY.indexOf(bitsOf(wide, from, 2));
    if (a < 0) return fail([symbolError('character', 'Unknown bar character', from)]);
    const b = BINARY.indexOf(bitsOf(wide, from + 1, 2));
    if (b < 0) return fail([symbolError('character', 'Unknown space character', from + 1)]);
    digits += `${a}${b}`;
  }
  return ok(digits);
}

function toRowIndex(e: Gs1Error, origins: readonly Origin[]): Gs1Error {
  const d = e.details;
  const at = d === undefined ? undefined : d['element'];
  if (e.code !== 'INVALID_SYMBOL' || typeof at !== 'number') return e;
  const o = origins[at];
  if (o === undefined) return e;
  return new Gs1Error({
    code: e.code,
    message: e.message,
    details: { ...d, element: o.element, row: o.row },
  });
}

function decodeItf14(symbol: LinearPattern): Result<DecodedSymbol<Itf14Metadata>> {
  try {
    const rows = readPlacedRows(symbol, ['symbol']);
    if (!rows.ok) return fail(rows.errors);
    const only = rows.value[0];
    if (rows.value.length !== 1 || only === undefined || rows.value.length > MAX_ROWS)
      return fail([symbolError('pattern', 'An ITF-14 symbol has exactly one symbol row')]);
    const r = runsOf(only.row, only.widths);
    if (!r.ok) return fail(r.errors);
    const { runs, origins } = r.value;
    if (runs.length !== ELEMENTS)
      return fail([symbolError('length', 'An ITF-14 symbol has 77 elements', undefined)]);
    const cls = classify(runs);
    if (!cls.ok) return fail(cls.errors.map((e) => toRowIndex(e, origins)));
    const { wide, ratio } = cls.value;
    let reversed = false;
    const forward = decodeBits(wide);
    let digits: string;
    if (forward.ok) digits = forward.value;
    else {
      const back = decodeBits(reversedCopy(wide));
      if (!back.ok) return fail(forward.errors.map((e) => toRowIndex(e, origins)));
      digits = back.value;
      reversed = true;
    }
    if (!isValidCheckDigit(digits))
      return fail([
        new Gs1Error({
          code: 'CHECK_DIGIT',
          message: 'Incorrect GTIN check digit',
          ai: '01',
          position: 13,
        }),
      ]);
    const es = tryParse(`(01)${digits}`);
    if (!es.ok) return fail(es.errors);
    return ok(
      freezeDecoded({
        symbology: 'itf-14',
        aimId: ']I1',
        elementString: es.value,
        rawData: digits,
        errorsCorrected: 0,
        metadata: { reversed, wideToNarrow: ratio },
      }),
    );
  } catch {
    return fail([symbolError('pattern', 'Symbol could not be decoded')]);
  }
}

function tryEncode(data: ElementString | string, options?: Itf14Options): Result<LinearPattern> {
  return encodeItf14(data, options);
}

/** ITF-14: encode a GTIN (8, 12, 13 or 14 digits, or `(01)` alone), decode a pattern. */
export const itf14: Symbology<Itf14Options, Itf14Metadata> = /* @__PURE__ */ Object.freeze({
  name: 'itf-14',
  encode: (data: ElementString | string, options?: Itf14Options): LinearPattern =>
    unwrap(tryEncode(data, options)),
  tryEncode,
  decode: (symbol: LinearPattern): DecodedSymbol<Itf14Metadata> => unwrap(decodeItf14(symbol)),
  tryDecode: decodeItf14,
} as const);
