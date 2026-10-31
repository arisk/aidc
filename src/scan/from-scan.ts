import { isValidCheckDigit } from '../core/check-digit.ts';
import { Gs1Error, type Result, fail, guard, ok, shiftError, unwrap } from '../core/errors.ts';
import { type ElementString, tryParse, validate } from '../ai/index.ts';
import { type DigitalLinkParseOptions, tryParseDigitalLink } from '../digital-link/index.ts';
import { AIM_IDS, type ScanSymbology } from './aim.ts';

export interface ScanResult {
  readonly symbology: ScanSymbology;
  /** The AIM symbology identifier, for example "]C1". */
  readonly aimId: string;
  readonly elementString: ElementString;
  /** The 2 or 5 digit add-on of an EAN/UPC symbol (]E3); it has no AI. */
  readonly addOn?: string;
  /** The URI, when a QR Code, Data Matrix or DotCode symbol carried a GS1 Digital Link. */
  readonly digitalLink?: string;
}

/** `details.reason` of an INVALID_SCAN error. */
export type ScanErrorReason =
  | 'missing-id'
  | 'unknown-id'
  | 'payload'
  | 'not-gs1'
  | 'not-representable';

export function scanError(
  reason: ScanErrorReason,
  message: string,
  position?: number,
  length?: number,
): Gs1Error {
  return new Gs1Error({
    code: 'INVALID_SCAN',
    message,
    ...(position === undefined ? {} : { position }),
    ...(length === undefined ? {} : { length }),
    details: { reason },
  });
}

const ID_LENGTH = 3;
const SCHEMES = ['https://', 'http://', 'HTTPS://', 'HTTP://'];

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** Keyboard-wedge scanners end each scan with CR, LF or CRLF; strip one (plan decision D10). */
function stripLineEnd(s: string): string {
  if (s.endsWith('\r\n')) return s.slice(0, -2);
  return s.endsWith('\n') || s.endsWith('\r') ? s.slice(0, -1) : s;
}

/** AI data as raw element strings with GS separators; `base` is its index in the scan string. */
function aiData(
  payload: string,
  base: number,
  opts: DigitalLinkParseOptions,
): Result<ElementString> {
  if (payload.length === 0) {
    return fail([
      new Gs1Error({ code: 'EMPTY_INPUT', message: 'The AI data is empty', position: base }),
    ]);
  }
  const caret = payload.indexOf('^');
  if (caret >= 0)
    return fail([
      scanError('payload', 'Scan data contains an illegal "^" character', base + caret, 1),
    ]);
  if (!isDigit(payload.charCodeAt(0))) {
    return fail([
      scanError('payload', 'AI data must start with an AI, not a separator or "("', base, 1),
    ]);
  }
  const r = tryParse(payload, opts);
  return r.ok ? r : fail(r.errors.map((e) => shiftError(e, base)));
}

function checkGtinDigits(digits: string, n: number, base: number): Gs1Error | undefined {
  if (digits.length !== n) return scanError('payload', `Primary data must be ${n} digits`, base);
  for (let i = 0; i < n; i++) {
    if (!isDigit(digits.charCodeAt(i)))
      return scanError('payload', 'Primary data may only contain digits', base + i, 1);
  }
  if (!isValidCheckDigit(digits)) {
    return new Gs1Error({
      code: 'CHECK_DIGIT',
      message: 'The GTIN check digit is incorrect',
      ai: '01',
      position: base + n - 1,
      length: 1,
    });
  }
  return undefined;
}

