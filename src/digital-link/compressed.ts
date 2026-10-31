import { Gs1Error, type Result, fail, placeError } from '../core/errors.ts';
import { base64urlToBits, isBase64url } from '../core/base64url.ts';
import {
  type Tokens,
  checkElement,
  createElementString,
  withAssociations,
} from '../ai/internal.ts';
import type { DigitalLink } from './api.ts';
import { type CompressedCause, decompressSegment } from './compress/decode.ts';
import { epc } from '../epc/index.ts';
import { dlError } from './errors.ts';
import { isPrimaryKey, mayAccompany } from './keys.ts';
import {
  type LinkElement,
  type Segment,
  type ParseLinkOptions,
  type UriParts,
  decodeValue,
  parseQuery,
  screenQuery,
} from './parse.ts';
import { percentEncode } from './percent.ts';

const CAUSE_TEXT: Record<CompressedCause, string> = {
  base64url: 'it may only contain base64url characters',
  truncated: 'it ends inside a field',
  'table-p': 'an AI starts with digits no AI has',
  'ai-digit': 'an AI digit is not a decimal digit',
  'table-f': 'an AI is not in the compression table',
  'reserved-code': 'it uses a reserved code',
  version: 'it declares an unsupported version',
  encoding: 'it uses a reserved value encoding',
  length: 'a length exceeds the maximum for its AI',
  overflow: 'a number has more digits than its length',
  padding: 'its padding bits are not zero',
  'non-gs1-key': 'a non-GS1 key is empty',
};

/**
 * Parses a compressed GS1 Digital Link (DL Standard 1.1.4 chapter 2; DL URI Syntax 6.1.3:
 * tried only after the uncompressed parse found no primary key). Returns undefined when the
 * last path segment is not base64url, so the caller reports the uncompressed error.
 */
export function parseCompressed(
  uri: string,
  parts: UriParts,
  opts: ParseLinkOptions,
): Result<DigitalLink> | undefined {
  const segs = parts.segments;
  const last = segs[segs.length - 1];
  if (!last || !isBase64url(last.text)) return undefined;
  if (last.text.startsWith('eh') || last.text.startsWith('ex')) {
    const r = decodeEpcSegment(last);
    if (!r.ok) return r;
    // An EPC segment carries the whole element string: always full mode.
    return finishCompressed(uri, parts, opts, last, false, r.value, []);
  }
  const d = decompressSegment(last.text);
  if ('cause' in d) {
    return fail([
      dlError(
        'compressed-segment',
        `Compressed Digital Link segment is invalid: ${CAUSE_TEXT[d.cause]}`,
        {
          position: last.start + Math.floor(d.at / 6),
          details: { cause: d.cause },
        },
      ),
    ]);
  }
  const keySeg = segs[segs.length - 3];
  const keyValueSeg = segs[segs.length - 2];
  const partial =
    keySeg !== undefined &&
    keyValueSeg !== undefined &&
    keyValueSeg.text !== '' &&
    isPrimaryKey(keySeg.text);
  return finishCompressed(uri, parts, opts, last, partial, d.ais, d.other);
}

type Pairs = readonly (readonly [string, string])[];

/** Decodes the payload of an "eh"/"ex" segment (DL Compression 1.0.0) through the EPC API. */
function decodeEpcSegment(last: Segment): Result<Pairs> {
  const payload = last.text.slice(2);
  const bad = (cause: string, epcCode: string, message: string): Result<Pairs> =>
    fail([
      dlError(
        'compressed-segment',
        `Compressed Digital Link segment carries an invalid EPC: ${message}`,
        { position: last.start, length: last.text.length, details: { cause, epcCode } },
      ),
    ]);
  let hex: string;
  if (last.text.startsWith('eh')) {
    for (let i = 0; i < payload.length; i++) {
      const c = payload.charCodeAt(i);
      const isHex = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
      if (!isHex) return bad('syntax', 'INVALID_EPC', 'the hex digits are invalid');
    }
    hex = payload;
  } else {
    const bits = base64urlToBits(payload);
    hex = '';
    for (let i = 0; i < bits.length; i += 4) {
      hex += Number.parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16);
    }
  }
  const decoded = epc.tryDecode(hex);
  if (!decoded.ok) return mapEpcFailure(decoded.errors, bad);
  const es = epc.tryToElementString(decoded.value);
  if (!es.ok) return mapEpcFailure(es.errors, bad);
  return { ok: true, value: es.value.entries() };
}

