import { Gs1Error, type Result, fail, guard, ok, unwrap } from '../core/errors.ts';
import { type AiValue, ElementString, getAi, tryParse } from '../ai/index.ts';
import { type CompressFailure, compressSegment } from './compress/encode.ts';
import { dlError } from './errors.ts';
import { choosePathQualifiers, isPrimaryKey } from './keys.ts';
import { percentEncode } from './percent.ts';
import {
  badAuthority,
  firstBadDomainChar,
  firstNonUriChar,
  isDotSegment,
  schemeLength,
} from './syntax.ts';

export const DEFAULT_DIGITAL_LINK_DOMAIN: string = 'https://id.gs1.org';

export interface DigitalLinkOptions {
  /**
   * Scheme, host and optional path prefix. Default https://id.gs1.org. Trailing "/" are
   * dropped. A path prefix may not end with a GS1 key pair such as "/01/x", which a parser
   * would read as the start of the GS1 path.
   */
  readonly domain?: string;
  /**
   * Order of query attributes: 'canonical' (default) sorts by AI as DL 4.12 requires for a
   * canonical URI; 'engine' matches the Syntax Engine (fixed-length AIs first, input order).
   */
  readonly attributeOrder?: 'canonical' | 'engine';
  /**
   * Compress the AI data (DL Standard 1.1.4 chapter 2): true for full, 'partial' to keep the
   * primary key readable. A partial link of an element string with only the key has nothing
   * to compress, so it is the plain, uncompressed URI.
   */
  readonly compressed?: boolean | 'partial';
  /**
   * Treat AIs unknown to the Syntax Dictionary as data attributes (query parameters), as
   * fromDigitalLink does with the same option; string input is parsed with it too. Default false.
   */
  readonly allowUnknownAIs?: boolean;
}

export interface LinkPlan {
  readonly domain: string;
  readonly key: string;
  readonly keyValue: string;
  readonly qualifiers: readonly AiValue[];
  readonly attributes: readonly AiValue[];
}

/** Whether the path prefix `path` ("a/01/x") ends with a primary key AI and a value segment. */
function endsWithKeyPair(path: string): boolean {
  const segs = path.split('/');
  return segs.length >= 2 && isPrimaryKey(segs[segs.length - 2] ?? '');
}

function normalizeDomain(domain: string): string | Gs1Error {
  let end = domain.length;
  while (end > 0 && domain.charCodeAt(end - 1) === 0x2f) end--;
  const d = domain.slice(0, end);
  const schemeLen = schemeLength(d);
  const slash = d.indexOf('/', schemeLen);
  const host = d.slice(schemeLen, slash < 0 ? d.length : slash);
  const bad =
    schemeLen === 0 ||
    host.length === 0 ||
    firstNonUriChar(d) >= 0 ||
    firstBadDomainChar(host) >= 0 ||
    badAuthority(host) >= 0 ||
    d.includes('?') ||
    d.includes('#') ||
    (slash >= 0 &&
      d
        .slice(slash + 1)
        .split('/')
        .some(isDotSegment));
  if (bad) {
    return dlError(
      'domain',
      `Invalid Digital Link domain: ${domain} (expected for example https://example.com or https://example.com/path)`,
    );
  }
  if (slash >= 0 && endsWithKeyPair(d.slice(slash + 1))) {
    return dlError(
      'domain',
      `Invalid Digital Link domain: ${domain} (the path prefix must not end with a GS1 key pair such as /01/x, which would read as the GS1 path)`,
    );
  }
  return d;
}

