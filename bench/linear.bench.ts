import { describe, expect, test } from 'vitest';
import { ean13 } from 'aidc/ean-upc';
import { itf14 } from 'aidc/itf';
import { gs1128 } from 'aidc/gs1-128';
import { toSvg } from 'aidc/render';

const gtin13 = '9506000134352';
const gtin14 = '09506000134352';
const gs1128Data = '(01)09506000134352(17)201225(10)ABC123';
const ean = ean13.encode(gtin13);
const eanAddOn = ean13.encode(gtin13, { addOn: '12345' });
const itf = itf14.encode(gtin14);
const code128 = gs1128.encode(gs1128Data);

describe('linear symbologies', () => {
  test('encode', async ({ bench }) => {
    expect(ean13.decode(ean).rawData).toBe(gtin13);
    await bench.compare(
      bench('EAN-13 encode', () => {
        ean13.encode(gtin13);
      }),
      bench('EAN-13 with 5-digit add-on encode', () => {
        ean13.encode(gtin13, { addOn: '12345' });
      }),
      bench('ITF-14 encode', () => {
        itf14.encode(gtin14);
      }),
      bench('GS1-128 encode', () => {
        gs1128.encode(gs1128Data);
      }),
    );
  });

  test('decode', async ({ bench }) => {
    expect(eanAddOn.rows.length).toBeGreaterThan(1);
    expect(itf14.decode(itf).rawData).toBe(gtin14);
    expect(gs1128.decode(code128).elementString.toString()).toBe(gs1128Data);
    await bench.compare(
      bench('EAN-13 decode', () => {
        ean13.decode(ean);
      }),
      bench('EAN-13 with 5-digit add-on decode', () => {
        ean13.decode(eanAddOn);
      }),
      bench('ITF-14 decode', () => {
        itf14.decode(itf);
      }),
      bench('GS1-128 decode', () => {
        gs1128.decode(code128);
      }),
    );
  });

  test('toSvg', async ({ bench }) => {
    expect(toSvg(code128).startsWith('<svg')).toBe(true);
    await bench.compare(
      bench('toSvg of a GS1-128 pattern', () => {
        toSvg(code128);
      }),
      bench('toSvg of an EAN-13 pattern', () => {
        toSvg(ean);
      }),
    );
  });
});
