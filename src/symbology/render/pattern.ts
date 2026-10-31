import { fail, ok } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import { symbolError } from './errors.ts';
import type { LinearPattern, PatternRow, RowRole } from './types.ts';

const MAX_WIDTHS = 10_000;

/** A copy of `widths` if valid, else the problem as a string. */
function readWidths(widths: unknown): number[] | string {
  if (!Array.isArray(widths)) return 'widths must be an array';
  if (widths.length < 1 || widths.length > MAX_WIDTHS)
    return `widths must have 1 to ${MAX_WIDTHS} entries`;
  const len = widths.length;
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    const w: unknown = widths[i];
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0)
      return 'widths must be finite numbers >= 0';
    out.push(w);
  }
  return out;
}

/** Deep-freezes an encoder result. Internal. */
export function freezePattern(p: LinearPattern): LinearPattern {
  for (const row of p.rows) {
    Object.freeze(row.widths);
    Object.freeze(row);
  }
  Object.freeze(p.rows);
  for (const t of p.hri) Object.freeze(t);
  Object.freeze(p.hri);
  Object.freeze(p.quietZone);
  if (p.bearer !== undefined) Object.freeze(p.bearer);
  return Object.freeze(p);
}

/**
 * A single-row pattern from alternating dark and light module widths (even index dark; a
 * leading 0 starts with a light run). Throws Gs1Error INVALID_SYMBOL (`pattern`) for invalid widths.
 */
export function linearPattern(widths: readonly number[]): LinearPattern {
  let copy: number[] | string;
  try {
    copy = readWidths(widths);
  } catch {
    copy = 'widths could not be read';
  }
  if (typeof copy === 'string') throw symbolError('pattern', copy);
  const row: PatternRow = {
    role: 'symbol',
    x: 0,
    y: 0,
    height: 1,
    widths: copy,
  };
  return freezePattern({
    kind: 'linear',
    symbology: undefined,
    width: copy.reduce((a, b) => a + b, 0),
    height: 1,
    rows: [row],
    hri: [],
    quietZone: { left: 0, right: 0, top: 0, bottom: 0 },
  });
}

/** A row's x offset and widths, as read by a decoder. Internal. */
export interface PlacedRow {
  /** Index in `symbol.rows`. */
  readonly row: number;
  readonly x: number;
  readonly widths: readonly number[];
}

/**
 * Defensive reader shared by decoders: the x offset and widths of the rows whose role is in
 * `roles` (rows without a role count as `symbol`), in the order given. Never throws. Internal.
 */
export function readPlacedRows(
  symbol: unknown,
  roles: readonly RowRole[],
): Result<readonly PlacedRow[]> {
  try {
    if (typeof symbol !== 'object' || symbol === null)
      return fail([symbolError('pattern', 'Symbol is not an object')]);
    const s = symbol as { kind?: unknown; rows?: unknown };
    if (s.kind !== 'linear')
      return fail([symbolError('pattern', 'Symbol is not a linear pattern')]);
    const rows = s.rows;
    if (!Array.isArray(rows)) return fail([symbolError('pattern', 'Symbol has no rows')]);
    const out: PlacedRow[] = [];
    const count = rows.length;
    if (count > MAX_WIDTHS) return fail([symbolError('pattern', 'Symbol has too many rows')]);
    for (let i = 0; i < count; i++) {
      const row: unknown = rows[i];
      if (typeof row !== 'object' || row === null)
        return fail([symbolError('pattern', 'Row is not an object')]);
      const r = row as { role?: unknown; widths?: unknown; x?: unknown };
      const w = readWidths(r.widths);
      if (typeof w === 'string') return fail([symbolError('pattern', w)]);
      const role = r.role === undefined ? 'symbol' : r.role;
      if (!roles.some((x) => x === role)) continue;
      const x = r.x === undefined ? 0 : r.x;
      if (typeof x !== 'number' || !Number.isFinite(x))
        return fail([symbolError('pattern', 'Row x must be a finite number')]);
      out.push({ row: i, x, widths: w });
    }
    return ok(out);
  } catch {
    return fail([symbolError('pattern', 'Symbol could not be read')]);
  }
}

/**
 * Like `readPlacedRows`, widths only. Never throws. Internal.
 */
export function readRows(
  symbol: unknown,
  roles: readonly RowRole[],
): Result<readonly (readonly number[])[]> {
  const r = readPlacedRows(symbol, roles);
  return r.ok ? ok(r.value.map((row) => row.widths)) : fail(r.errors);
}
