import { Gs1Error, fail, ok } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import { ElementString, tryParse } from '../../ai/index.ts';
import type { AiValue } from '../../ai/index.ts';
import { resolveAi } from '../../ai/internal.ts';
import type { HriText, SymbologyName } from '../render/index.ts';

/**
 * Entry code shared by the two-dimensional public objects (decision Q15): option reading, HRI
 * lines, the GS1 input and output rules. Never imports `dl-carrier.ts`, so a GS1-mode object
 * stays free of Digital Link and epc code. Internal.
 */

/** HRI font size in modules when `hriSize` is not given. */
export const DEFAULT_HRI_SIZE = 3;

export function invalidOption(option: string, message: string): Gs1Error {
  return new Gs1Error({ code: 'INVALID_VALUE', message, details: { option } });
}

/** Reads options once each, collecting one INVALID_VALUE (`details.option`) per bad option. */
export interface OptionReader {
  readonly errors: Gs1Error[];
  /** Reads one option; a throwing getter is reported as that option and gives undefined. */
  get(name: string): { readonly value: unknown } | undefined;
}

/** A reader for `options`, or INVALID_VALUE `options` when it is neither undefined nor an object. */
export function optionReader(options: unknown): Result<OptionReader> {
  if (options !== undefined && (typeof options !== 'object' || options === null))
    return fail([invalidOption('options', 'Options must be an object')]);
  const o: object = options ?? {};
  const errors: Gs1Error[] = [];
  return ok({
    errors,
    get: (name: string): { readonly value: unknown } | undefined => {
      try {
        return { value: Reflect.get(o, name) };
      } catch {
        errors.push(invalidOption(name, `Option ${name} could not be read`));
        return undefined;
      }
    },
  });
}

/** A boolean option, false when absent. */
export function readBoolean(r: OptionReader, name: string): boolean {
  const v = r.get(name);
  if (!v || v.value === undefined) return false;
  if (typeof v.value !== 'boolean') {
    r.errors.push(invalidOption(name, `Option ${name} must be a boolean`));
    return false;
  }
  return v.value;
}

/** The `hriSize` option: a finite number above 0 and at most 1000, default 3. */
export function readHriSize(r: OptionReader): number {
  const hs = r.get('hriSize');
  if (!hs || hs.value === undefined) return DEFAULT_HRI_SIZE;
  if (
    typeof hs.value !== 'number' ||
    !Number.isFinite(hs.value) ||
    hs.value <= 0 ||
    hs.value > 1000
  ) {
    r.errors.push(
      invalidOption('hriSize', 'Option hriSize must be a finite number above 0 and at most 1000'),
    );
    return DEFAULT_HRI_SIZE;
  }
  return hs.value;
}

/** HRI lines (decision H17): one per element, left-aligned below the symbol and its quiet zone. */
export function hriLines(entries: readonly AiValue[], height: number, size: number): HriText[] {
  return entries.map(([a, v], k) => ({
    text: `(${a})${v}`,
    x: 0,
    // 0.8 and 1.2 times the size, as fifths to keep the common sizes exact.
    y: height + 1 + (4 * size) / 5 + (6 * size * k) / 5,
    size,
    anchor: 'start',
    role: 'hri',
  }));
}

/** Whether an element is followed by a separator (as `format` decides). */
function separated([a]: AiValue): boolean {
  return resolveAi(a, true)?.fnc1 ?? true;
}

/** The elements in the order `format(es, 'raw', { optimizeOrder })` writes them. */
export function encodedOrder(es: ElementString, optimizeOrder: boolean): readonly AiValue[] {
  const entries = es.entries();
  if (!optimizeOrder) return entries;
  return [...entries.filter((e) => !separated(e)), ...entries.filter(separated)];
}

/** A NOT_REPRESENTABLE error from a shared encoder named `from`, renamed to the calling object. */
export function renamed(
  errors: readonly Gs1Error[],
  from: SymbologyName,
  name: SymbologyName,
): Gs1Error[] {
  return errors.map((e) =>
    e.code === 'NOT_REPRESENTABLE'
      ? new Gs1Error({
          code: e.code,
          message: e.message.replace(from, name),
          details: { ...e.details, symbology: name },
        })
      : e,
  );
}

/** The exported names of a two-dimensional symbology's GS1-mode object and its carrier. */
export interface ObjectNames {
  /** The GS1-mode object, for example `gs1Qr`. */
  readonly gs1: string;
  /** The Digital Link carrier, for example `qr`. */
  readonly dl: string;
}

/** Whether `s` starts with `http://` or `https://`, the scheme in any case. */
export function hasHttpScheme(s: string): boolean {
  const head = s.slice(0, 8).toLowerCase();
  return head.startsWith('http://') || head.startsWith('https://');
}

/**
 * GS1-mode input (decision H8): string data is parsed without the association rules, since one
 * symbol may carry part of a label's data. An ElementString is used as given. A URI is
 * INVALID_VALUE `data` naming the carrier object, since a parse error would not say what to do.
 */
export function gs1ElementString(data: unknown, names: ObjectNames): Result<ElementString> {
  if (data instanceof ElementString) return ok(data);
  if (typeof data === 'string') {
    if (hasHttpScheme(data)) {
      const hint = `Encode GS1 Digital Link URIs with ${names.dl}`;
      return fail([
        new Gs1Error({
          code: 'INVALID_VALUE',
          message: `${names.gs1} takes a GS1 element string such as "(01)09506000134352", not a URI. ${hint}.`,
          details: { option: 'data', hint },
        }),
      ]);
    }
    return tryParse(data, { validateAssociations: false });
  }
  return fail([invalidOption('data', 'Data must be a string or an ElementString')]);
}

/** The error of an encode call that threw (hostile data): INVALID_VALUE `data`. */
export function encodeFailure(): Gs1Error {
  return invalidOption('data', 'Input could not be encoded');
}

/** The error of a decode call that threw: INVALID_SYMBOL `pattern`. */
export function decodeFailure(): Gs1Error {
  return new Gs1Error({
    code: 'INVALID_SYMBOL',
    message: 'Symbol could not be decoded',
    details: { reason: 'pattern' },
  });
}

function payloadError(message: string, position: number): Gs1Error {
  return new Gs1Error({
    code: 'INVALID_SCAN',
    message,
    position,
    length: 1,
    details: { reason: 'payload' },
  });
}

/**
 * GS1 element string from FNC1-first data: the pre-checks of `fromScan` on AI data
 * (EMPTY_INPUT, INVALID_SCAN `payload` for `^` or a first character that is not a digit), then
 * `tryParse` with `validateAssociations: false` (one symbol may carry part of a label's data,
 * decision H8). Positions index `data`.
 */
export function gs1FromData(data: string): Result<ElementString> {
  if (data.length === 0)
    return fail([
      new Gs1Error({ code: 'EMPTY_INPUT', message: 'The AI data is empty', position: 0 }),
    ]);
  const caret = data.indexOf('^');
  if (caret >= 0) return fail([payloadError('Scan data contains an illegal "^" character', caret)]);
  const c = data.charCodeAt(0);
  if (c < 48 || c > 57)
    return fail([payloadError('AI data must start with an AI, not a separator or "("', 0)]);
  return tryParse(data, { validateAssociations: false });
}
