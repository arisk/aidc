import { describe, expect, it } from 'vitest';
import file from '../vectors/epc-plus.json' with { type: 'json' };
import type { AiValue } from '../../src/ai/index.ts';
import { Gs1Error } from '../../src/core/errors.ts';
import {
  decodePlus,
  encodePlus,
  PLUS_SCHEMES,
  plusSchemeByHeader,
  plusSchemeByName,
  type PlusContent,
  type PlusScheme,
} from '../../src/epc/plus.ts';

interface BinaryVector {
  readonly scheme: string;
  readonly source: string;
  readonly elementString: string;
  readonly filter: number;
  readonly toggle: number;
  readonly hostname?: string;
  readonly prioritisedDate?: { readonly ai: string; readonly value: string };
  readonly aidc?: readonly { readonly ai: string; readonly value: string }[];
  readonly epcBits: number;
  readonly totalBits?: number;
  readonly bits?: string;
  readonly hex: string;
  readonly derived?: boolean;
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON vector file shape
const binaries = (file.vectors as unknown as { binaries: BinaryVector[] }).binaries;

const hexBits = (hex: string): string => {
  let out = '';
  for (const h of hex) out += Number.parseInt(h, 16).toString(2).padStart(4, '0');
  return out;
};
const padWord = (bits: string): string => bits.padEnd(Math.ceil(bits.length / 16) * 16, '0');

/** Splits a bracketed element string; the vector values hold no '('. */
const entries = (es: string): AiValue[] =>
  es
    .split('(')
    .slice(1)
    .map((part) => {
      const close = part.indexOf(')');
      return [part.slice(0, close), part.slice(close + 1)] as const;
    });

const schemeOf = (name: string): PlusScheme => {
  const s = plusSchemeByName(name);
  if (s === undefined) throw new Error(`no plus scheme ${name}`);
  return s;
};

const contentOf = (v: BinaryVector): PlusContent => {
  const scheme = schemeOf(v.scheme.toLowerCase());
  const all = entries(v.elementString);
  const body = all.filter(([ai]) => scheme.ais.includes(ai));
  const aidc = (v.aidc ?? []).map((a) => [a.ai, a.value] as const);
  return {
    filter: v.filter,
    body,
    ...(v.prioritisedDate === undefined
      ? {}
      : { date: [v.prioritisedDate.ai, v.prioritisedDate.value] as const }),
    ...(v.hostname === undefined ? {} : { hostname: v.hostname }),
    aidc,
  };
};

const expectedBits = (v: BinaryVector): string =>
  v.bits ?? hexBits(v.hex).slice(0, v.totalBits ?? v.epcBits);

const label = (v: BinaryVector): string =>
  `${v.scheme} ${v.elementString}${v.hostname === undefined ? '' : ` @${v.hostname}`} f${v.filter}${v.derived === true ? ' (derived)' : ''}`;

const reasonOf = (v: unknown): unknown =>
  v instanceof Gs1Error ? [v.code, v.details?.['reason']] : v;
const bitOf = (v: unknown): unknown =>
  v instanceof Gs1Error ? [v.details?.['reason'], v.details?.['bit']] : v;
const whyOf = (v: unknown): unknown => (v instanceof Gs1Error ? [v.code, v.details?.['why']] : v);

const contentFields = (d: unknown): unknown => {
  if (d instanceof Gs1Error) return d;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decodePlus result when not an error
  const p = d as PlusContent;
  return {
    filter: p.filter,
    body: p.body,
    date: p.date,
    hostname: p.hostname,
    aidc: p.aidc,
  };
};

const sgtinPlus = schemeOf('sgtin+');
const dsgtinPlus = schemeOf('dsgtin+');
const sgtinBody: AiValue[] = [
  ['01', '79521141123453'],
  ['21', '32a/b'],
];
const sgtin = (extra: Partial<PlusContent> = {}): PlusContent => ({
  filter: 3,
  body: sgtinBody,
  aidc: [],
  ...extra,
});
const enc = (s: PlusScheme, c: PlusContent): string => {
  const r = encodePlus(s, c);
  if (typeof r !== 'string') throw r;
  return r;
};

describe('plus scheme descriptors', () => {
  it('has 24 schemes with unique names and headers', () => {
    expect(PLUS_SCHEMES).toHaveLength(24);
    expect(new Set(PLUS_SCHEMES.map((s) => s.name)).size).toBe(24);
    expect(new Set(PLUS_SCHEMES.map((s) => s.header)).size).toBe(24);
  });
  it('uses the corrected ++ headers (research 3 rows 1 and 2)', () => {
    expect(plusSchemeByHeader(0xef)?.name).toBe('sscc++');
    expect(plusSchemeByHeader(0xed)?.name).toBe('itip++');
    expect(plusSchemeByHeader(0xf9)?.name).toBe('sscc+');
    expect(plusSchemeByHeader(0xf3)?.name).toBe('itip+');
  });
  it('looks up by name and rejects unknown names and headers', () => {
    expect(plusSchemeByName('dsgtin++')?.header).toBe(0xfc);
    expect(plusSchemeByName('sgtin-96')).toBeUndefined();
    expect(plusSchemeByHeader(0x30)).toBeUndefined();
  });
  it('marks the date and hostname schemes', () => {
    expect(PLUS_SCHEMES.filter((s) => s.date).map((s) => s.name)).toEqual(['dsgtin+', 'dsgtin++']);
    expect(PLUS_SCHEMES.filter((s) => s.hostname)).toHaveLength(12);
    expect(PLUS_SCHEMES.every((s) => s.hostname === s.name.endsWith('++'))).toBe(true);
  });
});

describe('plus binary vectors (research plus 4.1)', () => {
  it('has 31 vectors', () => {
    expect(binaries).toHaveLength(31);
  });
  it.each(binaries.map((v) => [label(v), v] as const))('encodes %s', (_, v) => {
    expect(encodePlus(schemeOf(v.scheme.toLowerCase()), contentOf(v))).toBe(expectedBits(v));
  });
  it.each(binaries.map((v) => [label(v), v] as const))('decodes %s', (_, v) => {
    const c = contentOf(v);
    expect(contentFields(decodePlus(padWord(expectedBits(v))))).toEqual({
      filter: c.filter,
      body: c.body,
      date: c.date,
      hostname: c.hostname,
      aidc: c.aidc,
    });
  });
  it.each(binaries.map((v) => [label(v), v] as const))(
    'decodes the scheme and bit length of %s',
    (_, v) => {
      const d = decodePlus(padWord(expectedBits(v)));
      expect(d instanceof Gs1Error ? d : [d.scheme.name, d.bitLength]).toEqual([
        v.scheme.toLowerCase(),
        expectedBits(v).length,
      ]);
    },
  );
});

describe('DSGTIN prioritised date (14.5.3)', () => {
  it('encodes (17)220531 as the Fig 14-2 bits', () => {
    const bits = enc(dsgtinPlus, sgtin({ date: ['17', '220531'] }));
    expect(bits.slice(12, 32)).toBe('01000010110010111111');
  });
  it.each([
    ['11', '0000'],
    ['13', '0001'],
    ['15', '0010'],
    ['16', '0011'],
    ['17', '0100'],
    ['7006', '0101'],
    ['7007', '0110'],
  ] as const)('writes indicator %s as %s and decodes it back', (ai, ind) => {
    const bits = enc(dsgtinPlus, sgtin({ date: [ai, '240229'] }));
    const d = decodePlus(bits);
    expect([bits.slice(12, 16), d instanceof Gs1Error ? d : d.date]).toEqual([ind, [ai, '240229']]);
  });
  it('rejects indicator 0111 on decode', () => {
    const bits = enc(dsgtinPlus, sgtin({ date: ['17', '220531'] }));
    expect(bitOf(decodePlus(`${bits.slice(0, 12)}0111${bits.slice(16)}`))).toEqual(['binary', 12]);
  });
  it('requires a date for DSGTIN', () => {
    expect(reasonOf(encodePlus(dsgtinPlus, sgtin()))).toEqual(['INVALID_EPC', 'no-date']);
  });
  it('rejects a date on a scheme without one', () => {
    expect(reasonOf(encodePlus(sgtinPlus, sgtin({ date: ['17', '220531'] })))).toEqual([
      'INVALID_EPC',
      'component',
    ]);
  });
  it('rejects a date AI without an indicator', () => {
    expect(reasonOf(encodePlus(dsgtinPlus, sgtin({ date: ['12', '220531'] })))).toEqual([
      'INVALID_EPC',
      'component',
    ]);
  });
  it('rejects a (7007) date range as the prioritised date', () => {
    expect(reasonOf(encodePlus(dsgtinPlus, sgtin({ date: ['7007', '220501220531'] })))).toEqual([
      'INVALID_EPC',
      'component',
    ]);
  });
  it('rejects a month outside 01 to 12 (days in a month are left to AI validation, F12)', () => {
    expect(reasonOf(encodePlus(dsgtinPlus, sgtin({ date: ['17', '221301'] })))).toEqual([
      'INVALID_EPC',
      'component',
    ]);
  });
});

describe('plus trailing bits (F10)', () => {
  const plain = enc(sgtinPlus, sgtin());
  const toggled = `${plain.slice(0, 8)}1${plain.slice(9)}`;

  it('rejects a 1 in the padding after a toggle-0 EPC', () => {
    const bits = `${plain}${'0'.repeat(9)}1${'0'.repeat(7)}`;
    expect(bitOf(decodePlus(bits))).toEqual(['binary', 120]);
  });
  it('rejects toggle 1 with only zero fill', () => {
    expect(bitOf(decodePlus(padWord(toggled)))).toEqual(['binary', plain.length]);
  });
  it('rejects toggle 1 with a long zero fill and no +AIDC data', () => {
    expect(bitOf(decodePlus(`${toggled}${'0'.repeat(200)}`))).toEqual(['binary', plain.length]);
  });
  it('rejects toggle 1 with an A to F header nibble', () => {
    expect(bitOf(decodePlus(padWord(`${toggled}10100001`)))).toEqual(['binary', plain.length]);
  });
  it('rejects toggle 1 with an unknown AI prefix', () => {
    expect(bitOf(decodePlus(padWord(`${toggled}00010100${'0'.repeat(80)}`)))).toEqual([
      'binary',
      plain.length,
    ]);
  });
  it('rejects non-zero bits left after the +AIDC loop', () => {
    const aidc = enc(sgtinPlus, sgtin({ aidc: [['17', '220531']] }));
    const bits = `${aidc}0000001`;
    expect(bitOf(decodePlus(bits))).toEqual(['binary', bits.length - 1]);
  });
  it('rejects an +AIDC entry repeating a body AI', () => {
    // The body's own (01) bits: 14 BCD digits right after the 12-bit header, toggle and filter.
    const fln = plain.slice(12, 68);
    expect(reasonOf(decodePlus(padWord(`${toggled}00000001${fln}`)))).toEqual([
      'INVALID_EPC',
      'aidc',
    ]);
  });
  it('rejects an +AIDC entry repeating the prioritised date AI', () => {
    const bits = enc(dsgtinPlus, sgtin({ date: ['17', '220531'], aidc: [['10', 'A']] }));
    const date = enc(sgtinPlus, sgtin({ aidc: [['17', '220531']] })).slice(plain.length);
    expect(reasonOf(decodePlus(padWord(bits + date)))).toEqual(['INVALID_EPC', 'aidc']);
  });
  it('decodes AI (00) in +AIDC when 72 bits follow the zero byte', () => {
    const bits = enc(sgtinPlus, sgtin({ aidc: [['00', '095201234567891235']] }));
    const d = decodePlus(padWord(bits));
    expect(d instanceof Gs1Error ? d : d.aidc).toEqual([['00', '095201234567891235']]);
  });
  it('decodes 3- and 4-digit +AIDC keys', () => {
    const aidc: AiValue[] = [
      ['8020', 'ABC123'],
      ['412', '9521141123454'],
      ['10', 'LOT1'],
    ];
    const d = decodePlus(padWord(enc(sgtinPlus, sgtin({ aidc }))));
    expect(d instanceof Gs1Error ? d : d.aidc).toEqual(aidc);
  });
  it('rejects an A to F nibble in the rest of a 4-digit key', () => {
    const bits = enc(sgtinPlus, sgtin({ aidc: [['8020', 'ABC123']] }));
    const bad = `${bits.slice(0, plain.length + 8)}1100${bits.slice(plain.length + 12)}`;
    expect(bitOf(decodePlus(bad))).toEqual(['binary', plain.length]);
  });
  it('rejects a key in Table K without a Table F row', () => {
    // (03) is in the AI table (Table K prefix 03) but not in Table F.
    expect(bitOf(decodePlus(padWord(`${toggled}00000011${'0'.repeat(80)}`)))).toEqual([
      'binary',
      plain.length,
    ]);
  });
  it('gives binary at the reader position for a truncated EPC', () => {
    expect(bitOf(decodePlus(plain.slice(0, 42)))).toEqual(['binary', 40]);
  });
  it('gives binary for input shorter than a header', () => {
    expect(bitOf(decodePlus('1111'))).toEqual(['binary', 4]);
  });
  it('rejects a header that is not a plus scheme', () => {
    const d = decodePlus(`00110000${'0'.repeat(88)}`);
    expect(d instanceof Gs1Error ? d.code : d).toBe('EPC_UNKNOWN_HEADER');
  });
});

describe('plus encode rules', () => {
  it('encodes SGLN without (254) as extension 0 and drops (254)0 on decode (F7)', () => {
    const sgln = schemeOf('sgln+');
    const without = enc(sgln, { filter: 3, body: [['414', '9521141123454']], aidc: [] });
    const withZero = enc(sgln, {
      filter: 3,
      body: [
        ['414', '9521141123454'],
        ['254', '0'],
      ],
      aidc: [],
    });
    const d = decodePlus(without);
    expect([without === withZero, d instanceof Gs1Error ? d : d.body]).toEqual([
      true,
      [['414', '9521141123454']],
    ]);
  });
  it('rejects a body that does not match the scheme', () => {
    expect(
      reasonOf(encodePlus(sgtinPlus, { filter: 3, body: [sgtinBody[0] ?? ['', '']], aidc: [] })),
    ).toEqual(['INVALID_EPC', 'component']);
  });
  it('rejects more body AIs than the scheme has', () => {
    expect(reasonOf(encodePlus(sgtinPlus, sgtin({ body: [...sgtinBody, ['22', 'X']] })))).toEqual([
      'INVALID_EPC',
      'component',
    ]);
  });
  it('passes on Table F errors for body values', () => {
    expect(
      reasonOf(
        encodePlus(
          sgtinPlus,
          sgtin({
            body: [
              ['01', '7952114112345'],
              ['21', 'X'],
            ],
          }),
        ),
      ),
    ).toEqual(['INVALID_EPC', 'component']);
  });
  it('passes on hostname errors', () => {
    expect(reasonOf(encodePlus(schemeOf('sgtin++'), sgtin({ hostname: 'a/b' })))).toEqual([
      'INVALID_EPC',
      'hostname',
    ]);
  });
  it('passes on Table F errors for +AIDC values after a key', () => {
    expect(whyOf(encodePlus(sgtinPlus, sgtin({ aidc: [['10', 'A'.repeat(21)]] })))).toEqual([
      'EPC_FIELD_OVERFLOW',
      'too-long',
    ]);
  });
  it('gives binary for a bad body value on decode', () => {
    const plain = enc(sgtinPlus, sgtin());
    expect(bitOf(decodePlus(`${plain.slice(0, 12)}1010${plain.slice(16)}`))).toEqual([
      'binary',
      12,
    ]);
  });
  it('round-trips a ++ scheme with a date, a hostname and +AIDC data', () => {
    const c = sgtin({
      date: ['15', '261231'],
      hostname: 'id.example.com',
      aidc: [
        ['17', '270101'],
        ['7007', '250501250531'],
        ['10', 'ab-12'],
      ],
    });
    expect(contentFields(decodePlus(padWord(enc(schemeOf('dsgtin++'), c))))).toEqual({
      filter: c.filter,
      body: c.body,
      date: c.date,
      hostname: c.hostname,
      aidc: c.aidc,
    });
  });
  it('rejects a bad filter', () => {
    expect(reasonOf(encodePlus(sgtinPlus, sgtin({ filter: 8 })))).toEqual([
      'INVALID_EPC',
      'filter',
    ]);
  });
  it('requires a hostname for ++ and rejects one for +', () => {
    expect([
      reasonOf(encodePlus(schemeOf('sgtin++'), sgtin())),
      reasonOf(encodePlus(sgtinPlus, sgtin({ hostname: 'id.example.com' }))),
    ]).toEqual([
      ['INVALID_EPC', 'hostname'],
      ['INVALID_EPC', 'hostname'],
    ]);
  });
  it('rejects an +AIDC entry repeating a body AI on encode', () => {
    expect(reasonOf(encodePlus(sgtinPlus, sgtin({ aidc: [['21', 'X']] })))).toEqual([
      'INVALID_EPC',
      'aidc',
    ]);
  });
  it('passes on Table F errors for +AIDC values', () => {
    expect(whyOf(encodePlus(sgtinPlus, sgtin({ aidc: [['03', '12345678901231']] })))).toEqual([
      'EPC_FIELD_OVERFLOW',
      'not-encodable',
    ]);
  });
  it('sets the toggle bit if and only if there is +AIDC data', () => {
    expect([
      enc(sgtinPlus, sgtin()).charAt(8),
      enc(sgtinPlus, sgtin({ aidc: [['10', 'A']] })).charAt(8),
    ]).toEqual(['0', '1']);
  });
  it('rejects an EPC over 496 bits (F11)', () => {
    const aidc: AiValue[] = ['10', '240', '241', '250', '251'].map(
      (ai) => [ai, 'ABCDEFGHIJKLMNOPQRST'] as const,
    );
    expect(whyOf(encodePlus(sgtinPlus, sgtin({ aidc })))).toEqual([
      'EPC_FIELD_OVERFLOW',
      'too-long',
    ]);
  });
});

describe('fewer than 8 trailing zero bits after +AIDC data', () => {
  it('ends the EPC at the last entry', () => {
    const s = plusSchemeByName('sgtin+');
    if (s === undefined) throw new Error('no sgtin+');
    const bits = encodePlus(s, {
      filter: 1,
      body: [
        ['01', '09521141123454'],
        ['21', 'A'],
      ],
      aidc: [['10', 'LOT']],
    });
    if (bits instanceof Gs1Error) throw bits;
    const plain = decodePlus(bits);
    if (plain instanceof Gs1Error) throw plain;
    for (const pad of [3, 7, 8, 80, 432]) {
      const d = decodePlus(bits + '0'.repeat(pad));
      if (d instanceof Gs1Error) throw d;
      expect(d.bitLength).toBe(plain.bitLength);
      expect(d.aidc).toEqual(plain.aidc);
    }
  });
});
