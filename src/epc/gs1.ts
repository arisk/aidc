import { type AiValue, type ElementString, validate } from '../ai/index.ts';
import { checkDigit } from '../core/check-digit.ts';
import { Gs1Error, type Result, fail } from '../core/errors.ts';
import { escape6, escapeGs3a3, unescape6, unescapeGs3a3 } from './charsets.ts';
import type { PureSchemeName } from './descriptor.ts';
import { epcError } from './errors.ts';
import type { PureId } from './uri.ts';

/**
 * The GS1 Company Prefix length: a number, or a lookup called with the key digits from the
 * GCP position. The GCP length table is not shipped with this package.
 * From either source, 4 or 5 is encoded as 6 (TDS 7.1).
 */
export type GcpLengthSource = number | ((keyDigits: string) => number | undefined);

/** Scheme inference order for element string input (plan decision E20). */
export const EPC_SCHEME_PRIORITY: readonly PureSchemeName[] = [
  'itip',
  'sgtin',
  'upui',
  'lgtin',
  'sscc',
  'sgln',
  'grai',
  'giai',
  'gsrn',
  'gsrnp',
  'gdti',
  'sgcn',
  'cpi',
  'ginc',
  'gsin',
  'pgln',
];

/** How a component is escaped in URI form: GS3A3 (Table A-1) or a 6-bit CPRef (Table G-1). */
type Esc = 'gs3a3' | 'cpref' | undefined;

/** One TDS section 7 mapping (research gcp-uri B.4, legacy 2.1). */
interface Mapping {
  readonly kind: 'id' | 'class';
  /** The key AI. */
  readonly key: string;
  /** A second required AI (the serial), if any. */
  readonly with?: string;
  /** The key value must be longer than this (an AI value without a serial has no EPC). */
  readonly longerThan?: number;
  /** GTIN based: restricted prefixes (E8) and the GTIN-8 rule (TDS 7.3.2) apply. */
  readonly gtin?: true;
  /** The GCP is a prefix of a variable-length value: L must leave a non-empty rest. */
  readonly open?: true;
  /** Escaping per component, one entry per component; `undefined` marks a digit component. */
  readonly esc: readonly Esc[];
  /** The key digits passed to the GCP length lookup, from the GCP position. */
  lookup(v: string): string;
  /** Raw (unescaped) components. */
  toPure(v: string, es: ElementString, L: number): string[];
  /** AI values from raw components. */
  toAis(c: readonly string[]): AiValue[];
}

const cd = checkDigit;
const at = (c: readonly string[], i: number): string => c[i] ?? '';

/** GTIN-14 from the company prefix and the indicator plus item reference. */
function gtinOf(c: readonly string[]): string {
  const ir = at(c, 1);
  const g = ir.slice(0, 1) + at(c, 0) + ir.slice(1);
  return g + cd(g);
}

function gtinMapping(kind: 'id' | 'class', serialAi: string): Mapping {
  return {
    kind,
    key: '01',
    with: serialAi,
    gtin: true,
    esc: [undefined, undefined, 'gs3a3'],
    lookup: (g) => g.slice(1),
    toPure: (g, es, L) => [
      g.slice(1, L + 1),
      g.slice(0, 1) + g.slice(L + 1, 13),
      es.get(serialAi) ?? '',
    ],
    toAis: (c) => [
      ['01', gtinOf(c)],
      [serialAi, at(c, 2)],
    ],
  };
}

/** Schemes whose key is C + reference + check digit, with an optional trailing serial. */
function prefixed(
  key: string,
  refEnd: number,
  serial: Esc | 'digits' | undefined,
  pad = '',
): Mapping {
  const off = pad.length;
  const withSerial = serial !== undefined;
  return {
    kind: 'id',
    key,
    ...(withSerial ? { longerThan: off + refEnd + 1 } : {}),
    esc: withSerial
      ? [undefined, undefined, serial === 'digits' ? undefined : serial]
      : [undefined, undefined],
    lookup: (v) => v.slice(off, off + refEnd + 1),
    toPure: (v, _es, L) => {
      const c = [v.slice(off, off + L), v.slice(off + L, off + refEnd)];
      return withSerial ? [...c, v.slice(off + refEnd + 1)] : c;
    },
    toAis: (c) => {
      const body = at(c, 0) + at(c, 1);
      return [[key, pad + body + cd(body) + (withSerial ? at(c, 2) : '')]];
    },
  };
}

/** Schemes whose key is C followed by free text, without a check digit. */
function open(key: string, esc: Esc): Mapping {
  return {
    kind: 'id',
    key,
    open: true,
    esc: [undefined, esc],
    lookup: (v) => v,
    toPure: (v, _es, L) => [v.slice(0, L), v.slice(L)],
    toAis: (c) => [[key, at(c, 0) + at(c, 1)]],
  };
}