/**
 * The INVALID_DIGITAL_LINK (`compressed-segment`) error for an EPC that fails to decode or
 * has no element string. `details.epcCode` is the EPC error's code; `details.cause` is its
 * `details.reason` when it has one, else its code:
 * - an INVALID_EPC reason (`syntax`, `binary`, `partition`, ...; plan decision E17), with
 *   `no-gs1-key` given as `epc-no-gs1-key` (plan decision E15);
 * - `EPC_UNKNOWN_HEADER`, `EMPTY_INPUT`;
 * - the code or reason of an AI rule the decoded element string breaks.
 * "+" and "++" EPCs decode like any other (decision F9); their element strings follow the
 * Digital Link rules. The only UNSUPPORTED EPC error (`raw-afi`) needs a raw URI, which a hex
 * or base64url segment cannot hold, so none is passed on.
 */
function mapEpcFailure(
  errors: readonly Gs1Error[],
  bad: (cause: string, epcCode: string, message: string) => Result<Pairs>,
): Result<Pairs> {
  const e = errors[0];
  if (!e) return bad('INVALID_EPC', 'INVALID_EPC', 'unknown error');
  const reason = e.details?.['reason'];
  const cause =
    typeof reason !== 'string' ? e.code : reason === 'no-gs1-key' ? 'epc-no-gs1-key' : reason;
  return bad(cause, e.code, e.message);
}

function finishCompressed(
  uri: string,
  parts: UriParts,
  opts: ParseLinkOptions,
  last: Segment,
  partial: boolean,
  ais: Pairs,
  other: Pairs,
): Result<DigitalLink> {
  const segs = parts.segments;
  const keySeg = segs[segs.length - 3];
  const keyValueSeg = segs[segs.length - 2];
  const errors: Gs1Error[] = [];
  const pathEls: LinkElement[] = [];
  if (partial && keySeg && keyValueSeg) {
    const el = decodeValue(keySeg.text, keySeg.start, keyValueSeg, 'path', opts, errors);
    if (el) pathEls.push(el);
  }
  const taken = new Set(pathEls.map((e) => e.ai));
  const packed: LinkElement[] = [];
  for (const [ai, value] of ais) {
    if (taken.has(ai)) {
      errors.push(
        new Gs1Error({
          code: 'DUPLICATE_AI',
          message: `AI (${ai}) is duplicated`,
          ai,
          position: last.start,
          length: last.text.length,
        }),
      );
      continue;
    }
    taken.add(ai);
    packed.push({ ai, value, position: last.start, valueStart: last.start, location: 'path' });
  }
  const ignored: string[] = [];
  const query = screenQuery(
    taken,
    parseQuery(parts.query, opts, errors, ignored),
    undefined,
    errors,
  );
  for (const [k, v] of other) ignored.push(`${k}=${percentEncode(v, true)}`);
  // A partial link's readable key is the primary key. In full compressed data the encoder
  // reorders AIs, so with several key AIs the first one that every other compressed AI may
  // accompany wins; when none fits, errors are reported against the first.
  const candidates = partial
    ? pathEls.slice(0, 1)
    : [...packed, ...query].filter((e) => isPrimaryKey(e.ai));
  const strangers = (key: LinkElement): LinkElement[] =>
    packed.filter((el) => el !== key && !mayAccompany(key.ai, el.ai));
  const primary = candidates.find((k) => strangers(k).length === 0) ?? candidates[0];
  if (!primary) {
    // A partial link without a decoded path key already has the path value's error.
    if (!partial)
      errors.push(
        dlError('no-primary-key', 'No GS1 Digital Link primary key in the compressed data', {
          position: last.start,
        }),
      );
  } else {
    // The key/qualifier structure the uncompressed parse enforces (spec 4.3, 5.3).
    for (const el of strangers(primary)) {
      errors.push(
        dlError(
          'not-data-attribute',
          `AI (${el.ai}) is neither a qualifier of AI (${primary.ai}) nor a valid Digital Link data attribute`,
          { ai: el.ai, position: last.start, length: last.text.length },
        ),
      );
    }
  }

  const tokens: Tokens = { elements: [], errors: [] };
  const allowUnknown = opts.allowUnknownAIs ?? false;
  for (const el of pathEls) checkElement(tokens, el, allowUnknown);
  const before = tokens.errors.length;
  for (const el of packed) checkElement(tokens, el, allowUnknown);
  // Value errors inside the compressed data point at the whole segment.
  for (let i = before; i < tokens.errors.length; i++) {
    const e = tokens.errors[i];
    if (e) tokens.errors[i] = placeError(e, last.start, last.text.length);
  }
  for (const el of query) checkElement(tokens, el, allowUnknown);
  const allErrors = withAssociations(tokens.elements, [...errors, ...tokens.errors], opts);
  if (allErrors.length > 0) return fail(allErrors);
  const stemEnd = (partial && keySeg ? keySeg.start : last.start) - 1;
  return {
    ok: true,
    value: {
      elementString: createElementString(tokens.elements.map((e) => [e.ai, e.value] as const)),
      stem: uri.slice(0, stemEnd),
      primaryKey: primary?.ai ?? '',
      ignoredQueryParams: ignored,
      compressed: partial ? 'partial' : 'full',
    },
  };
}
