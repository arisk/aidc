import { Gs1Error, fail, ok } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import { QR_POLY, gf256 } from '../../core/gf256.ts';
import { rsDecode } from '../../core/reed-solomon.ts';
import { readMatrix, rsUncorrectable, symbolError } from '../render/internal.ts';
import type { Orientation } from '../render/index.ts';
import { deinterleave, readCodewords } from './qr-place.ts';
import {
  type QrEcLevel,
  countBits,
  decodeFormat,
  decodeVersion,
  formatBits,
  popcount,
  qrVersion,
} from './qr-tables.ts';

/** A symbol read from a matrix: version, level, mask, orientation and the corrected data. */
export interface QrRead {
  readonly version: number;
  readonly level: QrEcLevel;
  /** Mask pattern reference, ISO 0..7. */
  readonly mask: number;
  /** Data codewords after RS, before decodation (padding included). */
  readonly codewords: readonly number[];
  /** EC codewords of all blocks. */
  readonly ecCodewords: number;
  readonly blocks: number;
  readonly errorsCorrected: number;
  /**
   * How the input was turned: the canonical symbol, mirrored left to right when `mirrored`, then
   * rotated clockwise by `rotation`, gives the input.
   */
  readonly orientation: Orientation;
  /** Whether the input had reversed reflectance (light modules on dark). */
  readonly inverted: boolean;
}

/** A data segment as the decoder met it: its mode and character count indicator. */
export interface QrSegmentInfo {
  readonly mode: 'numeric' | 'alphanumeric' | 'byte' | 'kanji';
  readonly count: number;
}

/** The first special feature of a bit stream (decision Q11). */
export type QrSpecial =
  | { readonly reason: 'eci'; readonly eci: number }
  | {
      readonly reason: 'structured-append';
      readonly position: number;
      readonly total: number;
      readonly parity: number;
    }
  | { readonly reason: 'fnc1-second'; readonly applicationIndicator: number }
  | { readonly reason: 'kanji' };

/** The transmitted data of a bit stream. */
export interface QrText {
  /** `]Q3` (FNC1 first), `]Q5` (FNC1 second), `]Q1` (no FNC1). */
  readonly aimId: ']Q1' | ']Q3' | ']Q5';
  /** Transmitted data, FNC1 as GS, without the AIM id. */
  readonly data: string;
  /** Bits before the terminator, mode indicators (FNC1 included) and headers included. */
  readonly dataBits: number;
  readonly segments: readonly QrSegmentInfo[];
  readonly special?: QrSpecial;
}

// ---------------------------------------------------------------------------------------------
// Geometry

interface Trimmed {
  readonly inverted: boolean;
  readonly x0: number;
  readonly y0: number;
  readonly width: number;
  readonly height: number;
}

/** Input coordinates of canonical module (r, c) as y = y0 + yr * r + yc * c, likewise x. */
interface Affine {
  readonly orientation: Orientation;
  readonly y0: number;
  readonly yr: number;
  readonly yc: number;
  readonly x0: number;
  readonly xr: number;
  readonly xc: number;
}

/** Stages of the pipeline, for keeping the error of the attempt that got furthest. */
const Stage = { Size: 0, Finder: 1, Timing: 2, Version: 3, Format: 4, Rs: 5 } as const;
type Stage = (typeof Stage)[keyof typeof Stage];

interface Failure {
  readonly stage: Stage;
  readonly error: Gs1Error;
  /** A format information copy matched a format word exactly (orientation evidence). */
  readonly exactFormat?: boolean;
}

/** Finder corners (x, y of the top left module): top left, top right, bottom left, bottom right. */
const TL = 0;
const TR = 1;
const BL = 2;
const BR = 3;

/** Rotation that brings the corner without a finder to the bottom right, plain and mirrored. */
const PLAIN_ROTATION: readonly Orientation['rotation'][] = [180, 270, 90, 0];
const MIRRORED_ROTATION: readonly Orientation['rotation'][] = [90, 180, 0, 270];

/** At most this many of a finder's 49 modules may be wrong (decision Q9). */
const FINDER_TOLERANCE = 12;

/** The bounding box of the dark modules (light ones after inversion), or undefined. */
function trim(
  bits: Uint8Array,
  width: number,
  height: number,
  inverted: boolean,
): Trimmed | undefined {
  const dark = inverted ? 0 : 1;
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (bits[row + x] !== dark) continue;
      if (y < top) top = y;
      bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (bottom < 0) return undefined;
  return { inverted, x0: left, y0: top, width: right - left + 1, height: bottom - top + 1 };
}