const MAPPINGS: Readonly<Partial<Record<PureSchemeName, Mapping>>> = {
  sgtin: gtinMapping('id', '21'),
  upui: gtinMapping('id', '235'),
  lgtin: gtinMapping('class', '10'),
  itip: {
    kind: 'id',
    key: '8006',
    with: '21',
    gtin: true,
    esc: [undefined, undefined, undefined, undefined, 'gs3a3'],
    lookup: (v) => v.slice(1, 14),
    toPure: (v, es, L) => [
      v.slice(1, L + 1),
      v.slice(0, 1) + v.slice(L + 1, 13),
      v.slice(14, 16),
      v.slice(16, 18),
      es.get('21') ?? '',
    ],
    toAis: (c) => [
      ['8006', gtinOf(c) + at(c, 2) + at(c, 3)],
      ['21', at(c, 4)],
    ],
  },
  sscc: {
    kind: 'id',
    key: '00',
    esc: [undefined, undefined],
    lookup: (s) => s.slice(1),
    toPure: (s, _es, L) => [s.slice(1, L + 1), s.slice(0, 1) + s.slice(L + 1, 17)],
    toAis: (c) => {
      const sr = at(c, 1);
      const s = sr.slice(0, 1) + at(c, 0) + sr.slice(1);
      return [['00', s + cd(s)]];
    },
  },
  sgln: {
    kind: 'id',
    key: '414',
    esc: [undefined, undefined, 'gs3a3'],
    lookup: (v) => v,
    toPure: (v, es, L) => [v.slice(0, L), v.slice(L, 12), es.get('254') ?? '0'],
    toAis: (c) => {
      const body = at(c, 0) + at(c, 1);
      const out: AiValue[] = [['414', body + cd(body)]];
      // Extension 0 means no (254) (TDS 7.5, plan decision E11).
      if (at(c, 2) !== '0') out.push(['254', at(c, 2)]);
      return out;
    },
  },
  grai: prefixed('8003', 12, 'gs3a3', '0'),
  giai: open('8004', 'gs3a3'),
  gsrn: prefixed('8018', 17, undefined),
  gsrnp: prefixed('8017', 17, undefined),
  gdti: prefixed('253', 12, 'gs3a3'),
  sgcn: prefixed('255', 12, 'digits'),
  cpi: {
    kind: 'id',
    key: '8010',
    with: '8011',
    open: true,
    esc: [undefined, 'cpref', undefined],
    lookup: (v) => v,
    toPure: (v, es, L) => [v.slice(0, L), v.slice(L), es.get('8011') ?? ''],
    toAis: (c) => [
      ['8010', at(c, 0) + at(c, 1)],
      ['8011', at(c, 2)],
    ],
  },
  ginc: open('401', 'gs3a3'),
  gsin: prefixed('402', 16, undefined),
  pgln: prefixed('417', 12, undefined),
};

function applies(m: Mapping, es: ElementString): boolean {
  const v = es.get(m.key);
  if (v === undefined) return false;
  if (m.with !== undefined && !es.has(m.with)) return false;
  return m.longerThan === undefined || v.length > m.longerThan;
}

