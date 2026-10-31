import { Gs1Error, fail, ok } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import { ElementString, tryParse } from '../../ai/index.ts';
import { tryParseDigitalLink, tryToDigitalLink } from '../../digital-link/index.ts';
import type { DigitalLinkOptions } from '../../digital-link/index.ts';
import { hasHttpScheme } from './common.ts';
import type { ObjectNames } from './common.ts';

export type { DigitalLinkOptions } from '../../digital-link/index.ts';

/**
 * The Digital Link carrier (decision H7): the only file of `symbology/matrix` that imports
 * `digital-link`, so the GS1-mode objects never pull it (or the epc code it uses) into a bundle.
 */

/** A Digital Link URI and the element string it carries. */
export interface DlData {
  readonly uri: string;
  readonly elementString: ElementString;
}

function invalidDigitalLink(message: string): Gs1Error {
  return new Gs1Error({ code: 'INVALID_VALUE', message, details: { option: 'digitalLink' } });
}

/**
 * A plain copy of the `digitalLink` option, its fields type-checked and read once (a throwing
 * getter is INVALID_VALUE `digitalLink`, never an escaping exception). Internal.
 */
export function readDigitalLinkOptions(value: unknown): Result<DigitalLinkOptions> {
  if (value === undefined) return ok({});
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return fail([invalidDigitalLink('Option digitalLink must be an object')]);
  try {
    const domain: unknown = Reflect.get(value, 'domain');
    const attributeOrder: unknown = Reflect.get(value, 'attributeOrder');
    const compressed: unknown = Reflect.get(value, 'compressed');
    const allowUnknownAIs: unknown = Reflect.get(value, 'allowUnknownAIs');
    if (domain !== undefined && typeof domain !== 'string')
      return fail([invalidDigitalLink('digitalLink.domain must be a string')]);
    if (
      attributeOrder !== undefined &&
      attributeOrder !== 'canonical' &&
      attributeOrder !== 'engine'
    )
      return fail([
        invalidDigitalLink("digitalLink.attributeOrder must be 'canonical' or 'engine'"),
      ]);
    if (compressed !== undefined && typeof compressed !== 'boolean' && compressed !== 'partial')
      return fail([invalidDigitalLink("digitalLink.compressed must be a boolean or 'partial'")]);
    if (allowUnknownAIs !== undefined && typeof allowUnknownAIs !== 'boolean')
      return fail([invalidDigitalLink('digitalLink.allowUnknownAIs must be a boolean')]);
    return ok({
      ...(domain === undefined ? {} : { domain }),
      ...(attributeOrder === undefined ? {} : { attributeOrder }),
      ...(compressed === undefined ? {} : { compressed }),
      ...(allowUnknownAIs === undefined ? {} : { allowUnknownAIs }),
    });
  } catch {
    return fail([invalidDigitalLink('Option digitalLink could not be read')]);
  }
}

/**
 * Whether a string can start an element string: "(", "^", GS or a digit (as `parse`). Anything
 * else given to the carrier is plain text, which no GS1 symbol carries.
 */
function startsLikeElementString(s: string): boolean {
  const c = s.charCodeAt(0);
  return c === 0x28 || c === 0x5e || c === 0x1d || (c >= 0x30 && c <= 0x39);
}

/**
 * The URI to encode for `data` (decision H7): a string with an http(s) scheme is validated with
 * `tryParseDigitalLink` and kept verbatim; an ElementString, or any other string (parsed with the
 * association rules, since a URI needs a primary key), is built with `tryToDigitalLink`, exactly
 * as `toScan(es, 'datamatrix', { digitalLink })`. Internal.
 */
export function dlEncodeInput(
  data: unknown,
  options: DigitalLinkOptions,
  names: ObjectNames,
): Result<DlData> {
  if (typeof data === 'string' && hasHttpScheme(data)) {
    const r = tryParseDigitalLink(data);
    return r.ok ? ok({ uri: data, elementString: r.value.elementString }) : fail(r.errors);
  }
  let es: ElementString;
  if (data instanceof ElementString) es = data;
  else if (typeof data === 'string') {
    if (data.length > 0 && !startsLikeElementString(data)) {
      const hint = `Pass a GS1 Digital Link URI such as "https://id.gs1.org/01/09506000134352" or a GS1 element string such as "(01)09506000134352"`;
      return fail([
        new Gs1Error({
          code: 'INVALID_VALUE',
          message: `${names.dl} carries a GS1 Digital Link URI or a GS1 element string; plain text is not supported. ${hint}.`,
          details: { option: 'data', hint },
        }),
      ]);
    }
    const r = tryParse(data);
    if (!r.ok) return fail(r.errors);
    es = r.value;
  } else
    return fail([
      new Gs1Error({
        code: 'INVALID_VALUE',
        message: 'Data must be a string or an ElementString',
        details: { option: 'data' },
      }),
    ]);
  const uri = tryToDigitalLink(es, options);
  return uri.ok ? ok({ uri: uri.value, elementString: es }) : fail(uri.errors);
}

/**
 * The Digital Link in `]d1` text, or undefined when the text is not a valid GS1 Digital Link URI.
 * The scheme test is the one `fromScan` applies, so `fromScan(']d1' + text)` agrees. Internal.
 */
export function dlFromText(text: string): DlData | undefined {
  const scheme = ['https://', 'http://', 'HTTPS://', 'HTTP://'].some((p) => text.startsWith(p));
  if (!scheme) return undefined;
  const r = tryParseDigitalLink(text);
  return r.ok ? { uri: text, elementString: r.value.elementString } : undefined;
}
