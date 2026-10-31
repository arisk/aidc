import { describe, expect, it } from 'vitest';
import { parse } from '../../src/ai/index.ts';
import { Gs1Error } from '../../src/core/errors.ts';
import { type Epc, epc } from '../../src/epc/index.ts';
import { identity } from '../support/epc.ts';

const first = (r: {
  ok: boolean;
  errors?: readonly {
    code: string;
    details?: Readonly<Record<string, unknown>> | undefined;
    position?: number | undefined;
  }[];
}): unknown =>
  r.ok
    ? 'ok'
    : [
        r.errors?.[0]?.code,
        r.errors?.[0]?.details?.['reason'] ?? r.errors?.[0]?.details?.['field'] ?? null,
        r.errors?.[0]?.position ?? null,
      ];

describe('epc.decode', () => {
  it('decodes hex, bytes, tag, raw and pure URIs to one value', () => {
    const fromHex = epc.decode('3074257BF7194E4000001A85');
    expect(fromHex).toMatchObject({
      scheme: 'sgtin',
      kind: 'id',
      binaryScheme: 'sgtin-96',
      filter: 3,
      pureIdentityUri: 'urn:epc:id:sgtin:0614141.812345.6789',
      tagUri: 'urn:epc:tag:sgtin-96:3.0614141.812345.6789',
      rawUri: 'urn:epc:raw:96.x3074257BF7194E4000001A85',
      hex: '3074257BF7194E4000001A85',
      bitLength: 96,
    });
    expect(identity(epc.decode(fromHex.bytes ?? new Uint8Array())).tagUri).toBe(
      identity(fromHex).tagUri,
    );
    expect(epc.decode(identity(fromHex).tagUri ?? '').hex).toBe(fromHex.hex);
    expect(identity(epc.decode(fromHex.rawUri ?? '')).tagUri).toBe(identity(fromHex).tagUri);
    const pure = epc.decode('urn:epc:id:sgtin:0614141.812345.6789');
    expect([pure.binaryScheme, pure.hex, identity(pure).tagUri]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(
      epc.decode('urn:epc:id:sgtin:0614141.812345.6789', { scheme: 'sgtin-96', filter: 3 }).hex,
    ).toBe(fromHex.hex);
  });

  it('re-encodes into another scheme and keeps control fields', () => {
    const long = epc.decode('3074257BF7194E4000001A85', { scheme: 'sgtin-198' });
    expect(identity(long).tagUri).toBe('urn:epc:tag:sgtin-198:3.0614141.812345.6789');
    const t = epc.decode('urn:epc:tag:[att=x01]:sgtin-96:3.0614141.812345.6789');
    expect([t.control, identity(t).tagUri, t.hex]).toEqual([
      { att: 1 },
      'urn:epc:tag:[att=x01]:sgtin-96:3.0614141.812345.6789',
      '3074257BF7194E4000001A85',
    ]);
  });

  it('positions index the input; hex errors point at the hex digit (Review Focus 2)', () => {
    expect(first(epc.tryDecode('3074257BF7194E4000001A851'))).toEqual([
      'INVALID_EPC',
      'binary',
      24,
    ]);
    expect(first(epc.tryDecode('30G4'))).toEqual(['INVALID_EPC', 'syntax', 2]);
    expect(first(epc.tryDecode(new Uint8Array([0x30, 0x74])))).toEqual([
      'INVALID_EPC',
      'binary',
      null,
    ]);
    expect(first(epc.tryDecode('urn:epc:raw:[afi]'))).toEqual(['INVALID_EPC', 'control', 12]);
    expect(first(epc.tryDecode('urn:epc:raw:64.x31.x0123456890ABCDEF'))).toEqual([
      'UNSUPPORTED',
      'raw-afi',
      null,
    ]);
    expect(first(epc.tryDecode('hello'))).toEqual(['INVALID_EPC', 'syntax', 0]);
    expect(first(epc.tryDecode(''))).toEqual(['EMPTY_INPUT', null, 0]);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a wrong input type from untyped callers
    expect(first(epc.tryDecode(42 as unknown as string))).toEqual(['SYNTAX', null, null]);
  });
});

describe('epc.fromElementString and toElementString', () => {
  it('builds the spec 4.4 example and maps back', () => {
    const tag = epc.fromElementString('(01)80614141123458(21)6789', {
      scheme: 'sgtin-96',
      filter: 3,
      companyPrefixLength: 7,
    });
    expect(tag.hex).toBe('3074257BF7194E4000001A85');
    expect(epc.toElementString(tag).equals(parse('(01)80614141123458(21)6789'))).toBe(true);
  });

  it('a short scheme cannot hold leading zeros or letters (Review Focus 1, E10)', () => {
    const opts = { scheme: 'sgtin-96', companyPrefixLength: 7 } as const;
    expect(first(epc.tryFromElementString('(01)09521141123454(21)0123', opts))).toEqual([
      'EPC_FIELD_OVERFLOW',
      'serial',
      null,
    ]);
    expect(first(epc.tryFromElementString('(01)09521141123454(21)AB', opts))).toEqual([
      'EPC_FIELD_OVERFLOW',
      'serial',
      null,
    ]);
    expect(
      identity(
        epc.fromElementString('(01)09521141123454(21)0123', { ...opts, scheme: 'sgtin-198' }),
      ).tagUri,
    ).toBe('urn:epc:tag:sgtin-198:0.9521141.012345.0123');
  });

  it('mismatched scheme and identity, and invalid element strings', () => {
    expect(
      first(
        epc.tryFromElementString('(00)106141412345678908', {
          scheme: 'sgtin-96',
          companyPrefixLength: 7,
        }),
      ),
    ).toEqual(['INVALID_EPC', 'no-epc-key', null]);
    expect(first(epc.tryFromElementString('(01)123', { companyPrefixLength: 7 }))).toEqual([
      'INVALID_LENGTH',
      null,
      4,
    ]);
    expect(first(epc.tryToElementString(epc.decode('urn:epc:id:gid:952056.2718.1414')))).toEqual([
      'INVALID_EPC',
      'no-gs1-key',
      null,
    ]);
  });
});

describe('Epc values are frozen', () => {
  it('cannot be mutated', () => {
    const e = epc.decode('3074257BF7194E4000001A85');
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(identity(e).components)).toBe(true);
  });
});

