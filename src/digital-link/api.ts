import { Gs1Error, type Result, fail, guard, ok, unwrap } from '../core/errors.ts';
import type { ElementString, ParseOptions } from '../ai/index.ts';
import {
  type Tokens,
  checkElement,
  createElementString,
  withAssociations,
} from '../ai/internal.ts';
import { parseCompressed } from './compressed.ts';
import { type LinkElement, type UncompressedLink, parseUncompressed } from './parse.ts';

export interface DigitalLinkParseOptions extends ParseOptions {
  /**
   * Accept an 8, 12 or 13 digit GTIN as the (01) path value and pad it to 14 digits
   * (dl.c permitZeroSuppressedGTINinDLuris). Default false, as DL URI Syntax 4.1 requires 14
   * digits. A short (01) in the query is always padded, as the Syntax Engine does.
   */
  readonly permitZeroSuppressedGtin?: boolean;
}

export interface DigitalLink {
  readonly elementString: ElementString;
  /** Scheme, host and any custom path prefix before the GS1 path, without a trailing "/". */
  readonly stem: string;
  /** The primary key AI, for example "01". */
  readonly primaryKey: string;
  /** Query parameters that are not GS1 data, raw (still percent-encoded), in URI order. */
  readonly ignoredQueryParams: readonly string[];
  /** Whether the AI data came from a compressed segment (DL 1.1.4 chapter 2). */
  readonly compressed: false | 'partial' | 'full';
}

/** Validates elements (value linters, associations) and builds the result. */
export function finishLink(
  link: UncompressedLink,
  compressed: DigitalLink['compressed'],
  opts: ParseOptions,
  extraErrors: readonly Gs1Error[] = [],
): Result<DigitalLink> {
  const tokens: Tokens = { elements: [], errors: [] };
  for (const el of link.elements) checkElement(tokens, el, opts.allowUnknownAIs ?? false);
  const errors = withAssociations(
    tokens.elements,
    [...link.errors, ...extraErrors, ...tokens.errors],
    opts,
  );
  if (errors.length > 0) return fail(errors);
  return ok({
    elementString: createElementString(tokens.elements.map((e) => [e.ai, e.value] as const)),
    stem: link.stem,
    primaryKey: link.primaryKey,
    ignoredQueryParams: link.ignored,
    compressed,
  });
}

/** Parses a GS1 Digital Link URI (DL URI Syntax 1.7.0), collecting every error. */
export function tryParseDigitalLink(
  uri: string,
  opts: DigitalLinkParseOptions = {},
): Result<DigitalLink> {
  return guard(() => tryParseDigitalLinkUnguarded(uri, opts));
}

function tryParseDigitalLinkUnguarded(
  uri: string,
  opts: DigitalLinkParseOptions = {},
): Result<DigitalLink> {
  if (typeof uri !== 'string') {
    return fail([new Gs1Error({ code: 'SYNTAX', message: 'Input must be a string' })]);
  }
  if (uri.length === 0) {
    return fail([new Gs1Error({ code: 'EMPTY_INPUT', message: 'Input is empty', position: 0 })]);
  }
  const outcome = parseUncompressed(uri, opts);
  if (outcome.kind === 'error') return fail([outcome.error]);
  if (outcome.kind === 'no-key') {
    const c = parseCompressed(uri, outcome.parts, opts);
    if (!c) return fail([outcome.error]);
    // A last segment that is not valid compressed data may be a broken uncompressed link
    // ("/01/X/10"): report both readings.
    const notCompressed =
      !c.ok && c.errors.some((e) => e.details?.['reason'] === 'compressed-segment');
    return notCompressed ? fail([outcome.error, ...c.errors]) : c;
  }
  return finishLink(outcome.link, false, opts);
}

/** Like tryParseDigitalLink, but throws the first Gs1Error. */
export function parseDigitalLink(uri: string, opts: DigitalLinkParseOptions = {}): DigitalLink {
  return unwrap(tryParseDigitalLink(uri, opts));
}

/** The element string of a GS1 Digital Link URI, collecting every error. */
export function tryFromDigitalLink(
  uri: string,
  opts: DigitalLinkParseOptions = {},
): Result<ElementString> {
  return guard(() => tryFromDigitalLinkUnguarded(uri, opts));
}

function tryFromDigitalLinkUnguarded(
  uri: string,
  opts: DigitalLinkParseOptions = {},
): Result<ElementString> {
  const r = tryParseDigitalLink(uri, opts);
  return r.ok ? ok(r.value.elementString) : fail(r.errors);
}

/** The element string of a GS1 Digital Link URI; throws the first Gs1Error. */
export function fromDigitalLink(uri: string, opts: DigitalLinkParseOptions = {}): ElementString {
  return unwrap(tryFromDigitalLink(uri, opts));
}

export type { LinkElement };