function gtinData(
  payload: string,
  n: 8 | 13 | 14,
  opts: DigitalLinkParseOptions,
): Result<ElementString> {
  let linear = payload;
  let cc: string | undefined;
  if (n !== 14 && payload.startsWith('|]e0', n)) {
    linear = payload.slice(0, n);
    cc = payload.slice(n + 4);
  }
  const bad = checkGtinDigits(linear, n, ID_LENGTH);
  if (bad) return fail([bad]);
  const gtin: readonly [string, string] = ['01', linear.padStart(14, '0')];
  if (cc === undefined) return validate([gtin], opts);
  // The CC's associations usually need the GTIN (CC-A with (10) alone is not valid), so they
  // are checked once, on the merged data.
  const r = aiData(cc, ID_LENGTH + n + 4, { ...opts, validateAssociations: false });
  return r.ok ? validate([gtin, ...r.value.entries()], opts) : r;
}

/** Parses scanner output that starts with an AIM symbology identifier, collecting every error. */
export function tryFromScan(scan: string, opts: DigitalLinkParseOptions = {}): Result<ScanResult> {
  return guard(() => tryFromScanUnguarded(scan, opts));
}

function tryFromScanUnguarded(
  scan: string,
  opts: DigitalLinkParseOptions = {},
): Result<ScanResult> {
  if (typeof scan !== 'string')
    return fail([new Gs1Error({ code: 'SYNTAX', message: 'Input must be a string' })]);
  const s = stripLineEnd(scan);
  if (s.length < ID_LENGTH || s.charCodeAt(0) !== 0x5d) {
    return fail([
      scanError(
        'missing-id',
        'Scan data must start with an AIM symbology identifier such as ]C1',
        0,
      ),
    ]);
  }
  const aimId = s.slice(0, ID_LENGTH);
  const info = AIM_IDS.get(aimId);
  if (!info)
    return fail([
      scanError('unknown-id', `Unsupported symbology identifier ${aimId}`, 0, ID_LENGTH),
    ]);
  const payload = s.slice(ID_LENGTH);
  const done = (
    symbology: ScanSymbology,
    r: Result<ElementString>,
    extra: { addOn?: string; digitalLink?: string } = {},
  ): Result<ScanResult> =>
    r.ok ? ok({ symbology, aimId, elementString: r.value, ...extra }) : fail(r.errors);

  switch (info.carrier) {
    case 'unsupported':
      return fail([
        new Gs1Error({
          code: 'UNSUPPORTED',
          message: `Symbology identifier ${aimId} is not supported: ${info.why}`,
          position: 0,
          length: ID_LENGTH,
          details: { reason: 'aim-id', aimId },
        }),
      ]);
    case 'ai':
      return done(info.symbology, aiData(payload, ID_LENGTH, opts));
    case 'gtin':
      return done(info.symbology, gtinData(payload, info.digits, opts));
    case 'gtin-add-on': {
      if (payload.length !== 15 && payload.length !== 18) {
        return fail([
          scanError('payload', 'An EAN/UPC symbol with add-on carries 15 or 18 digits', ID_LENGTH),
        ]);
      }
      const addOn = payload.slice(13);
      for (let i = 0; i < addOn.length; i++) {
        if (!isDigit(addOn.charCodeAt(i)))
          return fail([
            scanError('payload', 'The add-on may only contain digits', ID_LENGTH + 13 + i, 1),
          ]);
      }
      return done(info.symbology, gtinData(payload.slice(0, 13), 13, opts), { addOn });
    }
  }
  // Only the digital-link carrier remains.
  if (!SCHEMES.some((p) => payload.startsWith(p))) {
    return fail([scanError('not-gs1', `${aimId} data is not a GS1 Digital Link URI`, ID_LENGTH)]);
  }
  const r = tryParseDigitalLink(payload, opts);
  if (!r.ok) return fail(r.errors.map((e) => shiftError(e, ID_LENGTH)));
  return ok({
    symbology: info.symbology,
    aimId,
    elementString: r.value.elementString,
    digitalLink: payload,
  });
}

/** Like tryFromScan, but throws the first Gs1Error. */
export function fromScan(scan: string, opts: DigitalLinkParseOptions = {}): ScanResult {
  return unwrap(tryFromScan(scan, opts));
}
