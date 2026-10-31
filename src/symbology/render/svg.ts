import { Gs1Error, fail, ok } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import { symbolError } from './errors.ts';
import { readMatrix } from './matrix.ts';
import type {
  Bearer,
  HriText,
  LinearPattern,
  ModuleMatrix,
  PatternRow,
  QuietZone,
} from './types.ts';

/** Options of `toSvg`. Geometry (bar heights) belongs to the encoder, not the renderer. */
export interface SvgOptions {
  /** Size of one module in `unit`s. Default 2. */
  readonly moduleSize?: number;
  /** Unit of the `width` and `height` attributes. Default `'px'`. */
  readonly unit?: 'px' | 'mm';
  /** `true` (default): the pattern's minimum quiet zones; `false`: none; a number: all sides in modules; or single sides. */
  readonly quietZone?: boolean | number | Partial<QuietZone>;
  /** Draw the human readable text. Default `true`. */
  readonly hri?: boolean;
  /** Fill of the bars and text. Default `'#000'`. */
  readonly foreground?: string;
  /** Background fill; `null` for none. Default `'#fff'`. */
  readonly background?: string | null;
  /** Font family of the text. Default `'OCR-B,OCRB,monospace'`. */
  readonly fontFamily?: string;
  /** Accessible `<title>`. */
  readonly title?: string;
}

const MAX_ITEMS = 10_000;
const MAX_RUNS = 1_000_000;
/** Pattern coordinates are bounded so that every sum stays far below 1e21. */
const MAX_COORD = 1e12;
/**
 * The largest width or height of the image, in `unit`s. Far above any real barcode; it stops a
 * huge `moduleSize` or `quietZone` from asking a rasterizer for an image too large to hold.
 */
const MAX_IMAGE = 1e6;
/**
 * Paint values for `foreground` and `background`: a hex color, a color keyword, or rgb(),
 * rgba(), hsl() or hsla() of numbers. No url() or other paint server references.
 */
function isPaint(v: string): boolean {
  if (v.length === 0 || v.length > 64) return false;
  if (v.charCodeAt(0) === 0x23) {
    const hex = v.slice(1);
    return [3, 4, 6, 8].includes(hex.length) && /^[0-9a-f]+$/i.test(hex);
  }
  if (/^[a-z]+$/i.test(v)) return true;
  return /^(?:rgba?|hsla?)\([0-9a-z.,%/ +-]*\)$/i.test(v);
}

type Run = { x: number; y: number; w: number; h: number };

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Formats a number: rounded to 3 decimals, no trailing zeros, no exponent, no `-0`. Internal. */
export function num(n: number): string {
  const r = r3(n);
  return r === 0 ? '0' : String(r);
}

function rec(v: object): Record<string, unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- reading unknown fields of a checked object
  return v as Record<string, unknown>;
}

function isCoord(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
}
function isSize(v: unknown): v is number {
  return isCoord(v) && v >= 0;
}

function patternError(message: string, element?: number): Gs1Error {
  return symbolError('pattern', message, element);
}

function invalidOption(option: string, message: string): Gs1Error {
  return new Gs1Error({ code: 'INVALID_VALUE', message, details: { option } });
}

interface ReadPattern {
  width: number;
  height: number;
  rows: PatternRow[];
  hri: HriText[];
  quietZone: QuietZone;
  bearer: Bearer | undefined;
}

function readLinearRows(p: Record<string, unknown>): PatternRow[] {
  const rowsIn = p['rows'];
  if (!Array.isArray(rowsIn) || rowsIn.length > MAX_ITEMS)
    throw patternError('Pattern rows must be an array');
  const rows: PatternRow[] = [];
  let total = 0;
  for (let i = 0; i < rowsIn.length; i++) {
    const row: unknown = rowsIn[i];
    if (typeof row !== 'object' || row === null) throw patternError('Row is not an object', i);
    const r = rec(row);
    const { x, y, height: h, widths } = r;
    if (!isCoord(x) || !isCoord(y) || !isSize(h))
      throw patternError('Row x, y and height must be numbers', i);
    if (!Array.isArray(widths) || widths.length > MAX_ITEMS)
      throw patternError('Row widths must be an array', i);
    const copy: number[] = [];
    for (let k = 0; k < widths.length; k++) {
      const w: unknown = widths[k];
      if (!isSize(w)) throw patternError('Row widths must be finite numbers >= 0', i);
      copy.push(w);
    }
    total += copy.length;
    if (total > MAX_RUNS) throw patternError('Pattern has too many elements');
    rows.push({ role: 'symbol', x, y, height: h, widths: copy });
  }
  return rows;
}

