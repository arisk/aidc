/**
 * Error codes. An open union: later releases add codes (Digital Link, EPC, symbologies), so
 * switch statements over it should keep a `default` branch.
 */
export type Gs1ErrorCode =
  | 'EMPTY_INPUT'
  | 'SYNTAX'
  | 'UNKNOWN_AI'
  | 'INVALID_LENGTH'
  | 'INVALID_CHAR'
  | 'CHECK_DIGIT'
  | 'INVALID_DATE'
  | 'INVALID_VALUE'
  | 'MISSING_REQUIRED_AI'
  | 'INVALID_AI_PAIR'
  | 'DUPLICATE_AI'
  | 'INVALID_DIGITAL_LINK'
  | 'INVALID_SCAN'
  | 'UNSUPPORTED'
  | 'INVALID_EPC'
  | 'EPC_FIELD_OVERFLOW'
  | 'EPC_UNKNOWN_HEADER'
  | 'GCP_LENGTH_UNKNOWN'
  | 'INVALID_SYMBOL'
  | 'DATA_TOO_LONG'
  | 'NOT_REPRESENTABLE'
  | 'RS_UNCORRECTABLE';

export interface Gs1ErrorInit {
  code: Gs1ErrorCode;
  message: string;
  ai?: string;
  position?: number;
  length?: number;
  details?: Readonly<Record<string, unknown>>;
}

export class Gs1Error extends Error {
  readonly code: Gs1ErrorCode;
  readonly ai: string | undefined;
  /**
   * Index into the string the caller passed: an element string (parse, tryParse,
   * validate(string)), a Digital Link URI or a scan string. For object input (ElementString.from,
   * validate(object or ElementString)): index into the AI value for value errors; association
   * errors (MISSING_REQUIRED_AI, INVALID_AI_PAIR, DUPLICATE_AI, the (8030) serial rule) and
   * UNKNOWN_AI carry no position, as no input string exists. Undefined also for errors not tied
   * to a place in the input.
   */
  readonly position: number | undefined;
  readonly length: number | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(init: Gs1ErrorInit) {
    super(init.message);
    this.name = 'Gs1Error';
    this.code = init.code;
    this.ai = init.ai;
    this.position = init.position;
    this.length = init.length;
    this.details = init.details;
  }
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly Gs1Error[] };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(errors: readonly Gs1Error[]): Result<T> {
  if (errors.length === 0) throw new TypeError('fail() requires at least one error');
  return { ok: false, errors };
}

/**
 * Runs `fn` and returns its Result; anything it throws comes back as a failed Result instead: a
 * Gs1Error as is, and anything else (a throwing getter, Proxy or iterator, an argument of the
 * wrong type, a caller's lookup that throws) as SYNTAX. Every public try* function runs its
 * body through this, so they never throw. Internal.
 */
export function guard<T>(fn: () => Result<T>): Result<T> {
  try {
    return fn();
  } catch (error) {
    let known: Gs1Error | undefined;
    try {
      if (error instanceof Gs1Error) known = error;
    } catch {
      // A thrown Proxy can make instanceof throw too.
    }
    if (known) return fail([known]);
    return fail([
      new Gs1Error({
        code: 'SYNTAX',
        message: 'An argument could not be read: check the types of the input and the options',
        details: { reason: 'argument' },
      }),
    ]);
  }
}

export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  throw r.errors[0];
}

function copy(e: Gs1Error, position: number | undefined, length: number | undefined): Gs1Error {
  return new Gs1Error({
    code: e.code,
    message: e.message,
    ...(e.ai === undefined ? {} : { ai: e.ai }),
    ...(position === undefined ? {} : { position }),
    ...(length === undefined ? {} : { length }),
    ...(e.details === undefined ? {} : { details: e.details }),
  });
}

/** A copy of `e` with its position moved by `by`, for errors found in a substring. Internal. */
export function shiftError(e: Gs1Error, by: number): Gs1Error {
  return copy(e, e.position === undefined ? undefined : e.position + by, e.length);
}

/** A copy of `e` placed at [position, position + length), for errors inside encoded data. Internal. */
export function placeError(e: Gs1Error, position: number, length: number): Gs1Error {
  return copy(e, position, length);
}
