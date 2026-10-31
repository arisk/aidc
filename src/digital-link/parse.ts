import { Gs1Error } from '../core/errors.ts';
import { getAi } from '../ai/index.ts';
import type { ParseOptions } from '../ai/index.ts';
import { type SourceElement, resolveAi } from '../ai/internal.ts';
import { dlError } from './errors.ts';
import { isPrimaryKey, isValidKeyPath, shouldBeInPath } from './keys.ts';
import { percentDecode } from './percent.ts';
import {
  badAuthority,
  firstBadDomainChar,
  firstNonUriChar,
  isDotSegment,
  schemeLength,
} from './syntax.ts';

const SLASH = 0x2f;
const AMP = 0x26;
const SEMI = 0x3b;

export interface ParseLinkOptions extends ParseOptions {
  readonly permitZeroSuppressedGtin?: boolean;
}

export interface Segment {
  readonly text: string;
  /** Index of the segment's first character in the URI. */
  readonly start: number;
}

export interface UriParts {
  /** Path segments after the host. "/01/X" gives ["01", "X"]; a trailing "/" gives a last "". */
  readonly segments: readonly Segment[];
  readonly query: Segment | undefined;
}

/** Checks characters, scheme and host, and splits off the fragment, query and path (dl.c order). */
export function splitUri(uri: string): UriParts | Gs1Error {
  const bad = firstNonUriChar(uri);
  if (bad >= 0) {
    return dlError('uri-chars', 'URI contains illegal characters', { position: bad, length: 1 });
  }
  const schemeLen = schemeLength(uri);
  if (schemeLen === 0) {
    return dlError('scheme', 'Scheme must be http://, https://, HTTP:// or HTTPS://', {
      position: 0,
    });
  }
  const hash = uri.indexOf('#');
  const beforeHash = hash < 0 ? uri : uri.slice(0, hash);
  const q = beforeHash.indexOf('?');
  const pathPart = q < 0 ? beforeHash : beforeHash.slice(0, q);
  const slash = pathPart.indexOf('/', schemeLen);
  if (slash <= schemeLen) {
    return dlError('domain', 'URI must contain a domain and path info', { position: schemeLen });
  }
  const authority = pathPart.slice(schemeLen, slash);
  const badHost = firstBadDomainChar(authority);
  if (badHost >= 0) {
    return dlError('domain', 'Domain contains illegal characters', {
      position: schemeLen + badHost,
      length: 1,
    });
  }
  const badAuth = badAuthority(authority);
  if (badAuth >= 0) {
    return dlError('domain', 'Domain must be a host name or IPv6 address and an optional port', {
      position: schemeLen + badAuth,
    });
  }
  const segments: Segment[] = [];
  let start = slash + 1;
  for (let i = start; i <= pathPart.length; i++) {
    if (i === pathPart.length || pathPart.charCodeAt(i) === SLASH) {
      const text = pathPart.slice(start, i);
      if (isDotSegment(text)) {
        return dlError('dot-segment', 'A "." or ".." path segment is resolved away by browsers', {
          position: start,
          length: text.length,
        });
      }
      segments.push({ text, start });
      start = i + 1;
    }
  }
  return { segments, query: q < 0 ? undefined : { text: beforeHash.slice(q + 1), start: q + 1 } };
}

/**
 * Index in `segments` of the primary key, or -1. Pairs are read from the right and the first
 * primary key found wins, so the rightmost one does; an unknown AI ends the search (dl.c).
 */
export function findPrimaryKey(segments: readonly Segment[]): number {
  for (let i = segments.length - 2; i >= 0; i -= 2) {
    const ai = segments[i]?.text ?? '';
    if (getAi(ai) === undefined) return -1;
    if (isPrimaryKey(ai)) return i;
  }
  return -1;
}

export interface LinkElement extends SourceElement {
  readonly position: number;
  readonly location: 'path' | 'query';
}

