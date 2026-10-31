import { Gs1Error, fail, ok } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import { DM_POLY, gf256 } from '../../core/gf256.ts';
import { rsDecode } from '../../core/reed-solomon.ts';
import { readMatrix, rsUncorrectable, symbolError } from '../render/internal.ts';
import type { Orientation } from '../render/index.ts';
import { type DmSize, dmBlockEc, dmSize } from './dm-tables.ts';
import { deinterleave, finderMismatches, readCodewords } from './dm-place.ts';

/** Moved to `common.ts` (decision Q15), re-exported for the M6a tests. */
export { gs1FromData } from './common.ts';

/** Encodation modes as the decoder reports them. */
export type DmMode = 'ascii' | 'c40' | 'text' | 'x12' | 'edifact' | 'base256';

/** A symbol read from a matrix: size, orientation and the corrected data codewords. */
export interface DmRead {
  readonly size: DmSize;
  /** Data codewords after RS, before decodation (pads included). */
  readonly codewords: readonly number[];
  readonly errorsCorrected: number;
  /**
   * How the input was turned: the canonical symbol, mirrored left to right when `mirrored`, then
   * rotated clockwise by `rotation`, gives the input.
   */
  readonly orientation: Orientation;
  /** Whether the input had reversed reflectance (light modules on dark). */
  readonly inverted: boolean;
}

/** The transmitted data of a codeword stream (decision H14). */
export interface DmText {
  /** `]d2` (FNC1 first or fifth), `]d1` (no FNC1), `]d3` (FNC1 second, AIM application indicator). */
  readonly aimId: string;
  /** Transmitted data, FNC1 separators as GS, without the AIM id. */
  readonly data: string;
  /** Modes in order of use (a mode is used by every codeword read in it but latches and pads). */
  readonly encodation: readonly DmMode[];
  /** The first special feature met, if any (decision H14). */
  readonly special?: 'macro' | 'eci' | 'structured-append' | 'reader-programming';
  /** Codewords decoded before the first pad. */
  readonly length: number;
  /** The first ECI designator. */
  readonly eci?: number;
  /** The structured append header: 0-based index, symbol count and the two file id codewords. */
  readonly structuredAppend?: {
    readonly index: number;
    readonly count: number;
    readonly fileId: readonly [number, number];
  };
}

// ---------------------------------------------------------------------------------------------
// Geometry

/** DMRE sizes (ISO/IEC 21471), rows x columns: out of scope, recognised for a better error. */
const DMRE: readonly (readonly [number, number])[] = [
  [8, 48],
  [8, 64],
  [8, 80],
  [8, 96],
  [8, 120],
  [8, 144],
  [12, 64],
  [12, 88],
  [16, 64],
  [20, 36],
  [20, 44],
  [20, 64],
  [22, 48],
  [24, 48],
  [24, 64],
  [26, 40],
  [26, 48],
  [26, 64],
];

const ROTATIONS: readonly Orientation['rotation'][] = [0, 90, 180, 270];

interface Trimmed {
  readonly inverted: boolean;
  readonly x0: number;
  readonly y0: number;
  readonly width: number;
  readonly height: number;
}