/** Splits an element string into key, path qualifiers and query attributes (plan decision D5). */
export function planLink(es: ElementString, opts: DigitalLinkOptions): LinkPlan | Gs1Error {
  const domain = normalizeDomain(opts.domain ?? DEFAULT_DIGITAL_LINK_DOMAIN);
  if (domain instanceof Gs1Error) return domain;
  const entries = es.entries();
  const keyEntry = entries.find(([ai]) => isPrimaryKey(ai));
  if (!keyEntry)
    return dlError('no-primary-key', 'Cannot create a Digital Link URI without a primary key AI');
  const [key, keyValue] = keyEntry;
  const present = new Set(entries.map(([ai]) => ai));
  const qualifierAis = choosePathQualifiers(key, present);
  const emitted = new Set([key, ...qualifierAis]);
  const qualifiers = qualifierAis.map((ai) => [ai, es.get(ai) ?? ''] as const);
  const attributes: AiValue[] = [];
  for (const [ai, value] of entries) {
    // A later identical repeat is dropped, as the Syntax Engine does; conflicting repeats never validate.
    if (emitted.has(ai)) continue;
    emitted.add(ai);
    const info = getAi(ai);
    const attribute = info === undefined ? opts.allowUnknownAIs === true : info.dlAttr;
    if (!attribute) {
      return dlError(
        'not-data-attribute',
        `AI (${ai}) is not a valid Digital Link data attribute`,
        { ai },
      );
    }
    attributes.push([ai, value]);
  }
  const ordered =
    (opts.attributeOrder ?? 'canonical') === 'canonical'
      ? // oxlint-disable-next-line unicorn/no-array-sort
        [...attributes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      : [
          ...attributes.filter(([ai]) => getAi(ai)?.fnc1 === false),
          ...attributes.filter(([ai]) => getAi(ai)?.fnc1 !== false),
        ];
  return { domain, key, keyValue, qualifiers, attributes: ordered };
}

function compressionError(f: CompressFailure): Gs1Error {
  return new Gs1Error({
    code: 'UNSUPPORTED',
    message: `AI (${f.ai}) cannot be compressed: its value does not fit DL 1.1.4 Table F`,
    ai: f.ai,
    details: { reason: 'compression-table', why: f.why },
  });
}

function uncompressed(plan: LinkPlan): string {
  let uri = `${plan.domain}/${plan.key}/${percentEncode(plan.keyValue, false)}`;
  for (const [ai, v] of plan.qualifiers) uri += `/${ai}/${percentEncode(v, false)}`;
  const query = plan.attributes.map(([ai, v]) => `${ai}=${percentEncode(v, true)}`).join('&');
  return query === '' ? uri : `${uri}?${query}`;
}

/** A value written as a path segment that browsers would resolve away ("." or ".."). */
function dotSegmentError(plan: LinkPlan, compressed: boolean | 'partial'): Gs1Error | undefined {
  const key: AiValue = [plan.key, plan.keyValue];
  const inPath =
    compressed === true ? [] : compressed === 'partial' ? [key] : [key, ...plan.qualifiers];
  const dot = inPath.find(([, v]) => isDotSegment(percentEncode(v, false)));
  if (dot === undefined) return undefined;
  return dlError(
    'dot-segment',
    `AI (${dot[0]}) value "${dot[1]}" would be a "." or ".." path segment, which browsers resolve away`,
    { ai: dot[0] },
  );
}

/** Builds a GS1 Digital Link URI from a validated element string (or a string to parse). */
export function tryToDigitalLink(
  input: ElementString | string,
  opts: DigitalLinkOptions = {},
): Result<string> {
  return guard(() => tryToDigitalLinkUnguarded(input, opts));
}

function tryToDigitalLinkUnguarded(
  input: ElementString | string,
  opts: DigitalLinkOptions = {},
): Result<string> {
  let es: ElementString;
  if (input instanceof ElementString) es = input;
  else {
    const r = tryParse(input, { allowUnknownAIs: opts.allowUnknownAIs ?? false });
    if (!r.ok) return fail(r.errors);
    es = r.value;
  }
  const plan = planLink(es, opts);
  if (plan instanceof Gs1Error) return fail([plan]);
  const dot = dotSegmentError(plan, opts.compressed ?? false);
  if (dot) return fail([dot]);
  if (opts.compressed === true || opts.compressed === 'partial') {
    const partial = opts.compressed === 'partial';
    const head = partial
      ? `${plan.domain}/${plan.key}/${percentEncode(plan.keyValue, false)}`
      : plan.domain;
    const packed: AiValue[] = [
      ...(partial ? [] : [[plan.key, plan.keyValue] as const]),
      ...plan.qualifiers,
      ...plan.attributes,
    ];
    if (packed.length === 0) return ok(head); // partial with nothing besides the key
    const seg = compressSegment(packed);
    if (typeof seg !== 'string') return fail([compressionError(seg)]);
    return ok(`${head}/${seg}`);
  }
  return ok(uncompressed(plan));
}

/** Like tryToDigitalLink, but throws the first Gs1Error. */
export function toDigitalLink(
  input: ElementString | string,
  opts: DigitalLinkOptions = {},
): string {
  return unwrap(tryToDigitalLink(input, opts));
}