function isShortGtin(v: string): boolean {
  if (v.length !== 8 && v.length !== 12 && v.length !== 13) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** Decodes one value segment into an element; pushes an error and returns undefined on failure. */
export function decodeValue(
  ai: string,
  position: number,
  seg: Segment,
  location: 'path' | 'query',
  opts: ParseLinkOptions,
  errors: Gs1Error[],
): LinkElement | undefined {
  if (seg.text === '') {
    errors.push(
      dlError('empty-value', `AI (${ai}) value ${location} element is empty`, {
        ai,
        position: seg.start,
      }),
    );
    return undefined;
  }
  const d = percentDecode(seg.text, location === 'query');
  if ('badPercentAt' in d) {
    errors.push(
      dlError('percent-encoding', `AI (${ai}) value has a "%" that does not start a %XX escape`, {
        ai,
        position: seg.start + d.badPercentAt,
        length: 1,
      }),
    );
    return undefined;
  }
  let { value, shifts } = d;
  let valueStart = seg.start;
  if (
    ai === '01' &&
    (location === 'query' || opts.permitZeroSuppressedGtin === true) &&
    isShortGtin(value)
  ) {
    // Padding zeros sit before the value in no input; shifting valueStart left keeps every
    // real digit at its input index.
    const pad = 14 - value.length;
    valueStart -= pad;
    shifts = shifts.map((s) => s + pad);
    value = value.padStart(14, '0');
  }
  return { ai, value, position, valueStart, shifts, location };
}

function allDigits(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/**
 * Parses the query (DL 4.10): "&" and ";" separate parameters. Empty parameters are skipped.
 * A parameter without "=" or with a key that is not all digits is not GS1 data: it is kept,
 * raw, in `ignored`. An all-digit key must be a known AI (or, with allowUnknownAIs, a
 * plausible one).
 */
export function parseQuery(
  query: Segment | undefined,
  opts: ParseLinkOptions,
  errors: Gs1Error[],
  ignored: string[],
): LinkElement[] {
  const out: LinkElement[] = [];
  if (!query) return out;
  const q = query.text;
  let start = 0;
  for (let i = 0; i <= q.length; i++) {
    if (i < q.length && q.charCodeAt(i) !== AMP && q.charCodeAt(i) !== SEMI) continue;
    const param = q.slice(start, i);
    const at = query.start + start;
    start = i + 1;
    if (param === '') continue;
    const eq = param.indexOf('=');
    const key = eq < 0 ? param : param.slice(0, eq);
    if (eq < 0 || !allDigits(key)) {
      ignored.push(param);
      continue;
    }
    if (key.length < 2 || key.length > 4 || !resolveAi(key, opts.allowUnknownAIs ?? false)) {
      errors.push(
        new Gs1Error({
          code: 'UNKNOWN_AI',
          message: `Unknown AI (${key}) in query parameters`,
          ai: key,
          position: at,
          length: key.length,
          details: { location: 'query' },
        }),
      );
      continue;
    }
    const el = decodeValue(
      key,
      at,
      { text: param.slice(eq + 1), start: at + eq + 1 },
      'query',
      opts,
      errors,
    );
    if (el) out.push(el);
  }
  return out;
}

/**
 * Applies the query rules of dl.c, in its order: a repeated AI (in path or query) is
 * DUPLICATE_AI; an AI without the "?" flag is not a data attribute; and, when `keyPath` is
 * given, a qualifier that fits the path should be in it. `taken` holds the AIs already in the
 * link and grows with each accepted one. Unknown AIs (allowUnknownAIs) count as attributes.
 */
export function screenQuery(
  taken: Set<string>,
  query: readonly LinkElement[],
  keyPath: readonly string[] | undefined,
  errors: Gs1Error[],
): LinkElement[] {
  const accepted: LinkElement[] = [];
  for (const el of query) {
    const where = { ai: el.ai, position: el.position, length: el.ai.length };
    if (taken.has(el.ai)) {
      errors.push(
        new Gs1Error({ code: 'DUPLICATE_AI', message: `AI (${el.ai}) is duplicated`, ...where }),
      );
      continue;
    }
    taken.add(el.ai);
    if (getAi(el.ai)?.dlAttr === false) {
      errors.push(
        dlError(
          'not-data-attribute',
          `AI (${el.ai}) is not a valid Digital Link data attribute`,
          where,
        ),
      );
      continue;
    }
    if (keyPath && shouldBeInPath(keyPath, el.ai)) {
      errors.push(
        dlError('should-be-in-path', `AI (${el.ai}) from the query should be in the path`, where),
      );
      continue;
    }
    accepted.push(el);
  }
  return accepted;
}

export interface UncompressedLink {
  readonly stem: string;
  readonly primaryKey: string;
  readonly elements: readonly LinkElement[];
  readonly ignored: readonly string[];
  readonly errors: readonly Gs1Error[];
}

export type UncompressedOutcome =
  | { readonly kind: 'error'; readonly error: Gs1Error }
  | { readonly kind: 'no-key'; readonly parts: UriParts; readonly error: Gs1Error }
  | { readonly kind: 'link'; readonly link: UncompressedLink };

/** Parses an uncompressed Digital Link into elements to validate; see DL 4 and dl.c. */
export function parseUncompressed(uri: string, opts: ParseLinkOptions): UncompressedOutcome {
  const parts = splitUri(uri);
  if (parts instanceof Gs1Error) return { kind: 'error', error: parts };
  const segs = parts.segments;
  const keyIndex = findPrimaryKey(segs);
  if (keyIndex < 0) {
    const trailingSlash = segs.length > 1 && segs[segs.length - 1]?.text === '';
    return {
      kind: 'no-key',
      parts,
      error: trailingSlash
        ? dlError(
            'no-primary-key',
            'No GS1 Digital Link primary key found in the path: a trailing slash is not allowed (DL 4.12)',
            { details: { trailingSlash: true } },
          )
        : dlError('no-primary-key', 'No GS1 Digital Link primary key found in the path'),
    };
  }
  const pairs: { ai: Segment; value: Segment }[] = [];
  for (let i = keyIndex; i + 1 < segs.length; i += 2) {
    const ai = segs[i];
    const value = segs[i + 1];
    if (ai && value) pairs.push({ ai, value });
  }
  const keyPath = pairs.map((p) => p.ai.text);
  if (!isValidKeyPath(keyPath)) {
    return {
      kind: 'error',
      error: dlError(
        'key-qualifier-sequence',
        'The AIs in the path are not a valid key-qualifier sequence for the key',
        {
          ai: keyPath[0] ?? '',
          position: pairs[1]?.ai.start ?? 0,
          details: { path: keyPath },
        },
      ),
    };
  }
  const errors: Gs1Error[] = [];
  const pathEls: LinkElement[] = [];
  for (const p of pairs) {
    const el = decodeValue(p.ai.text, p.ai.start, p.value, 'path', opts, errors);
    if (el) pathEls.push(el);
  }
  const ignored: string[] = [];
  const query = parseQuery(parts.query, opts, errors, ignored);
  const accepted = screenQuery(new Set(keyPath), query, keyPath, errors);
  const keySeg = segs[keyIndex];
  return {
    kind: 'link',
    link: {
      stem: uri.slice(0, (keySeg?.start ?? 1) - 1),
      primaryKey: keyPath[0] ?? '',
      elements: [...pathEls, ...accepted],
      ignored,
      errors,
    },
  };
}