function affine(o: Orientation, s: number): Affine {
  // c' = m0 + m1 * c (the mirror), then the clockwise rotation of (r, c').
  const m0 = o.mirrored ? s - 1 : 0;
  const m1 = o.mirrored ? -1 : 1;
  const e = s - 1;
  switch (o.rotation) {
    case 0:
      return { orientation: o, y0: 0, yr: 1, yc: 0, x0: m0, xr: 0, xc: m1 };
    case 90:
      return { orientation: o, y0: m0, yr: 0, yc: m1, x0: e, xr: -1, xc: 0 };
    case 180:
      return { orientation: o, y0: e, yr: -1, yc: 0, x0: e - m0, xr: 0, xc: -m1 };
    case 270:
      return { orientation: o, y0: e - m0, yr: 0, yc: -m1, x0: 0, xr: 1, xc: 0 };
    default: {
      const never: never = o.rotation;
      return never;
    }
  }
}

function geometryError(
  reason: 'size' | 'finder' | 'timing' | 'version' | 'format',
  message: string,
  extra: Record<string, number>,
): Gs1Error {
  return new Gs1Error({ code: 'INVALID_SYMBOL', message, details: { reason, ...extra } });
}

/** One symbol candidate: the trimmed input in one orientation, as canonical bits. */
class Candidate {
  readonly t: Trimmed;
  readonly a: Affine;
  readonly s: number;
  readonly version: number;
  /** Canonical s x s bits, 1 dark. */
  readonly bits: Uint8Array;

  constructor(input: Uint8Array, width: number, t: Trimmed, o: Orientation, version: number) {
    const s = t.width;
    this.t = t;
    this.s = s;
    this.version = version;
    this.a = affine(o, s);
    const { y0, yr, yc, x0, xr, xc } = this.a;
    const flip = t.inverted ? 1 : 0;
    const bits = new Uint8Array(s * s);
    for (let r = 0; r < s; r++) {
      let y = y0 + yr * r;
      let x = x0 + xr * r;
      const row = r * s;
      for (let c = 0; c < s; c++) {
        bits[row + c] = (input[(t.y0 + y) * width + t.x0 + x] ?? 0) ^ flip;
        y += yc;
        x += xc;
      }
    }
    this.bits = bits;
  }

  /** The caller's coordinates of canonical module (x = column, y = row). */
  at(x: number, y: number): { x: number; y: number } {
    const { y0, yr, yc, x0, xr, xc } = this.a;
    return { x: this.t.x0 + x0 + xr * y + xc * x, y: this.t.y0 + y0 + yr * y + yc * x };
  }

  bit(x: number, y: number): number {
    return this.bits[y * this.s + x] ?? 0;
  }
}

/** Mismatches of the 7x7 finder at (cx, cy) of the trimmed input (symmetric, so any orientation). */
function finderScore(input: Uint8Array, width: number, t: Trimmed, cx: number, cy: number): number {
  const flip = t.inverted ? 1 : 0;
  let wrong = 0;
  for (let dy = 0; dy < 7; dy++) {
    const row = (t.y0 + cy + dy) * width + t.x0 + cx;
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      const want = ring === 2 ? 0 : 1;
      if (((input[row + dx] ?? 0) ^ flip) !== want) wrong++;
    }
  }
  return wrong;
}

/** More than a quarter of row 6 and column 6 between the finders wrong (decision Q10). */
function timingFailure(c: Candidate): Failure | undefined {
  const s = c.s;
  let wrong = 0;
  let first: { x: number; y: number } | undefined;
  for (const vertical of [false, true]) {
    for (let i = 8; i <= s - 9; i++) {
      const x = vertical ? 6 : i;
      const y = vertical ? i : 6;
      if (c.bit(x, y) === (i % 2 === 0 ? 1 : 0)) continue;
      wrong++;
      first ??= { x, y };
    }
  }
  const total = 2 * (s - 16);
  if (wrong * 4 <= total || !first) return undefined;
  return {
    stage: Stage.Timing,
    error: geometryError(
      'timing',
      `The timing patterns do not match: ${wrong} of ${total} modules are wrong`,
      c.at(first.x, first.y),
    ),
  };
}

