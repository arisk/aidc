import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { GS1encoder } from 'gs1encoder';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, tryParse } from '../../src/ai/index.ts';
import { tryParseDigitalLink, tryToDigitalLink } from '../../src/digital-link/index.ts';
import { type Message, messageArb } from '../support/arbitraries.ts';

const DICT = fileURLToPath(
  new URL('../../docs/specifications/data/gs1-syntax-dictionary-2026-01-27.txt', import.meta.url),
);
const RUNS = Number(process.env['ORACLE_RUNS'] ?? 2000);
const STEM = 'https://example.com';

let engine: GS1encoder;
beforeAll(async () => {
  engine = await GS1encoder.create({ syntaxDictionary: DICT });
});
afterAll(() => engine.free());

type Verdict = { ok: true; value: string } | { ok: false; message: string };

function engineGenerate(bracketed: string): Verdict {
  try {
    engine.aiDataStr = bracketed;
    return { ok: true, value: engine.getDLuri(STEM) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function engineParse(uri: string): Verdict {
  try {
    engine.dataStr = uri;
    return { ok: true, value: engine.aiDataStr ?? '' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

const toBracketed = (m: Message): string =>
  m.map(([a, v]) => `(${a})${v.replaceAll('(', '\\(')}`).join('');

/**
 * Plan decisions where we knowingly differ from dl.c; each predicate selects exactly the
 * inputs a decision affects.
 */
const PARSE_DIFFERENCES: ReadonlyArray<{
  readonly decision: string;
  readonly matches: (uri: string) => boolean;
}> = [
  {
    decision: 'D2(a): ";" delimits query parameters',
    matches: (u) => (u.split('#')[0]?.split('?')[1] ?? '').includes(';'),
  },
  {
    decision: 'D2(b): a malformed "%" is rejected',
    matches: (u) => /%(?![0-9A-Fa-f]{2})/.test(u),
  },
  {
    decision:
      'D1: a URI with no key in the path is tried as a compressed link (the engine has none)',
    matches: (u) => {
      const theirs = engineParse(u);
      const path = u.split('#')[0]?.split('?')[0] ?? '';
      return (
        !theirs.ok &&
        /No GS1 DL keys found/.test(theirs.message) &&
        /^[A-Za-z0-9_-]+$/.test(path.split('/').pop() ?? '')
      );
    },
  },
];

/** Whether the engine parses `uri` to data equivalent to `bracketed`. */
function roundTrips(uri: string, bracketed: string): boolean {
  const back = engineParse(uri);
  return back.ok && parse(back.value).equivalent(parse(bracketed));
}

const D5_MESSAGE = /is not a valid DL URI data attribute/;
/** The engine has no DL form for a message without a primary key; so must we fail. */
const NO_KEY = /without a primary key AI/;

const validMessage = messageArb.filter((m) => tryParse(toBracketed(m)).ok);

describe('toDigitalLink agrees with getDLuri', () => {
  it('on valid messages', () => {
    fc.assert(
      fc.property(validMessage, (m) => {
        const bracketed = toBracketed(m);
        const ours = tryToDigitalLink(parse(bracketed), { domain: STEM, attributeOrder: 'engine' });
        const theirs = engineGenerate(bracketed);
        // Where the engine fails we may only differ by the D5 tie-break: it must report an invalid
        // DL data attribute, and if we succeed our URI must parse in the engine to the same data.
        const [actual, expected] = theirs.ok
          ? [ours.ok ? { ok: true, value: ours.value } : ours, { ok: true, value: theirs.value }]
          : [
              {
                explained: NO_KEY.test(theirs.message) ? !ours.ok : D5_MESSAGE.test(theirs.message),
                roundTrips: !ours.ok || roundTrips(ours.value, bracketed),
              },
              { explained: true, roundTrips: true },
            ];
        expect(actual).toEqual(expected);
      }),
      { numRuns: RUNS },
    );
  });
});

const QUERY_TOKENS = [
  '&',
  ';',
  '=',
  '?',
  '#',
  '/',
  '%2F',
  '%25',
  '%zz',
  '%',
  '+',
  'linkType=all',
  '99=X',
  '10=A',
  '21=B',
  '17=261231',
  '01=9520123456788',
  '',
  '%00',
];

const uriArb = validMessage
  .map((m) => tryToDigitalLink(parse(toBracketed(m)), { domain: STEM, attributeOrder: 'engine' }))
  .filter((r) => r.ok)
  .map((r) => (r.ok ? r.value : ''))
  .chain((uri) =>
    fc.oneof(
      fc.constant(uri),
      fc
        .tuple(fc.nat({ max: uri.length }), fc.constantFrom(...QUERY_TOKENS))
        .map(([i, t]) => uri.slice(0, i) + t + uri.slice(i)),
      fc.nat({ max: uri.length - 1 }).map((i) => uri.slice(0, i) + uri.slice(i + 1)),
    ),
  );

describe('tryParseDigitalLink agrees with the engine parser', () => {
  it('on generated and mutated URIs', () => {
    fc.assert(
      fc.property(uriArb, (uri) => {
        // The engine routes only exact http(s):// prefixes to its DL parser; it reads anything
        // else as plain data, which mutations of the scheme produce.
        fc.pre(/^https?:\/\//.test(uri));
        fc.pre(!PARSE_DIFFERENCES.some((d) => d.matches(uri)));
        const ours = tryParseDigitalLink(uri);
        const theirs = engineParse(uri);
        expect(ours.ok, `${uri}: ${theirs.ok ? theirs.value : theirs.message}`).toBe(theirs.ok);
        // Equal data on success; on failure both sides compare equal trivially.
        const sameData =
          !ours.ok || !theirs.ok || ours.value.elementString.equals(parse(theirs.value));
        expect(sameData).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});