/** One height-1 row of alternating run widths (starting with dark) per matrix row. */
function matrixRows(pattern: unknown): { width: number; height: number; rows: PatternRow[] } {
  const m = readMatrix(pattern);
  if (!m.ok) throw m.errors[0] ?? patternError('Matrix could not be read');
  const { width, height, bits } = m.value;
  const rows: PatternRow[] = [];
  for (let y = 0; y < height; y++) {
    const widths: number[] = [];
    let dark = true;
    let run = 0;
    for (let x = 0; x < width; x++) {
      const bit = bits[y * width + x] === 1;
      if (bit === dark) run++;
      else {
        widths.push(run);
        dark = bit;
        run = 1;
      }
    }
    widths.push(run);
    rows.push({ role: 'symbol', x: 0, y, height: 1, widths });
  }
  return { width, height, rows };
}

function readPattern(pattern: unknown): ReadPattern {
  if (typeof pattern !== 'object' || pattern === null)
    throw patternError('Pattern is not an object');
  const p = rec(pattern);
  const isMatrix = p['kind'] === 'matrix';
  if (p['kind'] !== 'linear' && !isMatrix)
    throw patternError('Pattern is not a linear pattern or module matrix');
  let width: number;
  let height: number;
  let rows: PatternRow[];
  if (isMatrix) {
    ({ width, height, rows } = matrixRows(pattern));
  } else {
    const w = p['width'];
    const h = p['height'];
    if (!isSize(w) || !isSize(h))
      throw patternError('Pattern width and height must be numbers >= 0');
    width = w;
    height = h;
    rows = readLinearRows(p);
  }
  const hriIn = p['hri'] === undefined ? [] : p['hri'];
  if (!Array.isArray(hriIn) || hriIn.length > MAX_ITEMS)
    throw patternError('Pattern hri must be an array');
  const hri: HriText[] = [];
  for (let i = 0; i < hriIn.length; i++) {
    const t: unknown = hriIn[i];
    if (typeof t !== 'object' || t === null) throw patternError('HRI item is not an object', i);
    const o = rec(t);
    const { text, x, y, size, anchor } = o;
    if (typeof text !== 'string' || !isCoord(x) || !isCoord(y) || !isSize(size))
      throw patternError('HRI item needs text, x, y and size', i);
    if (anchor !== 'start' && anchor !== 'middle' && anchor !== 'end')
      throw patternError('HRI anchor must be start, middle or end', i);
    hri.push({
      text,
      x,
      y,
      size,
      anchor,
      role: o['role'] === 'quiet-zone-marker' ? 'quiet-zone-marker' : 'hri',
    });
  }
  const q = p['quietZone'];
  if (typeof q !== 'object' || q === null)
    throw patternError('Pattern quietZone must be an object');
  const qo = rec(q);
  const { left, right, top, bottom } = qo;
  if (!isSize(left) || !isSize(right) || !isSize(top) || !isSize(bottom))
    throw patternError('Quiet zone sides must be numbers >= 0');
  let bearer: Bearer | undefined;
  const b = isMatrix ? undefined : p['bearer'];
  if (b !== undefined) {
    if (typeof b !== 'object' || b === null) throw patternError('Bearer must be an object');
    const bo = rec(b);
    const { sides, width: bw } = bo;
    if ((sides !== 'frame' && sides !== 'top-bottom') || !isSize(bw))
      throw patternError('Bearer needs sides frame or top-bottom and a width >= 0');
    bearer = { sides, width: bw };
  }
  return { width, height, rows, hri, quietZone: { left, right, top, bottom }, bearer };
}

interface ReadOptions {
  moduleSize: number;
  unit: 'px' | 'mm';
  quietZone: QuietZone | undefined;
  hri: boolean;
  foreground: string;
  background: string | null;
  fontFamily: string;
  title: string | undefined;
}

function optString(o: Record<string, unknown>, name: string, fallback: string): string {
  const v = o[name];
  if (v === undefined) return fallback;
  if (typeof v !== 'string') throw invalidOption(name, `Option ${name} must be a string`);
  return v;
}

function badQuietZone(): Gs1Error {
  return invalidOption(
    'quietZone',
    'Option quietZone must be a boolean, a number >= 0 or an object of numbers >= 0',
  );
}

function readQuietZone(v: unknown, base: QuietZone): QuietZone | undefined {
  if (v === undefined || v === true) return undefined;
  if (v === false) return { left: 0, right: 0, top: 0, bottom: 0 };
  if (typeof v === 'number') {
    if (!isSize(v)) throw badQuietZone();
    return { left: v, right: v, top: v, bottom: v };
  }
  if (typeof v !== 'object' || v === null) throw badQuietZone();
  const o = rec(v);
  const out = { ...base };
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const s = o[side];
    if (s === undefined) continue;
    if (!isSize(s)) throw badQuietZone();
    out[side] = s;
  }
  return out;
}