/** A version information copy that decodes cleanly to another version (decision Q10). */
function versionFailure(c: Candidate): Failure | undefined {
  if (c.version < 7) return undefined;
  const s = c.s;
  for (const transposed of [false, true]) {
    let bits = 0;
    for (let i = 0; i < 18; i++) {
      const a = s - 11 + (i % 3);
      const b = Math.floor(i / 3);
      if (transposed ? c.bit(b, a) : c.bit(a, b)) bits |= 1 << i;
    }
    const d = decodeVersion(bits);
    if (d && d.version !== c.version) {
      return {
        stage: Stage.Version,
        error: geometryError(
          'version',
          `The version information says ${d.version}, the size says ${c.version}`,
          transposed ? c.at(0, s - 11) : c.at(s - 11, 0),
        ),
      };
    }
  }
  return undefined;
}

/** Format bit i of copy 1 and copy 2, canonical (x, y) (QR research 1.2). */
function formatCell(i: number, copy: 1 | 2, s: number): [number, number] {
  if (copy === 2) return i <= 7 ? [s - 1 - i, 8] : [8, s - 15 + i];
  if (i <= 5) return [8, i];
  if (i === 6) return [8, 7];
  if (i === 7) return [8, 8];
  if (i === 8) return [7, 8];
  return [14 - i, 8];
}

interface FormatInfo {
  readonly level: QrEcLevel;
  readonly mask: number;
}

/**
 * The format words the two copies decode to, nearest first (copy 1 on a tie). Each copy is
 * decoded on its own, so a copy destroyed into another valid word still leaves the other copy's
 * word to try.
 */
function formatCandidates(c: Candidate): { readonly f: FormatInfo; readonly d: number }[] {
  const word = (copy: 1 | 2): number => {
    let v = 0;
    for (let i = 0; i < 15; i++) {
      const [x, y] = formatCell(i, copy, c.s);
      if (c.bit(x, y)) v |= 1 << i;
    }
    return v;
  };
  const found: { f: FormatInfo; d: number }[] = [];
  for (const copy of [word(1), word(2)]) {
    const f = decodeFormat(copy, copy);
    if (!f) continue;
    const d = popcount(formatBits(f.level, f.mask) ^ copy);
    const same = found.find((e) => e.f.level === f.level && e.f.mask === f.mask);
    if (same) continue;
    found.push({ f, d });
  }
  const [first, second] = found;
  return first && second && second.d < first.d ? [second, first] : found;
}

/** RS-corrects every block for one format word (decision Q8). */
function correct(c: Candidate, f: FormatInfo): Result<QrRead> {
  const { version } = c;
  const info = qrVersion(version).levels[f.level];
  const { ecPerBlock, correctable, blockData } = info;
  const blocks = deinterleave(version, f.level, readCodewords(version, c.bits, f.mask));
  const field = gf256(QR_POLY);
  let errorsCorrected = 0;
  const codewords: number[] = [];
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b] ?? new Uint8Array(0);
    const n = rsDecode(field, block, ecPerBlock, 0, correctable);
    if (n === undefined) {
      return fail([
        rsUncorrectable({
          block: b,
          blocks: blocks.length,
          ecCodewords: ecPerBlock,
          capacity: correctable,
        }),
      ]);
    }
    errorsCorrected += n;
    const data = blockData[b] ?? 0;
    for (let i = 0; i < data; i++) codewords.push(block[i] ?? 0);
  }
  return ok({
    version,
    level: f.level,
    mask: f.mask,
    codewords,
    ecCodewords: ecPerBlock * blocks.length,
    blocks: blocks.length,
    errorsCorrected,
    orientation: c.a.orientation,
    inverted: c.t.inverted,
  });
}

/** Format information then RS for one orientation. */
function decodeCandidate(c: Candidate): Result<QrRead> | Failure {
  const formats = formatCandidates(c);
  if (formats.length === 0) {
    return {
      stage: Stage.Format,
      error: geometryError(
        'format',
        'Neither format information copy is within 3 bits of a valid format word',
        c.at(8, 0),
      ),
    };
  }
  let error: Gs1Error | undefined;
  for (const { f } of formats) {
    const r = correct(c, f);
    if (r.ok) return r;
    error ??= r.errors[0];
  }
  return {
    stage: Stage.Rs,
    /* v8 ignore next */
    error: error ?? symbolError('codeword', 'Symbol could not be corrected'),
    exactFormat: formats[0]?.d === 0,
  };
}

function better(a: Failure | undefined, b: Failure): Failure {
  return a && a.stage >= b.stage ? a : b;
}