interface Candidate {
  readonly from: Trimmed;
  readonly size: DmSize;
  readonly orientation: Orientation;
  /** Canonical rows x columns bits (1 dark). */
  readonly bits: Uint8Array;
  readonly mismatches: number;
  readonly fixed: number;
}

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
    for (let x = 0; x < width; x++) {
      if (bits[y * width + x] !== dark) continue;
      if (y < top) top = y;
      bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (bottom < 0) return undefined;
  return { inverted, x0: left, y0: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Trimmed-input coordinates of canonical module (r, c) of an R x C symbol. */
function inputAt(
  o: Orientation,
  R: number,
  C: number,
  r: number,
  c0: number,
): { y: number; x: number } {
  const c = o.mirrored ? C - 1 - c0 : c0;
  switch (o.rotation) {
    case 0:
      return { y: r, x: c };
    case 90:
      return { y: c, x: R - 1 - r };
    case 180:
      return { y: R - 1 - r, x: C - 1 - c };
    case 270:
      return { y: C - 1 - c, x: r };
    default: {
      const never: never = o.rotation;
      return never;
    }
  }
}

/** Expected value of a fixed module (1 dark, 0 light), or -1 for a data module (research 4.2). */
function fixedAt(size: DmSize, y: number, x: number): number {
  const bh = size.regionHeight + 2;
  const bw = size.regionWidth + 2;
  const ry = y % bh;
  const rx = x % bw;
  if (ry === bh - 1) return 1;
  if (ry === 0) return x % 2 === 0 ? 1 : 0;
  if (rx === 0) return 1;
  if (rx === bw - 1) return y % 2 === 1 ? 1 : 0;
  return -1;
}

function candidatesOf(bits: Uint8Array, width: number, t: Trimmed): Candidate[] {
  const out: Candidate[] = [];
  const flip = t.inverted ? 1 : 0;
  for (const rotation of ROTATIONS) {
    for (const mirrored of [false, true]) {
      const swap = rotation === 90 || rotation === 270;
      const R = swap ? t.width : t.height;
      const C = swap ? t.height : t.width;
      const size = dmSize(R, C);
      if (!size) continue;
      const orientation: Orientation = { rotation, mirrored };
      const canon = new Uint8Array(R * C);
      for (let r = 0; r < R; r++) {
        for (let c = 0; c < C; c++) {
          const { y, x } = inputAt(orientation, R, C, r, c);
          canon[r * C + c] = (bits[(t.y0 + y) * width + t.x0 + x] ?? 0) ^ flip;
        }
      }
      const mapping = size.regionRows * size.regionHeight * size.regionColumns * size.regionWidth;
      out.push({
        from: t,
        size,
        orientation,
        bits: canon,
        mismatches: finderMismatches(size, canon),
        fixed: R * C - mapping,
      });
    }
  }
  return out;
}

function geometryError(
  reason: 'size' | 'finder',
  message: string,
  extra: Record<string, number>,
): Gs1Error {
  return new Gs1Error({ code: 'INVALID_SYMBOL', message, details: { reason, ...extra } });
}

/** The finder error of the best candidate, located at its first wrong fixed module. */
function finderError(c: Candidate): Gs1Error {
  const { rows: R, columns: C } = c.size;
  for (let r = 0; r < R; r++) {
    for (let col = 0; col < C; col++) {
      const want = fixedAt(c.size, r, col);
      if (want < 0 || want === c.bits[r * C + col]) continue;
      const { y, x } = inputAt(c.orientation, R, C, r, col);
      return geometryError(
        'finder',
        `The finder pattern does not match: ${c.mismatches} of ${c.fixed} modules are wrong`,
        { x: c.from.x0 + x, y: c.from.y0 + y },
      );
    }
  }
  /* v8 ignore next */
  return geometryError('finder', 'The finder pattern does not match', {});
}

/** RS-corrects every block of a candidate (decision H13). */
function correct(c: Candidate): Result<DmRead> {
  const { size } = c;
  const blocks = deinterleave(size, readCodewords(size, c.bits));
  const ec = dmBlockEc(size);
  const field = gf256(DM_POLY);
  let errorsCorrected = 0;
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b] ?? new Uint8Array(0);
    const n = rsDecode(field, block, ec, 1, ec >> 1);
    if (n === undefined)
      return fail([
        rsUncorrectable({ block: b, blocks: size.blocks, ecCodewords: ec, capacity: ec >> 1 }),
      ]);
    errorsCorrected += n;
  }
  const codewords: number[] = [];
  for (let i = 0; i < size.dataCodewords; i++)
    codewords.push(blocks[i % size.blocks]?.[Math.floor(i / size.blocks)] ?? 0);
  return ok({
    size,
    codewords,
    errorsCorrected,
    orientation: c.orientation,
    inverted: c.from.inverted,
  });
}

/** At most a quarter of the fixed modules wrong (decision H12). */
function plausible(c: Candidate | undefined): c is Candidate {
  return c !== undefined && c.mismatches * 4 <= c.fixed;
}

function isDmre(rows: number, columns: number): boolean {
  return DMRE.some(([r, c]) => (r === rows && c === columns) || (r === columns && c === rows));
}

function read(symbol: unknown): Result<DmRead> {
  const m = readMatrix(symbol);
  if (!m.ok) return fail(m.errors);
  const { width, height, bits } = m.value;
  const trimmed: Trimmed[] = [];
  for (const inverted of [false, true]) {
    const t = trim(bits, width, height, inverted);
    if (t) trimmed.push(t);
  }
  const all = trimmed.flatMap((t) => candidatesOf(bits, width, t));
  if (all.length === 0) {
    const dmre = trimmed.find((t) => isDmre(t.height, t.width));
    if (dmre) {
      return fail([
        new Gs1Error({
          code: 'UNSUPPORTED',
          message: `${dmre.height}x${dmre.width} is a DMRE size, which is not supported`,
          details: { reason: 'dmre', rows: dmre.height, columns: dmre.width },
        }),
      ]);
    }
    const t = trimmed[0];
    const rows = t ? t.height : height;
    const columns = t ? t.width : width;
    return fail([
      geometryError('size', `${rows}x${columns} is not an ECC 200 symbol size`, { rows, columns }),
    ]);
  }
  // Best finder match first (as a share of the fixed modules); stable, so ties keep the order
  // normal before inverted, identity first.
  const ranked = all
    .map((c, i) => ({ c, i }))
    // oxlint-disable-next-line no-array-sort -- sorts a fresh array
    .sort((a, b) => a.c.mismatches / a.c.fixed - b.c.mismatches / b.c.fixed || a.i - b.i)
    .map((e) => e.c);
  const best = ranked[0];
  if (!plausible(best))
    return fail([best ? finderError(best) : geometryError('finder', 'No finder pattern', {})]);
  const first = correct(best);
  if (first.ok) return first;
  const second = ranked[1];
  if (plausible(second)) {
    const r = correct(second);
    if (r.ok) return r;
  }
  return first;
}

