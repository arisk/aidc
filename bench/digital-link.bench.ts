import { describe, expect, test } from 'vitest';
import { parse } from 'aidc/ai';
import { fromDigitalLink, toDigitalLink } from 'aidc/digital-link';
import { fromScan } from 'aidc/scan';

const es = parse('(01)09506000134352(10)ABC123(21)12345(17)261231(3103)000195');
const uri = toDigitalLink(es);
const compressed = toDigitalLink(es, { compressed: true });
const scan = ']C1010950600013435210ABC123\u001d2112345\u001d173612313103000195';

const qrScan = `]Q1${uri}`;

describe('digital link', () => {
  test('build and parse', async ({ bench }) => {
    expect(fromDigitalLink(uri).equivalent(es)).toBe(true);
    expect(fromDigitalLink(compressed).equivalent(es)).toBe(true);
    await bench.compare(
      bench('toDigitalLink', () => {
        toDigitalLink(es);
      }),
      bench('fromDigitalLink', () => {
        fromDigitalLink(uri);
      }),
      bench('toDigitalLink compressed', () => {
        toDigitalLink(es, { compressed: true });
      }),
      bench('fromDigitalLink compressed', () => {
        fromDigitalLink(compressed);
      }),
    );
  });
});

describe('scan', () => {
  test('fromScan', async ({ bench }) => {
    expect(fromScan(scan).symbology).toBe('gs1-128');
    await bench.compare(
      bench('fromScan GS1-128', () => {
        fromScan(scan);
      }),
      bench('fromScan QR Digital Link', () => {
        fromScan(qrScan);
      }),
    );
  });
});