/** The pipeline for one trimmed reading (normal or inverted). */
function readTrimmed(
  input: Uint8Array,
  width: number,
  height: number,
  t: Trimmed | undefined,
): Result<QrRead> | Failure {
  const rows = t ? t.height : height;
  const columns = t ? t.width : width;
  const s = rows;
  if (!t || rows !== columns || s < 21 || s > 177 || (s - 17) % 4 !== 0) {
    return {
      stage: Stage.Size,
      error: geometryError('size', `${rows}x${columns} is not a QR Code size`, { rows, columns }),
    };
  }
  const version = (s - 17) / 4;
  const origins: readonly (readonly [number, number])[] = [
    [0, 0],
    [s - 7, 0],
    [0, s - 7],
    [s - 7, s - 7],
  ];
  const scores = origins.map(([x, y]) => finderScore(input, width, t, x, y));
  // The corner without a finder: the worst score, the bottom right first on a tie.
  let missing = BR;
  for (const k of [BL, TR, TL]) if ((scores[k] ?? 0) > (scores[missing] ?? 0)) missing = k;
  let failing = -1;
  for (let k = TL; k <= BR; k++) {
    if (k === missing || (scores[k] ?? 0) <= FINDER_TOLERANCE) continue;
    if (failing < 0 || (scores[k] ?? 0) < (scores[failing] ?? 0)) failing = k;
  }
  if (failing >= 0) {
    const [fx, fy] = origins[failing] ?? [0, 0];
    return {
      stage: Stage.Finder,
      error: geometryError(
        'finder',
        `Three finder patterns are needed: ${scores[failing] ?? 0} of 49 modules are wrong`,
        { x: t.x0 + fx, y: t.y0 + fy },
      ),
    };
  }

  const plain = new Candidate(
    input,
    width,
    t,
    {
      rotation: PLAIN_ROTATION[missing] ?? 0,
      mirrored: false,
    },
    version,
  );
  // Timing and version information are symmetric under the transpose: checked once.
  const geometric = timingFailure(plain) ?? versionFailure(plain);
  if (geometric) return geometric;
  const first = decodeCandidate(plain);
  if (!('stage' in first)) return first;
  const mirrored = new Candidate(
    input,
    width,
    t,
    {
      rotation: MIRRORED_ROTATION[missing] ?? 0,
      mirrored: true,
    },
    version,
  );
  const second = decodeCandidate(mirrored);
  if (!('stage' in second)) return second;
  // The plain reading's error, unless only the transposed one found exact format information.
  return first.stage === Stage.Format && second.exactFormat === true ? second : first;
}

function read(symbol: unknown): Result<QrRead> {
  const m = readMatrix(symbol);
  if (!m.ok) return fail(m.errors);
  const { width, height, bits } = m.value;
  let worst: Failure | undefined;
  for (const inverted of [false, true]) {
    const r = readTrimmed(bits, width, height, trim(bits, width, height, inverted));
    if (!('stage' in r)) return r;
    worst = better(worst, r);
  }
  /* v8 ignore next */
  return fail([worst?.error ?? symbolError('pattern', 'Symbol could not be read')]);
}

/**
 * Reads a QR Code Model 2 symbol (decisions Q9, Q10, Q8): trims light outer rows and columns,
 * requires a square of side 21 + 4k, turns the corner without a finder to the bottom right
 * (retrying on the reflectance-reversed matrix), checks the timing patterns and the version
 * information, decodes the format information and RS-corrects every block, retrying once
 * transposed when the format information or RS fails. Never throws. Errors: INVALID_SYMBOL
 * `pattern` (malformed input), `size` (`details.rows`, `details.columns`), `finder`, `timing`,
 * `version`, `format` (with `details.x`, `details.y` in the caller's matrix coordinates);
 * RS_UNCORRECTABLE (`block`, `blocks`, `ecCodewords` per block, `capacity`).
 */
export function readQr(symbol: unknown): Result<QrRead> {
  try {
    return read(symbol);
  } catch {
    /* v8 ignore next */
    return fail([symbolError('pattern', 'Symbol could not be read')]);
  }
}

// ---------------------------------------------------------------------------------------------
// Decodation

const GS = '\u001d';
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function codewordError(index: number, value: unknown, message: string): Gs1Error {
  return new Gs1Error({
    code: 'INVALID_SYMBOL',
    message,
    details: { reason: 'codeword', codeword: index, value },
  });
}

class BitReader {
  readonly cw: readonly number[];
  readonly total: number;
  pos = 0;

  constructor(cw: readonly number[]) {
    this.cw = cw;
    this.total = cw.length * 8;
  }

  get remaining(): number {
    return this.total - this.pos;
  }

