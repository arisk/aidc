import { describe, expect, it } from 'vitest';
import {
  type Result,
  epc,
  identifyKey,
  parse,
  tryFromDigitalLink,
  tryFromScan,
  tryParse,
  tryParseDigitalLink,
  tryToDigitalLink,
  tryToScan,
  validate,
} from '../../src/index.ts';

// Security review: untyped JavaScript callers and untrusted config can pass anything. Every
// public try* function returns a failed Result for it; none throws.

/** `v` as any type, as an untyped caller would pass it. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-parameters -- the point is the wrong type
const as = <T>(v: unknown): T => v as T;

const boom = (): never => {
  throw new Error('boom');
};
const throwingGetter = (key: string): object =>
  Object.defineProperty({}, key, { enumerable: true, get: boom });
const throwingProxy = new Proxy({}, { get: boom, getPrototypeOf: boom, ownKeys: boom });
function* forever(): Generator<readonly [string, string]> {
  for (;;) yield ['01', '09506000134352'];
}
class EvilBytes extends Uint8Array {
  override [Symbol.iterator](): ArrayIterator<number> {
    return boom();
  }
}

const es = parse('(01)09506000134352(21)12345');
const dl = 'https://id.gs1.org/01/09506000134352/21/12345';
const sgtinPlus = 'F7380614141123458046A140';

const cases: readonly (readonly [string, () => Result<unknown>])[] = [
  ['tryParse with null options', () => tryParse('(01)09506000134352', as(null))],
  ['tryParse with throwing options', () => tryParse('(01)09506000134352', as(throwingProxy))],
  ['validate with null options', () => validate({ '01': '09506000134352' }, as(null))],
  ['validate of an object with a throwing getter', () => validate(as(throwingGetter('01')))],
  ['validate of a Proxy', () => validate(as(throwingProxy))],
  [
    'validate of an iterable that throws',
    () =>
      validate(
        as({
          [Symbol.iterator]: boom,
        }),
      ),
  ],
  ['validate of an iterable that never ends', () => validate(forever())],
  ['tryFromScan with null options', () => tryFromScan(']C1010950600013435221123', as(null))],
  ['tryToScan with null options', () => tryToScan(es, 'gs1-128', as(null))],
  ['tryToScan with a Symbol symbology', () => tryToScan(es, as(Symbol('x')))],
  [
    'tryToScan with an add-on of the wrong type',
    () => tryToScan('(01)09506000134352', 'ean-13', as({ addOn: { length: 2 } })),
  ],
  ['tryToDigitalLink with a numeric domain', () => tryToDigitalLink(es, as({ domain: 5 }))],
  ['tryToDigitalLink with null options', () => tryToDigitalLink(es, as(null))],
  ['tryParseDigitalLink with null options', () => tryParseDigitalLink(dl, as(null))],
  ['tryFromDigitalLink with null options', () => tryFromDigitalLink(dl, as(null))],
  [
    'epc.tryFromElementString with a throwing lookup',
    () =>
      epc.tryFromElementString(es, {
        scheme: 'sgtin-96',
        companyPrefixLength: boom,
      }),
  ],
  [
    'epc.tryDecode with a throwing lookup',
    () => epc.tryDecode(sgtinPlus, { companyPrefixLength: boom }),
  ],
  [
    'epc.tryDecode with throwing options',
    () => epc.tryDecode(sgtinPlus, as(throwingGetter('scheme'))),
  ],
  ['epc.tryDecode with Proxy options', () => epc.tryDecode(sgtinPlus, as(throwingProxy))],
  [
    'epc.tryDecode with throwing control options',
    () => epc.tryDecode(sgtinPlus, as({ control: throwingProxy })),
  ],
  ['epc.tryDecode of bytes with a throwing iterator', () => epc.tryDecode(new EvilBytes(12))],
  ['epc.tryToElementString of a Proxy', () => epc.tryToElementString(as(throwingProxy))],
];

describe('try* functions never throw (security review)', () => {
  it.each(cases)('%s gives a failed Result', (_name, call) => {
    let r: Result<unknown> | undefined;
    expect(() => {
      r = call();
    }).not.toThrow();
    expect(r?.ok).toBe(false);
  });

  it('reports an unreadable argument as SYNTAX', () => {
    const r = tryParse('(01)09506000134352', as(throwingProxy));
    expect(r.ok ? undefined : [r.errors[0]?.code, r.errors[0]?.details?.['reason']]).toEqual([
      'SYNTAX',
      'argument',
    ]);
  });

  it('caps object input at 10,000 entries', () => {
    const r = validate(forever());
    expect(r.ok ? undefined : r.errors[0]?.code).toBe('SYNTAX');
  });
});

describe('caller data in errors and other functions (security review)', () => {
  it('does not echo an object key that is not an AI', () => {
    const key = `<img src=x onerror=alert(1)>${'x'.repeat(1e5)}`;
    const r = validate({ [key]: 'x' });
    const e = r.ok ? undefined : r.errors[0];
    expect([e?.code, e?.ai, e?.message]).toEqual([
      'UNKNOWN_AI',
      undefined,
      'Unrecognised AI: a string key that is not 2 to 4 digits',
    ]);
    const shaped = validate({ '0599': 'x' });
    expect(shaped.ok ? undefined : [shaped.errors[0]?.ai, shaped.errors[0]?.message]).toEqual([
      '0599',
      'Unrecognised AI: 0599',
    ]);
  });

  it('identifyKey of a non-string is no candidates', () => {
    expect(identifyKey(as(123))).toEqual([]);
    expect(identifyKey(as(null))).toEqual([]);
  });
});
