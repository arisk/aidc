import { Gs1Error } from '../core/errors.ts';

/** `details.reason` of an INVALID_EPC error. */
export type EpcErrorReason =
  | 'syntax'
  | 'scheme'
  | 'component'
  | 'escape'
  | 'partition'
  | 'gcp-length'
  | 'not-a-gcp'
  | 'restricted-prefix'
  | 'no-gs1-key'
  | 'no-epc-key'
  | 'binary'
  | 'filter'
  | 'control'
  | 'hostname'
  | 'no-date'
  | 'aidc';

export interface EpcErrorPlace {
  readonly position?: number;
  readonly length?: number;
  readonly ai?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function epcError(
  reason: EpcErrorReason,
  message: string,
  where: EpcErrorPlace = {},
): Gs1Error {
  return new Gs1Error({
    code: 'INVALID_EPC',
    message,
    ...(where.ai === undefined ? {} : { ai: where.ai }),
    ...(where.position === undefined ? {} : { position: where.position }),
    ...(where.length === undefined ? {} : { length: where.length }),
    details: { reason, ...where.details },
  });
}

/** A value the chosen binary scheme cannot hold (plan decision E10). */
export function overflow(field: string, why: string, message: string): Gs1Error {
  return new Gs1Error({ code: 'EPC_FIELD_OVERFLOW', message, details: { field, why } });
}