  /** `n` bits, MSB first; the caller checks `remaining`. */
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++, this.pos++)
      v = (v << 1) | (((this.cw[this.pos >> 3] ?? 0) >> (7 - (this.pos & 7))) & 1);
    return v;
  }
}

class Parser {
  readonly r: BitReader;
  readonly version: number;
  readonly parts: string[] = [];
  readonly segments: QrSegmentInfo[] = [];
  aimId: QrText['aimId'] = ']Q1';
  /** FNC1 in first or second position: the alphanumeric `%` rule applies. */
  fnc1 = false;
  started = false;
  special: QrSpecial | undefined;

  constructor(cw: readonly number[], version: number) {
    this.r = new BitReader(cw);
    this.version = version;
  }

  /** The codeword holding bit `bit`. */
  static codeword(bit: number): number {
    return bit >> 3;
  }

  /** Throws unless `n` bits remain; `at` is the segment's indicator bit. */
  need(n: number, at: number): void {
    if (n > this.r.remaining)
      throw codewordError(
        Parser.codeword(at),
        this.r.cw[Parser.codeword(at)],
        'The bit stream ends inside a segment',
      );
  }

  mark(s: QrSpecial): void {
    this.special ??= s;
  }

  /** Runs to the terminator or the end; returns the bits before the terminator. */
  run(): number {
    const r = this.r;
    while (r.remaining >= 4) {
      const at = r.pos;
      const indicator = r.read(4);
      switch (indicator) {
        case 0b0000:
          return at;
        case 0b0001:
          this.numeric(at);
          break;
        case 0b0010:
          this.alphanumeric(at);
          break;
        case 0b0100:
          this.byte(at);
          break;
        case 0b1000:
          this.kanji(at);
          break;
        case 0b0111:
          this.eci(at);
          break;
        case 0b0101:
          this.header(at, 'FNC1 in first position');
          this.fnc1 = true;
          this.aimId = ']Q3';
          break;
        case 0b1001:
          this.header(at, 'FNC1 in second position');
          this.fnc1Second(at);
          break;
        case 0b0011:
          this.header(at, 'A structured append header');
          this.structuredAppend(at);
          break;
        default:
          throw codewordError(
            Parser.codeword(at),
            indicator,
            `Mode indicator ${indicator.toString(2).padStart(4, '0')} is not valid`,
          );
      }
    }
    return r.pos;
  }

  /** FNC1 and structured append must precede the data, once. */
  header(at: number, what: string): void {
    if (this.started || this.fnc1)
      throw codewordError(
        Parser.codeword(at),
        this.r.cw[Parser.codeword(at)],
        `${what} must precede the data`,
      );
  }

  count(mode: QrSegmentInfo['mode'], at: number): number {
    const width = countBits(mode, this.version);
    this.need(width, at);
    const n = this.r.read(width);
    this.started = true;
    this.segments.push({ mode, count: n });
    return n;
  }

  numeric(at: number): void {
    const n = this.count('numeric', at);
    const rest = n % 3;
    this.need(10 * Math.floor(n / 3) + (rest === 0 ? 0 : rest === 1 ? 4 : 7), at);
    let out = '';
    for (let left = n; left > 0; left -= 3) {
      const k = Math.min(3, left);
      const p = this.r.pos;
      const v = this.r.read(k === 3 ? 10 : k === 2 ? 7 : 4);
      if (v >= 10 ** k)
        throw codewordError(Parser.codeword(p), v, `Numeric value ${v} is out of range`);
      out += String(v).padStart(k, '0');
    }
    this.parts.push(out);
  }

  alphanumeric(at: number): void {
    const n = this.count('alphanumeric', at);
    this.need(11 * Math.floor(n / 2) + 6 * (n % 2), at);
    let out = '';
    for (let left = n; left > 0; left -= 2) {
      const p = this.r.pos;
      if (left >= 2) {
        const v = this.r.read(11);
        if (v > 2024)
          throw codewordError(Parser.codeword(p), v, `Alphanumeric pair ${v} is out of range`);
        out += (ALNUM[Math.floor(v / 45)] ?? '') + (ALNUM[v % 45] ?? '');
      } else {
        const v = this.r.read(6);
        if (v > 44)
          throw codewordError(Parser.codeword(p), v, `Alphanumeric value ${v} is out of range`);
        out += ALNUM[v] ?? '';
      }
    }
    this.parts.push(this.fnc1 ? percent(out) : out);
  }