/**
 * Reads a DataMatrix ECC 200 symbol (decision H12): trims light outer rows and columns, tries the
 * orientations whose dimensions are an ECC 200 size and the reflectance-reversed matrix, ranks
 * them by finder and clock mismatches and RS-corrects the best (then the second best). Never
 * throws. Errors: INVALID_SYMBOL `pattern` (malformed input), `size` (`details.rows`,
 * `details.columns`), `finder` (`details.x`, `details.y` in the caller's matrix coordinates);
 * UNSUPPORTED `dmre`; RS_UNCORRECTABLE (decision H13).
 */
export function readDataMatrix(symbol: unknown): Result<DmRead> {
  try {
    return read(symbol);
  } catch {
    /* v8 ignore next */
    return fail([symbolError('pattern', 'Symbol could not be read')]);
  }
}

// ---------------------------------------------------------------------------------------------
// Decodation

const GS = 29;
const SHIFT2 = '!"#$%&\'()*+,-./:;<=>?@[\\]^_';
const EDIFACT_SKIP: readonly number[] = [1, 2, 3, 3];
/** ASCII latch codewords to C40, X12, Text and EDIFACT (Base 256 is read at once). */
const LATCHES: Readonly<Partial<Record<number, DmMode>>> = {
  230: 'c40',
  238: 'x12',
  239: 'text',
  240: 'edifact',
};

function codewordError(index: number, value: unknown, message: string): Gs1Error {
  return new Gs1Error({
    code: 'INVALID_SYMBOL',
    message,
    details: { reason: 'codeword', codeword: index, value },
  });
}

function isLetterCodeword(c: number | undefined): boolean {
  return c !== undefined && ((c >= 66 && c <= 91) || (c >= 98 && c <= 123));
}

type Special = NonNullable<DmText['special']>;

class Decoder {
  readonly cw: readonly number[];
  i = 0;
  mode: DmMode = 'ascii';
  out = '';
  trailer = '';
  readonly modes: DmMode[] = [];
  /** Index of the "first position" (4 after a structured append header). */
  start = 0;
  aimId = ']d1';
  special: Special | undefined;
  eci: number | undefined;
  sa: DmText['structuredAppend'];
  /** C40/Text shift set pending (0 none) and upper shift pending. */
  shift = 0;
  upper = false;

  constructor(cw: readonly number[]) {
    this.cw = cw;
  }

  at(i: number): number {
    const c = this.cw[i];
    if (c === undefined) throw codewordError(i, undefined, 'The codeword stream ends early');
    return c;
  }

  use(m: DmMode): void {
    if (this.modes[this.modes.length - 1] !== m) this.modes.push(m);
  }

  mark(s: Special): void {
    this.special ??= s;
  }

  char(c: number): void {
    this.out += String.fromCharCode(c);
  }

  /** Runs to the first pad or the end; returns the number of codewords decoded. */
  run(): number {
    const n = this.cw.length;
    while (this.i < n) {
      if (this.mode === 'ascii') {
        if (!this.ascii()) return this.i - 1;
      } else if (this.mode === 'edifact') this.edifact();
      else this.triplet();
    }
    return n;
  }

