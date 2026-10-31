import { Gs1Error, fail, ok } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import { symbolError } from './errors.ts';
import type { ModuleMatrix } from './types.ts';

const MAX_SIDE = 1024;

/** Problems are reported as strings; a valid grid is a list of '0'/'1' strings of equal length. */
function readGrid(rows: unknown, allowArrays: boolean): string[] | string {
  if (!Array.isArray(rows)) return 'rows must be an array';
  const count = rows.length;
  if (count < 1 || count > MAX_SIDE) return `rows must have 1 to ${MAX_SIDE} entries`;
  const out: string[] = [];
  let width = -1;
  for (let y = 0; y < count; y++) {
    const row: unknown = rows[y];
    let text = '';
    if (typeof row === 'string') {
      if (row.length > MAX_SIDE) return `rows must have 1 to ${MAX_SIDE} modules`;
      for (let x = 0; x < row.length; x++) {
        const c = row.charCodeAt(x);
        if (c !== 48 && c !== 49) return 'rows may contain only 0 and 1';
      }
      text = row;
    } else if (allowArrays && Array.isArray(row)) {
      const n = row.length;
      if (n > MAX_SIDE) return `rows must have 1 to ${MAX_SIDE} modules`;
      for (let x = 0; x < n; x++) {
        const v: unknown = row[x];
        if (v === 1 || v === true) text += '1';
        else if (v === 0 || v === false) text += '0';
        else return 'rows may contain only 0, 1, true and false';
      }
    } else {
      return 'every row must be a string of 0 and 1';
    }
    if (text.length < 1) return `rows must have 1 to ${MAX_SIDE} modules`;
    if (width < 0) width = text.length;
    else if (text.length !== width) return 'rows must all have the same length';
    out.push(text);
  }
  return out;
}

/** Deep-freezes an encoder result. Internal. */
export function freezeMatrix(m: ModuleMatrix): ModuleMatrix {
  Object.freeze(m.rows);
  Object.freeze(m.quietZone);
  for (const t of m.hri) Object.freeze(t);
  Object.freeze(m.hri);
  return Object.freeze(m);
}

/**
 * A matrix from rows of '0' (light) and '1' (dark) strings, or arrays of 0, 1 and booleans (1 to
 * 1024 rows of equal length 1 to 1024). Throws Gs1Error INVALID_SYMBOL (`pattern`) otherwise.
 */
export function matrixFromRows(
  rows: readonly (string | readonly (0 | 1 | boolean)[])[],
): ModuleMatrix {
  let grid: string[] | string;
  try {
    grid = readGrid(rows, true);
  } catch {
    grid = 'rows could not be read';
  }
  if (typeof grid === 'string') throw symbolError('pattern', grid);
  return freezeMatrix({
    kind: 'matrix',
    symbology: undefined,
    width: grid[0]?.length ?? 0,
    height: grid.length,
    rows: grid,
    quietZone: { left: 0, right: 0, top: 0, bottom: 0 },
    hri: [],
  });
}

function invalidCoordinate(name: string): Gs1Error {
  return new Gs1Error({
    code: 'INVALID_VALUE',
    message: `Coordinate ${name} is outside the matrix`,
    details: { option: name },
  });
}

/**
 * Whether the module at column `x` and row `y` (row 0 at the top) is dark. Throws Gs1Error:
 * INVALID_VALUE for coordinates outside the matrix, INVALID_SYMBOL for a malformed matrix.
 */
export function moduleAt(m: ModuleMatrix, x: number, y: number): boolean {
  try {
    const rows: unknown = typeof m === 'object' && m !== null ? m.rows : undefined;
    if (!Array.isArray(rows)) throw symbolError('pattern', 'Symbol has no rows');
    if (!Number.isInteger(y) || y < 0 || y >= rows.length) throw invalidCoordinate('y');
    const row: unknown = rows[y];
    if (typeof row !== 'string') throw symbolError('pattern', 'Row is not a string');
    if (!Number.isInteger(x) || x < 0 || x >= row.length) throw invalidCoordinate('x');
    const c = row.charCodeAt(x);
    if (c !== 48 && c !== 49) throw symbolError('pattern', 'Rows may contain only 0 and 1');
    return c === 49;
  } catch (e) {
    if (e instanceof Gs1Error) throw e;
    throw symbolError('pattern', 'Symbol could not be read');
  }
}

/**
 * Defensive reader shared by matrix decoders and `toSvg`: the size and row-major bits (1 = dark)
 * of a ModuleMatrix-like object. Reads `rows` by index, caps the size at 1024 x 1024 and never
 * throws. `width` and `height` of the input are ignored. Internal.
 */
export function readMatrix(
  symbol: unknown,
): Result<{ width: number; height: number; bits: Uint8Array }> {
  try {
    if (typeof symbol !== 'object' || symbol === null)
      return fail([symbolError('pattern', 'Symbol is not an object')]);
    const s = symbol as { kind?: unknown; rows?: unknown };
    if (s.kind !== 'matrix') return fail([symbolError('pattern', 'Symbol is not a matrix')]);
    const grid = readGrid(s.rows, false);
    if (typeof grid === 'string') return fail([symbolError('pattern', grid)]);
    const width = grid[0]?.length ?? 0;
    const height = grid.length;
    const bits = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const row = grid[y] ?? '';
      for (let x = 0; x < width; x++) bits[y * width + x] = row.charCodeAt(x) === 49 ? 1 : 0;
    }
    return ok({ width, height, bits });
  } catch {
    return fail([symbolError('pattern', 'Symbol could not be read')]);
  }
}
