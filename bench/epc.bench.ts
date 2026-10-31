import { describe, expect, test } from 'vitest';
import { epc } from 'aidc/epc';

const sgtin96Hex = '3074257BF7194E4000001A85';
const sgtin198Tag = 'urn:epc:tag:sgtin-198:3.0614141.812345.32a12345678901234';
const gtinEs = '(01)09506000134352(21)12345';
const opts = { scheme: 'sgtin-96', filter: 3, companyPrefixLength: 7 } as const;
const decoded = epc.decode(sgtin96Hex);
const plusEs = '(01)09506000134352(21)12345(17)271231(10)LOT7';
const plusHex = epc.fromElementString(plusEs, {
  scheme: 'sgtin++',
  filter: 3,
  hostname: 'id.example.com',
}).hex;

describe('epc', () => {
  test('decode and encode', async ({ bench }) => {
    expect(decoded.scheme).toBe('sgtin');
    expect(epc.decode(sgtin198Tag).binaryScheme).toBe('sgtin-198');
    expect(epc.fromElementString(gtinEs, opts).binaryScheme).toBe('sgtin-96');
    await bench.compare(
      bench('decode SGTIN-96 hex', () => {
        epc.decode(sgtin96Hex);
      }),
      bench('decode SGTIN-198 tag URI', () => {
        epc.decode(sgtin198Tag);
      }),
      bench('fromElementString to SGTIN-96', () => {
        epc.fromElementString(gtinEs, opts);
      }),
      bench('decode SGTIN++ hex', () => {
        epc.decode(plusHex ?? '');
      }),
      bench('fromElementString to DSGTIN+ with +AIDC', () => {
        epc.fromElementString(plusEs, { scheme: 'dsgtin+', filter: 3 });
      }),
      bench('toElementString', () => {
        epc.toElementString(decoded);
      }),
    );
  });
});