function readOptions(options: unknown, base: QuietZone): ReadOptions {
  if (options !== undefined && (typeof options !== 'object' || options === null))
    throw invalidOption('options', 'Options must be an object');
  const o = rec(options ?? {});
  const ms = o['moduleSize'] === undefined ? 2 : o['moduleSize'];
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0 || ms > MAX_COORD)
    throw invalidOption('moduleSize', 'Option moduleSize must be a finite number > 0');
  const unit = o['unit'] === undefined ? 'px' : o['unit'];
  if (unit !== 'px' && unit !== 'mm')
    throw invalidOption('unit', "Option unit must be 'px' or 'mm'");
  const hri = o['hri'] === undefined ? true : o['hri'];
  if (typeof hri !== 'boolean') throw invalidOption('hri', 'Option hri must be a boolean');
  const bgIn = o['background'];
  if (bgIn !== null && bgIn !== undefined && typeof bgIn !== 'string')
    throw invalidOption('background', 'Option background must be a string or null');
  const title = o['title'];
  if (title !== undefined && typeof title !== 'string')
    throw invalidOption('title', 'Option title must be a string');
  return {
    moduleSize: ms,
    unit,
    quietZone: readQuietZone(o['quietZone'], base),
    hri,
    foreground: optString(o, 'foreground', '#000'),
    background: bgIn === null ? null : (bgIn ?? '#fff'),
    fontFamily: optString(o, 'fontFamily', 'OCR-B,OCRB,monospace'),
    title,
  };
}