describe('encode options', () => {
  const pure = 'urn:epc:id:sgtin:0614141.812345.6789';
  it('reject a scheme of another identity, a filter or controls without a scheme, a filter gid-96 lacks', () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an unknown name from untyped callers
    expect(first(epc.tryDecode(pure, { scheme: 'nope' as 'sgtin-96' }))).toEqual([
      'INVALID_EPC',
      'scheme',
      null,
    ]);
    expect(first(epc.tryDecode(pure, { scheme: 'sscc-96' }))).toEqual([
      'INVALID_EPC',
      'scheme',
      null,
    ]);
    expect(
      first(epc.tryDecode('urn:epc:class:lgtin:4012345.012345.998877', { scheme: 'sgtin-96' })),
    ).toEqual(['INVALID_EPC', 'scheme', null]);
    expect(first(epc.tryDecode(pure, { filter: 1 }))).toEqual(['INVALID_EPC', 'filter', null]);
    expect(first(epc.tryDecode(pure, { control: { umi: true } }))).toEqual([
      'INVALID_EPC',
      'control',
      null,
    ]);
    expect(
      first(epc.tryDecode('urn:epc:id:gid:952056.2718.1414', { scheme: 'gid-96', filter: 1 })),
    ).toEqual(['INVALID_EPC', 'filter', null]);
    expect(first(epc.tryDecode('urn:epc:tag:sgtin-96:8.0614141.812345.6789'))).toEqual([
      'INVALID_EPC',
      'filter',
      null,
    ]);
  });

  it('override the filter and controls of a binary input', () => {
    const e = epc.decode('3074257BF7194E4000001A85', { filter: 1, control: { umi: true } });
    expect([identity(e).tagUri, e.rawUri, e.hex]).toEqual([
      'urn:epc:tag:[umi=1]:sgtin-96:1.0614141.812345.6789',
      'urn:epc:raw:[umi=1]:96.x3034257BF7194E4000001A85',
      '3034257BF7194E4000001A85',
    ]);
    const gid = epc.decode('urn:epc:id:gid:952056.2718.1414', { scheme: 'gid-96' });
    expect([gid.filter, identity(gid).tagUri]).toEqual([
      undefined,
      'urn:epc:tag:gid-96:952056.2718.1414',
    ]);
  });

  it('pad raw URIs to 16-bit words and hand out a fresh bytes copy', () => {
    const e = epc.decode(pure, { scheme: 'sgtin-198', filter: 3 });
    expect([e.bitLength, e.rawUri?.slice(0, 16)]).toEqual([198, 'urn:epc:raw:208.']);
    const b = e.bytes ?? new Uint8Array();
    b[0] = 0;
    expect(e.bytes?.[0]).toBe(0x36);
  });

  it('decode errors: unknown header in hex, an EPC raw URI with bad bits', () => {
    expect(first(epc.tryDecode('FF00'))).toEqual(['EPC_UNKNOWN_HEADER', null, 0]);
    expect(first(epc.tryDecode('urn:epc:raw:16.x3074'))).toEqual(['INVALID_EPC', 'binary', null]);
    expect(first(epc.tryDecode('urn:epc:tag:nope:1.2'))).toEqual(['INVALID_EPC', 'scheme', 12]);
  });
});