  /** One ASCII codeword; false at a pad. */
  ascii(): boolean {
    const p = this.i;
    const c = this.at(this.i++);
    if (c === 129) return false;
    if (c === 231) {
      this.base256();
      return true;
    }
    const next = LATCHES[c];
    if (next !== undefined) {
      this.mode = next;
      return true;
    }
    this.use('ascii');
    if (c >= 1 && c <= 128) this.char(c - 1);
    else if (c >= 130 && c <= 229) {
      const d = c - 130;
      this.out += String(Math.floor(d / 10)) + String(d % 10);
    } else if (c === 232) this.fnc1(p);
    else if (c === 233 && p === 0) this.structuredAppend();
    else if (c === 234 && p === 0) this.mark('reader-programming');
    else if (c === 235) {
      const u = this.at(this.i);
      if (u < 1 || u > 128) throw codewordError(this.i, u, 'Upper shift must precede a character');
      this.i++;
      this.char(u - 1 + 128);
    } else if ((c === 236 || c === 237) && p === this.start) {
      this.mark('macro');
      this.out += `[)>\u001e${c === 236 ? '05' : '06'}\u001d`;
      this.trailer = '\u001e\u0004';
    } else if (c === 241) this.eciDesignator();
    else throw codewordError(p, c, `Codeword ${c} is not valid here`);
    return true;
  }

  fnc1(p: number): void {
    if (p === this.start) this.aimId = ']d2';
    else if (
      p === this.start + 1 &&
      this.aimId === ']d1' &&
      (isLetterCodeword(this.cw[p - 1]) ||
        ((this.cw[p - 1] ?? 0) >= 130 && (this.cw[p - 1] ?? 0) <= 229))
    )
      this.aimId = ']d3';
    else this.char(GS);
  }

  structuredAppend(): void {
    const seq = this.at(this.i);
    const f1 = this.at(this.i + 1);
    const f2 = this.at(this.i + 2);
    const index = seq >> 4;
    const count = 17 - (seq & 15);
    if ((seq & 15) === 0 || index >= count)
      throw codewordError(this.i, seq, 'Invalid structured append sequence indicator');
    if (f1 < 1 || f1 > 254)
      throw codewordError(this.i + 1, f1, 'Invalid structured append file id');
    if (f2 < 1 || f2 > 254)
      throw codewordError(this.i + 2, f2, 'Invalid structured append file id');
    this.i += 3;
    this.start = 4;
    this.mark('structured-append');
    this.sa = { index, count, fileId: [f1, f2] };
  }

  eciDesignator(): void {
    const p = this.i;
    const c1 = this.at(p);
    const tail = (k: number): number => {
      const v = this.at(p + k);
      if (v < 1 || v > 254) throw codewordError(p + k, v, 'Invalid ECI designator');
      return v;
    };
    let v: number;
    if (c1 >= 1 && c1 <= 127) {
      v = c1 - 1;
      this.i += 1;
    } else if (c1 >= 128 && c1 <= 191) {
      v = (c1 - 128) * 254 + tail(1) - 1 + 127;
      this.i += 2;
    } else if (c1 >= 192 && c1 <= 253) {
      v = (c1 - 192) * 64516 + (tail(1) - 1) * 254 + tail(2) - 1 + 16383;
      this.i += 3;
    } else throw codewordError(p, c1, 'Invalid ECI designator');
    this.eci ??= v;
    this.mark('eci');
  }

  leave(): void {
    this.mode = 'ascii';
    this.shift = 0;
    this.upper = false;
  }

  /** C40, Text or X12: one triplet, the unlatch, or the switch to ASCII for a lone last codeword. */
  triplet(): void {
    const n = this.cw.length;
    if (this.cw[this.i] === 254) {
      this.i++;
      this.leave();
      return;
    }
    if (n - this.i === 1) {
      this.leave();
      return;
    }
    const p = this.i;
    const v = this.at(p) * 256 + this.at(p + 1) - 1;
    if (v < 0 || v > 63999)
      throw codewordError(p, this.cw[p], 'Invalid C40, Text or X12 codeword pair');
    this.i += 2;
    this.use(this.mode);
    for (const x of [Math.floor(v / 1600), Math.floor(v / 40) % 40, v % 40]) this.value(x, p);
  }

  emit(c: number): void {
    this.char(this.upper ? c + 128 : c);
    this.upper = false;
  }

  value(x: number, p: number): void {
    const bad = (): Gs1Error => codewordError(p, this.cw[p], `Invalid ${this.mode} value ${x}`);
    if (this.mode === 'x12') {
      if (x < 4) this.char([13, 42, 62, 32][x] ?? 32);
      else if (x < 14) this.char(48 + x - 4);
      else this.char(65 + x - 14);
      return;
    }
    const shift = this.shift;
    this.shift = 0;
    if (shift === 0) {
      if (x < 3) this.shift = x + 1;
      else if (x === 3) this.emit(32);
      else if (x < 14) this.emit(48 + x - 4);
      else this.emit((this.mode === 'c40' ? 65 : 97) + x - 14);
    } else if (shift === 1) {
      if (x > 31) throw bad();
      this.emit(x);
    } else if (shift === 2) {
      if (x < 27) this.emit(SHIFT2.charCodeAt(x));
      else if (x === 27 && !this.upper) this.char(GS);
      else if (x === 30) this.upper = true;
      else throw bad();
    } else if (x > 31) throw bad();
    else if (this.mode === 'c40') this.emit(96 + x);
    else if (x === 0) this.emit(96);
    else if (x <= 26) this.emit(64 + x);
    else this.emit(123 + x - 27);
  }