  byte(at: number): void {
    const n = this.count('byte', at);
    this.need(8 * n, at);
    let out = '';
    for (let i = 0; i < n; i++) out += String.fromCharCode(this.r.read(8));
    this.parts.push(out);
  }

  /** Shift JIS byte pairs (QR research 2.6), only so that parsing can finish. */
  kanji(at: number): void {
    const n = this.count('kanji', at);
    this.need(13 * n, at);
    let out = '';
    for (let i = 0; i < n; i++) {
      const v = this.r.read(13);
      const packed = (Math.floor(v / 0xc0) << 8) | (v % 0xc0);
      const c = packed + (packed < 0x1f00 ? 0x8140 : 0xc140);
      out += String.fromCharCode(c >> 8, c & 0xff);
    }
    this.parts.push(out);
    this.mark({ reason: 'kanji' });
  }

  eci(at: number): void {
    this.need(8, at);
    const p = this.r.pos;
    const b = this.r.read(8);
    let v: number;
    if ((b & 0x80) === 0) v = b;
    else if ((b & 0xc0) === 0x80) {
      this.need(8, at);
      v = ((b & 0x3f) << 8) | this.r.read(8);
    } else if ((b & 0xe0) === 0xc0) {
      this.need(16, at);
      v = ((b & 0x1f) << 16) | this.r.read(16);
    } else throw codewordError(Parser.codeword(p), b, 'Invalid ECI designator');
    if (v > 999_999)
      throw codewordError(Parser.codeword(p), v, `ECI designator ${v} is out of range`);
    this.mark({ reason: 'eci', eci: v });
  }

  fnc1Second(at: number): void {
    this.need(8, at);
    const p = this.r.pos;
    const v = this.r.read(8);
    let prefix: string;
    if (v < 100) prefix = String(v).padStart(2, '0');
    else {
      const c = v - 100;
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122)))
        throw codewordError(Parser.codeword(p), v, `Application indicator ${v} is not valid`);
      prefix = String.fromCharCode(c);
    }
    this.aimId = ']Q5';
    this.fnc1 = true;
    this.parts.push(prefix);
    this.mark({ reason: 'fnc1-second', applicationIndicator: v });
  }

  structuredAppend(at: number): void {
    this.need(16, at);
    const position = this.r.read(4);
    const total = this.r.read(4) + 1;
    const parity = this.r.read(8);
    this.mark({ reason: 'structured-append', position, total, parity });
  }
}

/** FNC1 mode: `%%` is `%`, a single `%` is GS, left to right (QR research 2.2). */
function percent(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? '';
    if (ch !== '%') out += ch;
    else if (s[i + 1] === '%') {
      out += '%';
      i++;
    } else out += GS;
  }
  return out;
}

/**
 * Decodes the data codewords of a symbol of `version` (decision Q11, QR research 2.6): numeric,
 * alphanumeric, byte and Kanji segments, ECI, FNC1 first and second, structured append and the
 * terminator, which may be truncated; bits after it are ignored. With FNC1, alphanumeric `%%` is
 * `%` and `%` is GS. ECI, structured append, FNC1 second and Kanji are reported in `special`
 * (the first met). Invalid streams are INVALID_SYMBOL `codeword` with `details.codeword`, the
 * index of the data codeword where the stream broke: the segment's mode indicator for unknown
 * modes, misplaced headers and counts beyond the data, the value's codeword for values out of
 * range. A version outside 1..40 is INVALID_VALUE `version`. Never throws.
 */
export function decodeBits(codewords: readonly number[], version: number): Result<QrText> {
  try {
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 40)
      return fail([
        new Gs1Error({
          code: 'INVALID_VALUE',
          message: 'Version must be an integer from 1 to 40',
          details: { option: 'version' },
        }),
      ]);
    if (!Array.isArray(codewords))
      return fail([codewordError(0, undefined, 'Codewords must be an array')]);
    const cw: number[] = Array.from(codewords);
    for (let i = 0; i < cw.length; i++) {
      const v: unknown = cw[i];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255)
        return fail([codewordError(i, v, 'Codewords must be integers 0 to 255')]);
    }
    const p = new Parser(cw, version);
    const dataBits = p.run();
    return ok({
      aimId: p.aimId,
      data: p.parts.join(''),
      dataBits,
      segments: p.segments,
      ...(p.special === undefined ? {} : { special: p.special }),
    });
  } catch (e) {
    if (e instanceof Gs1Error) return fail([e]);
    /* v8 ignore next */
    return fail([codewordError(0, undefined, 'Codewords could not be read')]);
  }
}