describe('fromElementString inputs', () => {
  it('takes an ElementString, rejects other values and unknown schemes', () => {
    const es = parse('(01)80614141123458(21)6789');
    expect(identity(epc.fromElementString(es, { companyPrefixLength: 7 })).pureIdentityUri).toBe(
      'urn:epc:id:sgtin:0614141.812345.6789',
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a wrong input type from untyped callers
    expect(first(epc.tryFromElementString(42 as unknown as string))).toEqual([
      'SYNTAX',
      null,
      null,
    ]);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an unknown name from untyped callers
    const nope = 'nope' as 'sgtin-96';
    expect(first(epc.tryFromElementString(es, { scheme: nope, companyPrefixLength: 7 }))).toEqual([
      'INVALID_EPC',
      'scheme',
      null,
    ]);
    expect(
      first(
        epc.tryFromElementString(es, {
          epcScheme: 'sgtin',
          scheme: 'sscc-96',
          companyPrefixLength: 7,
        }),
      ),
    ).toEqual(['INVALID_EPC', 'scheme', null]);
    expect(first(epc.tryFromElementString(es))).toEqual(['GCP_LENGTH_UNKNOWN', null, null]);
  });
});

describe('control options are validated (final review item 1)', () => {
  const hex = '3074257BF7194E4000001A85';
  const bad: readonly [string, unknown][] = [
    ['att 300', { att: 300 }],
    ['att -1', { att: -1 }],
    ['att 1.5', { att: 1.5 }],
    ['att as a string', { att: '1' }],
    ['xpc 2^40', { xpc: 2 ** 40 }],
    ['xpc -1', { xpc: -1 }],
    ['xpc NaN', { xpc: Number.NaN }],
    ['umi as a string', { umi: 'yes' }],
    ['umi as a number', { umi: 1 }],
    ['control null', null],
    ['control a number', 7],
  ];
  for (const [name, control] of bad) {
    it(`rejects ${name}`, () => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a wrong control value from untyped callers
      const opts = { control } as unknown as { control: { att?: number } };
      expect(first(epc.tryDecode(hex, opts))).toEqual(['INVALID_EPC', 'control', null]);
    });
  }
  it('accepts the limits, and the tag and raw URIs re-decode', () => {
    const e = epc.decode(hex, { control: { att: 255, umi: false, xpc: 0xffffffff } });
    expect([identity(e).tagUri, e.rawUri]).toEqual([
      'urn:epc:tag:[att=xFF][xpc=xFFFFFFFF]:sgtin-96:3.0614141.812345.6789',
      'urn:epc:raw:[att=xFF][xpc=xFFFFFFFF]:96.x3074257BF7194E4000001A85',
    ]);
    expect(epc.decode(identity(e).tagUri ?? '').control).toEqual(e.control);
    expect(epc.decode(e.rawUri ?? '').control).toEqual(e.control);
  });
});

describe('decode keeps the TDS digit limits (final review item 2)', () => {
  it('rejects a CPI-96 part reference longer than K digits', () => {
    expect(first(epc.tryDecode('3C76451FDF00C0E680F03039'))).toEqual(['INVALID_EPC', 'binary', 2]);
  });
  it('rejects a CPI-var serial longer than 12 digits', () => {
    expect(first(epc.tryDecode('3D000000000000103FFFFFFFFFC0'))).toEqual([
      'INVALID_EPC',
      'binary',
      16,
    ]);
    expect(identity(epc.decode('3D000000000000103A352943FFC0')).components[2]).toBe('999999999999');
  });
});

describe('components are canonical (final review item 4)', () => {
  it('hex, lower-case escapes and over-escapes give equal components', () => {
    const fromTag = epc.decode('urn:epc:tag:sgtin-198:3.0614141.812345.32a%2Fb');
    const lower = epc.decode('urn:epc:id:sgtin:0614141.812345.32a%2fb');
    const over = epc.decode('urn:epc:id:sgtin:0614141.812345.32%61%2Fb');
    const fromHex = epc.decode(fromTag.hex ?? '');
    expect([
      identity(fromHex).components,
      identity(lower).components,
      identity(over).components,
    ]).toEqual([
      ['0614141', '812345', '32a%2Fb'],
      ['0614141', '812345', '32a%2Fb'],
      ['0614141', '812345', '32a%2Fb'],
    ]);
    expect(identity(epc.decode('urn:epc:id:cpi:0614141.5PQ7%2fZ43.12345')).components).toEqual([
      '0614141',
      '5PQ7%2FZ43',
      '12345',
    ]);
  });
});

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- wrong option types from untyped callers
const asOpts = (v: unknown): { filter?: number } => v as { filter?: number };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- wrong Epc values from untyped callers
const asEpc = (v: unknown): Epc => v as Epc;