  /** EDIFACT: one group of 3 codewords, or ASCII when at most 2 codewords remain. */
  edifact(): void {
    if (this.cw.length - this.i <= 2) {
      this.leave();
      return;
    }
    const p = this.i;
    const bits = (this.at(p) << 16) | (this.at(p + 1) << 8) | this.at(p + 2);
    for (let k = 0; k < 4; k++) {
      const v = (bits >> (18 - 6 * k)) & 63;
      if (v === 31) {
        this.i += EDIFACT_SKIP[k] ?? 3;
        this.leave();
        return;
      }
      this.use('edifact');
      this.char(v & 32 ? v : v | 64);
    }
    this.i += 3;
  }

  /** Base 256: the 255-state randomised length field and bytes (research 3.3). */
  base256(): void {
    const unr = (k: number): number => {
      const r = this.at(k) - (((149 * (k + 1)) % 255) + 1);
      return r < 0 ? r + 256 : r;
    };
    const p = this.i;
    const d1 = unr(this.i++);
    let len: number;
    if (d1 === 0) len = this.cw.length - this.i;
    else if (d1 < 250) len = d1;
    else len = 250 * (d1 - 249) + unr(this.i++);
    if (this.i + len > this.cw.length)
      throw codewordError(p, this.cw[p], 'The Base 256 length exceeds the data');
    this.use('base256');
    for (let k = 0; k < len; k++) this.char(unr(this.i++));
    this.leave();
  }
}

/**
 * Decodes data codewords (decision H14): ASCII (digit pairs, upper shift, FNC1, pads), C40, Text,
 * X12, EDIFACT and Base 256, with the tail rules of research 7, stopping at the first pad.
 * Structured append, reader programming, macros and ECI are decoded and reported in `special`
 * (see `specialError`). Invalid codewords are INVALID_SYMBOL `codeword` with `details.codeword`
 * (the index in `codewords`) and `details.value`. Never throws.
 */
export function decodeCodewords(codewords: readonly number[]): Result<DmText> {
  try {
    const cw = Array.from(codewords);
    for (let i = 0; i < cw.length; i++) {
      const v: unknown = cw[i];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255)
        return fail([codewordError(i, v, 'Codewords must be integers 0 to 255')]);
    }
    const d = new Decoder(cw);
    const length = d.run();
    return ok({
      aimId: d.aimId,
      data: d.out + d.trailer,
      encodation: d.modes,
      length,
      ...(d.special === undefined ? {} : { special: d.special }),
      ...(d.eci === undefined ? {} : { eci: d.eci }),
      ...(d.sa === undefined ? {} : { structuredAppend: d.sa }),
    });
  } catch (e) {
    if (e instanceof Gs1Error) return fail([e]);
    /* v8 ignore next */
    return fail([codewordError(0, undefined, 'Codewords could not be read')]);
  }
}

const SPECIAL_MESSAGES: Record<Special | 'fnc1-second', string> = {
  macro: 'a 05 or 06 macro',
  eci: 'an ECI designator',
  'structured-append': 'a structured append header',
  'reader-programming': 'reader programming',
  'fnc1-second': 'FNC1 in second position (AIM application indicator)',
};

/**
 * UNSUPPORTED for decoded data that is not plain GS1 or Digital Link data: `details.reason`
 * (`macro`, `eci`, `structured-append`, `reader-programming`, `fnc1-second`), `details.aimId`,
 * `details.rawData`, plus `eci` or the structured append `index`, `count` and `fileId`.
 * Undefined for plain data.
 */
export function specialError(t: DmText): Gs1Error | undefined {
  const reason = t.special ?? (t.aimId === ']d3' ? 'fnc1-second' : undefined);
  if (reason === undefined) return undefined;
  const sa = t.structuredAppend;
  return new Gs1Error({
    code: 'UNSUPPORTED',
    message: `Data Matrix with ${SPECIAL_MESSAGES[reason]} is not supported`,
    details: {
      reason,
      aimId: t.aimId,
      rawData: t.data,
      ...(t.eci === undefined ? {} : { eci: t.eci }),
      ...(sa === undefined ? {} : { index: sa.index, count: sa.count, fileId: sa.fileId }),
    },
  });
}
