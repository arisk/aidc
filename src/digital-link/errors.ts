import { Gs1Error } from '../core/errors.ts';

/** `details.reason` of an INVALID_DIGITAL_LINK error. */
export type DigitalLinkErrorReason =
  | 'uri-chars'
  | 'scheme'
  | 'domain'
  | 'no-primary-key'
  | 'key-qualifier-sequence'
  | 'not-data-attribute'
  | 'should-be-in-path'
  | 'empty-value'
  | 'percent-encoding'
  | 'compressed-segment'
  | 'dot-segment';

export interface ErrorPlace {
  readonly ai?: string;
  readonly position?: number;
  readonly length?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function dlError(
  reason: DigitalLinkErrorReason,
  message: string,
  where: ErrorPlace = {},
): Gs1Error {
  return new Gs1Error({
    code: 'INVALID_DIGITAL_LINK',
    message,
    ...(where.ai === undefined ? {} : { ai: where.ai }),
    ...(where.position === undefined ? {} : { position: where.position }),
    ...(where.length === undefined ? {} : { length: where.length }),
    details: { reason, ...where.details },
  });
}