describe('untyped calls fail with a Gs1Error (final review item 5)', () => {
  const hex = '3074257BF7194E4000001A85';
  it('null options mean no options', () => {
    expect(epc.tryDecode(hex, asOpts(null)).ok).toBe(true);
    expect(epc.decode(hex, asOpts(null)).hex).toBe(hex);
    expect(
      epc.tryFromElementString('(01)80614141123458(21)6789', asOpts(null)).ok ? 'ok' : 'failed',
    ).toBe('failed');
    expect(first(epc.tryFromElementString('(01)80614141123458(21)6789', asOpts(null)))).toEqual([
      'GCP_LENGTH_UNKNOWN',
      null,
      null,
    ]);
  });
  it('non-object options are SYNTAX', () => {
    expect(first(epc.tryDecode(hex, asOpts(3)))).toEqual(['SYNTAX', null, null]);
    expect(first(epc.tryDecode(hex, asOpts('x')))).toEqual(['SYNTAX', null, null]);
    expect(first(epc.tryFromElementString('(01)80614141123458(21)6789', asOpts(3)))).toEqual([
      'SYNTAX',
      null,
      null,
    ]);
  });
  it('a non-object Epc is SYNTAX', () => {
    expect(first(epc.tryToElementString(asEpc(null)))).toEqual(['SYNTAX', null, null]);
    expect(first(epc.tryToElementString(asEpc('urn:epc:id:sgtin:0614141.812345.6789')))).toEqual([
      'SYNTAX',
      null,
      null,
    ]);
    expect(first(epc.tryToElementString(asEpc({ scheme: 'sgtin', kind: 'id' })))).toEqual([
      'SYNTAX',
      null,
      null,
    ]);
    expect(() => epc.toElementString(asEpc(undefined))).toThrow(Gs1Error);
  });
});

const raw = (body: string): string => `urn:epc:raw:96.x${body}`;

describe('hex and bytes input are at most 496 bits (final review item 8)', () => {
  it('accepts 496 bits of padding, rejects more', () => {
    const at496 = `30${'0'.repeat(122)}`;
    expect(epc.decode(at496).binaryScheme).toBe('sgtin-96');
    expect(first(epc.tryDecode(`${at496}0`))).toEqual(['INVALID_EPC', 'binary', 124]);
    expect(first(epc.tryDecode(`30${'0'.repeat(1e7)}`))).toEqual(['INVALID_EPC', 'binary', 124]);
    expect(first(epc.tryDecode(`30${'0'.repeat(200)}G`))).toEqual(['INVALID_EPC', 'syntax', 202]);
    const bytes = new Uint8Array(62);
    bytes[0] = 0x30;
    expect(epc.decode(bytes).binaryScheme).toBe('sgtin-96');
    const more = new Uint8Array(63);
    more[0] = 0x30;
    expect(first(epc.tryDecode(more))).toEqual(['INVALID_EPC', 'binary', null]);
  });

  it('caps EPC URIs at 1024 characters (security review)', () => {
    const long = `urn:epc:id:gid:${'1'.repeat(4e6)}.1.1`;
    expect(first(epc.tryDecode(long))).toEqual(['INVALID_EPC', 'syntax', 1024]);
    const tag = `urn:epc:tag:sgtin-96:3.0614141.812345.${'9'.repeat(4e6)}`;
    expect(first(epc.tryDecode(tag))).toEqual(['INVALID_EPC', 'syntax', 1024]);
    expect(epc.decode(`urn:epc:id:gid:${'1'.repeat(1000)}.1.1`).scheme).toBe('gid');
  });

  it('caps raw URI hex at 124 digits before reading it (security review)', () => {
    const hex = '3074257BF7194E4000001A85';
    expect(epc.decode(raw('0'.repeat(124 - hex.length) + hex)).hex).toBe(hex);
    expect(first(epc.tryDecode(raw('0'.repeat(125 - hex.length) + hex)))).toEqual([
      'INVALID_EPC',
      'syntax',
      16,
    ]);
    expect(first(epc.tryDecode(raw('0'.repeat(500) + hex)))).toEqual(['INVALID_EPC', 'syntax', 16]);
    expect(first(epc.tryDecode(`urn:epc:raw:96.x${'0'.repeat(500)}.x${hex}`))).toEqual([
      'INVALID_EPC',
      'syntax',
      16,
    ]);
    // Longer still, the URI length cap stops it first.
    expect(first(epc.tryDecode(raw('0'.repeat(4e6) + hex)))).toEqual([
      'INVALID_EPC',
      'syntax',
      1024,
    ]);
  });
});