function allDigits(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** True when the GTIN-14 `g` may not be encoded as an EPC (TDS 7.3.3 to 7.3.8, E8). */
function restricted(g: string): boolean {
  if (g.startsWith('000000')) return g[6] === '0' || g[6] === '2';
  const b = g.slice(1);
  if (b.startsWith('02') || b.startsWith('2') || b.startsWith('04')) return true;
  if (b.startsWith('000') && b[3] !== undefined && b[3] >= '1' && b[3] <= '7') return true;
  if (b.startsWith('977') || b.startsWith('99')) return true;
  return b.startsWith('98') && b[2] !== undefined && b[2] >= '0' && b[2] <= '4';
}

/** Resolves the GCP length (plan decisions E1, E9). */
function gcpLength(m: Mapping, v: string, source: GcpLengthSource | undefined): number | Gs1Error {
  // GTIN-8: the company prefix is 00000N1N2N3 (TDS 7.3.2).
  if (m.gtin && v.startsWith('000000')) return 8;
  const digits = m.lookup(v);
  const unknown = (): Gs1Error =>
    new Gs1Error({
      code: 'GCP_LENGTH_UNKNOWN',
      message: `The GS1 Company Prefix length of (${m.key}) ${v} is not known; pass companyPrefixLength`,
      ai: m.key,
    });
  let L: unknown;
  if (typeof source === 'number') L = source;
  else if (source === undefined) return unknown();
  else if (typeof source !== 'function') {
    return epcError('gcp-length', 'companyPrefixLength must be a number or a function', {
      ai: m.key,
    });
  } else {
    L = source(digits);
    if (L === undefined) return unknown();
    if (L === 0) {
      return epcError('not-a-gcp', `(${m.key}) ${v} does not start with a GS1 Company Prefix`, {
        ai: m.key,
      });
    }
  }
  // 4 and 5 digit GCPs are encoded as 6 (TDS 7.1).
  if (L === 4 || L === 5) L = 6;
  if (typeof L !== 'number') {
    return epcError('gcp-length', 'A GS1 Company Prefix length must be a number', {
      ai: m.key,
    });
  }
  const fits =
    Number.isInteger(L) &&
    L >= 6 &&
    L <= 12 &&
    (!m.open || (L < v.length && allDigits(v.slice(0, L))));
  return fits
    ? L
    : epcError('gcp-length', `A GS1 Company Prefix length of ${L} does not fit (${m.key}) ${v}`, {
        ai: m.key,
        details: { length: L },
      });
}

/**
 * The GS1 Company Prefix in the key AI of `scheme` among `ais` (a plus EPC's body), from a
 * length or lookup. Undefined when the lookup does not know the length or there is no key;
 * a length that does not fit is INVALID_EPC (gcp-length), as on encode.
 */
export function companyPrefixOf(
  scheme: PureSchemeName,
  ais: readonly AiValue[],
  source: GcpLengthSource,
): string | undefined | Gs1Error {
  const m = MAPPINGS[scheme];
  const v = m === undefined ? undefined : ais.find(([ai]) => ai === m.key)?.[1];
  if (m === undefined || v === undefined) return undefined;
  const L = gcpLength(m, v, source);
  if (L instanceof Gs1Error) return L.code === 'GCP_LENGTH_UNKNOWN' ? undefined : L;
  // lookup(v) starts at the GCP; for GTIN-8, L is 8 and gives 00000N1N2N3 (TDS 7.3.2).
  return m.lookup(v).slice(0, L);
}

/**
 * The EPC pure identity of an element string (TDS section 7). Only the identifying AIs of
 * the scheme are used (plan decision E20).
 */
export function pureFromElementString(
  es: ElementString,
  opts: { epcScheme?: PureSchemeName; companyPrefixLength?: GcpLengthSource },
): PureId | Gs1Error {
  let scheme: PureSchemeName | undefined;
  if (opts.epcScheme === undefined) {
    scheme = EPC_SCHEME_PRIORITY.find((s) => {
      const m = MAPPINGS[s];
      return m !== undefined && applies(m, es);
    });
  } else {
    const m = MAPPINGS[opts.epcScheme];
    if (m !== undefined && applies(m, es)) scheme = opts.epcScheme;
  }
  const m = scheme === undefined ? undefined : MAPPINGS[scheme];
  const v = m === undefined ? undefined : es.get(m.key);
  if (scheme === undefined || m === undefined || v === undefined) {
    const which = opts.epcScheme === undefined ? 'any EPC scheme' : opts.epcScheme;
    return epcError('no-epc-key', `The element string holds no key for ${which}`);
  }
  if (m.gtin && restricted(v.slice(0, 14))) {
    return epcError(
      'restricted-prefix',
      `(${m.key}) ${v} has a GS1 prefix that SHALL NOT be encoded as an EPC (TDS 7.3)`,
      { ai: m.key },
    );
  }
  const L = gcpLength(m, v, opts.companyPrefixLength);
  if (L instanceof Gs1Error) return L;
  const components = m.toPure(v, es, L).map((c, i) => {
    const e = m.esc[i];
    return e === 'gs3a3' ? escapeGs3a3(c) : e === 'cpref' ? escape6(c) : c;
  });
  return { kind: m.kind, scheme, components };
}

/**
 * The AIs of an EPC pure identity (TDS section 7), not validated: a valid EPC can hold a value
 * GS1 rules reject (a CPI serial of 0). EPC-level problems (a scheme without a GS1 key, a
 * malformed component of a hand-built PureId) are INVALID_EPC.
 */
export function aisFromPure(p: PureId): AiValue[] | Gs1Error {
  const m = MAPPINGS[p.scheme];
  if (m === undefined || m.kind !== p.kind)
    return epcError('no-gs1-key', `urn:epc:${p.kind}:${p.scheme} has no GS1 element string`);
  if (p.components.length !== m.esc.length) {
    return epcError('component', `${p.scheme} takes ${m.esc.length} components`, {
      details: { count: p.components.length },
    });
  }
  const raw: string[] = [];
  for (let i = 0; i < p.components.length; i++) {
    const c = at(p.components, i);
    const e = m.esc[i];
    // Digit components feed the check digit; the company prefix is never empty.
    if (e === undefined && (!allDigits(c) || (i === 0 && c.length === 0))) {
      return epcError('component', `Component ${i} of a ${p.scheme} pure identity must be digits`, {
        details: { component: i },
      });
    }
    const u = e === 'gs3a3' ? unescapeGs3a3(c) : e === 'cpref' ? unescape6(c, 'any') : { value: c };
    if ('badAt' in u) {
      return epcError('escape', 'A component of the pure identity has an invalid escape', {
        details: { component: i, at: u.badAt },
      });
    }
    raw.push(u.value);
  }
  return m.toAis(raw);
}

/**
 * The element string of an EPC pure identity (TDS section 7). AI value rules apply through
 * `validate`; EPC-level problems fail as in `aisFromPure`. Never throws.
 */
export function elementStringFromPure(p: PureId): Result<ElementString> {
  const ais = aisFromPure(p);
  return ais instanceof Gs1Error ? fail([ais]) : validate(ais);
}
