/**
 * Helpers shared by the symbologies. Not public API: `index.ts` does not export this file, and
 * only `symbology/linear` and `symbology/matrix` may import it.
 */
export { freezePattern, readPlacedRows, readRows } from './pattern.ts';
export type { PlacedRow } from './pattern.ts';
export { dataTooLong, notRepresentable, rsUncorrectable, symbolError } from './errors.ts';
export { freezeMatrix, readMatrix } from './matrix.ts';

function isPlain(v: object): boolean {
  if (Array.isArray(v)) return true;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function freezeDeep(v: unknown, seen: WeakSet<object>): void {
  if (typeof v !== 'object' || v === null || seen.has(v) || !isPlain(v)) return;
  seen.add(v);
  for (const k of Object.keys(v)) freezeDeep(Reflect.get(v, k), seen);
  Object.freeze(v);
}

/**
 * Deep-freezes the plain objects and arrays reachable from a decode result. Class instances (the
 * ElementString) and typed arrays are left alone. Returns its argument.
 */
export function freezeDecoded<T>(d: T): T {
  freezeDeep(d, new WeakSet());
  return d;
}