function isIllegalXmlChar(c: number): boolean {
  return (c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffe || c === 0xffff;
}

function checkChars(s: string, what: string): void {
  for (let i = 0; i < s.length; i++) {
    if (isIllegalXmlChar(s.charCodeAt(i)))
      throw new Gs1Error({
        code: 'INVALID_CHAR',
        message: `${what} contains a character that is not allowed in XML`,
        position: i,
        length: 1,
        details: { what },
      });
  }
}

function escapeXml(s: string, attribute: boolean): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (attribute && c === '"') out += '&quot;';
    else if (attribute && c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

function compareRuns(a: Run, b: Run): number {
  return a.x - b.x || a.y - b.y || a.w - b.w || a.h - b.h;
}

/** Dark runs of all rows, vertically touching identical runs merged. */
function darkRuns(rows: readonly PatternRow[], left: number, top: number): Run[] {
  const runs: Run[] = [];
  for (const row of rows) {
    if (row.height <= 0) continue;
    let x = row.x;
    for (let i = 0; i < row.widths.length; i++) {
      const w = row.widths[i] ?? 0;
      if (i % 2 === 0 && w > 0)
        runs.push({ x: r3(left + x), y: r3(top + row.y), w: r3(w), h: r3(row.height) });
      x += w;
    }
  }
  // oxlint-disable-next-line no-array-sort -- sorts a fresh local array in place
  runs.sort((a, b) => a.x - b.x || a.w - b.w || a.y - b.y || a.h - b.h);
  const merged: Run[] = [];
  let cur: Run | undefined;
  for (const r of runs) {
    if (cur !== undefined && cur.x === r.x && cur.w === r.w && r3(cur.y + cur.h) === r.y) {
      cur.h = r3(cur.h + r.h);
    } else {
      cur = { ...r };
      merged.push(cur);
    }
  }
  return merged;
}

function bearerRuns(bearer: Bearer, ox: number, oy: number, totalW: number, bodyH: number): Run[] {
  const bw = bearer.width;
  if (bw <= 0) return [];
  const out: Run[] = [
    { x: r3(ox), y: r3(oy), w: totalW, h: bw },
    { x: r3(ox), y: r3(oy + bodyH - bw), w: totalW, h: bw },
  ];
  if (bearer.sides === 'frame') {
    const sideH = r3(bodyH - 2 * bw);
    if (sideH > 0) {
      out.push({ x: r3(ox), y: r3(oy + bw), w: bw, h: sideH });
      out.push({ x: r3(ox + totalW - bw), y: r3(oy + bw), w: bw, h: sideH });
    }
  }
  return out;
}

/** Estimated advance of one text character, in em (plan decision G17). */
const HRI_ADVANCE = 0.6;
/** Estimated cap height and descender, in em. */
const HRI_CAP = 0.8;
const HRI_DESCENT = 0.2;

function checkPaint(v: string, option: string): void {
  if (!isPaint(v)) {
    throw invalidOption(
      option,
      `Option ${option} must be a color: #hex, a color name, rgb(), rgba(), hsl() or hsla()`,
    );
  }
}

function render(pattern: unknown, options: unknown): string {
  const p = readPattern(pattern);
  const o = readOptions(options, p.quietZone);
  const qz = o.quietZone ?? p.quietZone;
  if (o.title !== undefined) checkChars(o.title, 'title');
  checkPaint(o.foreground, 'foreground');
  checkChars(o.fontFamily, 'fontFamily');
  if (o.background !== null) checkPaint(o.background, 'background');
  const hri = o.hri ? p.hri : [];
  for (const t of hri) checkChars(t.text, 'hri');

  const bw = p.bearer?.width ?? 0;
  const bearerSide = p.bearer?.sides === 'frame' ? bw : 0;
  const left = qz.left + bearerSide;
  const top = qz.top + bw;
  const bodyW = r3(p.width + qz.left + qz.right + 2 * bearerSide);
  const bodyH = r3(p.height + qz.top + qz.bottom + 2 * bw);
  // Text at or above the bars' height is in content coordinates; text below the bars hangs off the
  // bottom of the body (below the bottom quiet zone and bearer).
  const placed = hri.map((t) => ({
    t,
    x: left + t.x,
    y: t.y > p.height ? bodyH - p.height + t.y : top + t.y,
  }));
  let growLeft = 0;
  let growRight = 0;
  let growAbove = 0;
  let growBelow = 0;
  for (const { t, x, y } of placed) {
    if (t.text === '') continue;
    const w = HRI_ADVANCE * t.size * t.text.length;
    const x0 = t.anchor === 'start' ? x : t.anchor === 'middle' ? x - w / 2 : x - w;
    growLeft = Math.max(growLeft, -x0);
    growRight = Math.max(growRight, x0 + w - bodyW);
    growAbove = Math.max(growAbove, -(y - HRI_CAP * t.size));
    growBelow = Math.max(growBelow, y + HRI_DESCENT * t.size - bodyH);
  }
  growLeft = r3(growLeft);
  growRight = r3(growRight);
  growAbove = r3(growAbove);
  growBelow = r3(growBelow);
  const totalW = r3(growLeft + bodyW + growRight);
  const totalH = r3(growAbove + bodyH + growBelow);
  const unit = o.unit === 'mm' ? 'mm' : '';
  const wAttr = num(totalW * o.moduleSize);
  const hAttr = num(totalH * o.moduleSize);
  if (!(totalW * o.moduleSize <= MAX_IMAGE) || !(totalH * o.moduleSize <= MAX_IMAGE)) {
    throw invalidOption(
      'moduleSize',
      `The image would be over ${MAX_IMAGE} ${o.unit} wide or high: lower moduleSize or quietZone`,
    );
  }

  const runs = darkRuns(p.rows, left + growLeft, top + growAbove);
  if (p.bearer !== undefined)
    for (const r of bearerRuns(p.bearer, growLeft, growAbove, bodyW, bodyH)) runs.push(r);
  // oxlint-disable-next-line no-array-sort -- sorts a fresh local array in place
  runs.sort(compareRuns);
  let d = '';
  for (const r of runs) {
    const w = num(r.w);
    d += `M${num(r.x)} ${num(r.y)}h${w}v${num(r.h)}h-${w}z`;
  }

  const fg = escapeXml(o.foreground, true);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${wAttr}${unit}" height="${hAttr}${unit}" viewBox="0 0 ${num(totalW)} ${num(totalH)}" shape-rendering="crispEdges">`;
  if (o.title !== undefined) svg += `<title>${escapeXml(o.title, false)}</title>`;
  if (o.background !== null)
    svg += `<rect width="100%" height="100%" fill="${escapeXml(o.background, true)}"/>`;
  svg += `<path fill="${fg}" d="${d}"/>`;
  const font = escapeXml(o.fontFamily, true);
  for (const { t, x, y } of placed) {
    svg += `<text x="${num(growLeft + x)}" y="${num(growAbove + y)}" font-family="${font}" font-size="${num(t.size)}" text-anchor="${t.anchor}" fill="${fg}">${escapeXml(t.text, false)}</text>`;
  }
  return `${svg}</svg>`;
}

/**
 * Renders a linear pattern or a module matrix as a deterministic SVG string (no trailing newline). Throws Gs1Error:
 * INVALID_SYMBOL for a malformed pattern, INVALID_VALUE (`details.option`) for a bad option,
 * INVALID_CHAR for a control character in text.
 */
export function toSvg(pattern: LinearPattern | ModuleMatrix, options?: SvgOptions): string {
  try {
    return render(pattern, options);
  } catch (e) {
    if (e instanceof Gs1Error) throw e;
    throw patternError('Pattern or options could not be read');
  }
}

/** Like `toSvg`, returning a Result instead of throwing. */
export function tryToSvg(
  pattern: LinearPattern | ModuleMatrix,
  options?: SvgOptions,
): Result<string> {
  try {
    return ok(render(pattern, options));
  } catch (e) {
    return fail([e instanceof Gs1Error ? e : patternError('Pattern or options could not be read')]);
  }
}
