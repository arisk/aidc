import { Gs1Error } from '../../core/index.ts';

/** `details.reason` of an INVALID_SYMBOL error. */
export type SymbolErrorReason =
  | 'pattern'
  | 'length'
  | 'guard'
  | 'character'
  | 'parity'
  | 'check-character'
  | 'no-start'
  | 'no-stop'
  | 'sequence'
  | 'symbology'
  | 'add-on-only'
  | 'size'
  | 'finder'
  | 'timing'
  | 'codeword'
  | 'format'
  | 'version';

/** An INVALID_SYMBOL error; `element` is the index in the row at fault and `row` the index of that row in `symbol.rows`. Internal. */
export function symbolError(
  reason: SymbolErrorReason,
  message: string,
  element?: number,
  row?: number,
): Gs1Error {
  return new Gs1Error({
    code: 'INVALID_SYMBOL',
    message,
    details:
      element === undefined
        ? { reason }
        : row === undefined
          ? { reason, element }
          : { reason, element, row },
  });
}

/** A NOT_REPRESENTABLE error: the data cannot be carried by `symbology`. Internal. */
export function notRepresentable(symbology: string, why: string): Gs1Error {
  return new Gs1Error({
    code: 'NOT_REPRESENTABLE',
    message: `Not representable in ${symbology}: ${why}`,
    details: { symbology },
  });
}

/** A DATA_TOO_LONG error. Internal. */
export function dataTooLong(limit: number, actual: number): Gs1Error {
  return new Gs1Error({
    code: 'DATA_TOO_LONG',
    message: `Data is ${actual} long, the limit is ${limit}`,
    details: { limit, actual },
  });
}

/** An RS_UNCORRECTABLE error: a Reed-Solomon block has more errors than it can correct. Internal. */
export function rsUncorrectable(details: {
  block: number;
  blocks: number;
  ecCodewords: number;
  capacity: number;
}): Gs1Error {
  return new Gs1Error({
    code: 'RS_UNCORRECTABLE',
    message: `Block ${details.block + 1} of ${details.blocks} has more errors than ${details.capacity} and cannot be corrected`,
    details: { ...details },
  });
}
