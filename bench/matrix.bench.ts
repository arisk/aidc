import { describe, expect, test } from 'vitest';
import { DM_POLY, gf256 } from '../src/core/gf256.ts';
import { rsDecode, rsEncode } from '../src/core/reed-solomon.ts';
import { dataMatrix, gs1DataMatrix } from 'aidc/datamatrix';
import { gs1Qr, qr } from 'aidc/qr';
import { penaltyScores } from '../src/symbology/matrix/qr-place.ts';
import { toSvg } from 'aidc/render';

const gs1Data = '(01)09506000134352(17)201225(10)ABC123';
const uri = 'https://id.gs1.org/01/09506000134352/10/ABC123?17=201225';
// Close to the 1558 codewords of the largest square: 3000 digits are 1500 codewords in ASCII mode.
const bigUri = `https://id.gs1.org/01/09506000134352?x=${'1234567890'.repeat(300)}`;

const gs1Symbol = gs1DataMatrix.encode(gs1Data);
const dlSymbol = dataMatrix.encode(uri);
const bigSymbol = dataMatrix.encode(bigUri);
const svgSymbol = gs1DataMatrix.encode(gs1Data, { size: { rows: 64, columns: 64 } });

// Version 40-L holds 7089 digits; the URI prefix is alphanumeric, the tail numeric.
const qrBigUri = `https://id.gs1.org/01/09506000134352?x=${'1234567890'.repeat(690)}`;
const gs1QrSymbol = gs1Qr.encode(gs1Data);
const qrDlSymbol = qr.encode(uri);
const qrBigSymbol = qr.encode(qrBigUri, { ecLevel: 'L' });
// The data codewords of the near-capacity symbol, so the mask selection bench places real data.
const qrBigCodewords = [...qr.decode(qrBigSymbol).metadata.codewords];

const field = gf256(DM_POLY);
const rsData = Uint8Array.from({ length: 235 }, (_, i) => (i * 37 + 11) & 255);
const rsBlock = Uint8Array.from([...rsData, ...rsEncode(field, rsData, 20, 1)]);
const rsDamaged = Uint8Array.from(rsBlock);
for (let i = 0; i < 10; i++) rsDamaged[i * 23 + 3] = (rsDamaged[i * 23 + 3] ?? 0) ^ 0x5a;

describe('GS1 DataMatrix', () => {
  test('encode', async ({ bench }) => {
    expect(gs1Symbol.height).toBeGreaterThan(0);
    expect(bigSymbol.width).toBe(144);
    await bench.compare(
      bench('gs1DataMatrix encode', () => {
        gs1DataMatrix.encode(gs1Data);
      }),
      bench('dataMatrix encode (Digital Link URI)', () => {
        dataMatrix.encode(uri);
      }),
      bench('dataMatrix encode 144x144, 3000 digits', () => {
        dataMatrix.encode(bigUri);
      }),
    );
  });

  test('decode', async ({ bench }) => {
    expect(gs1DataMatrix.decode(gs1Symbol).elementString.toString()).toBe(gs1Data);
    expect(dataMatrix.decode(dlSymbol).digitalLink).toBe(uri);
    expect(dataMatrix.decode(bigSymbol).rawData).toBe(bigUri);
    await bench.compare(
      bench('gs1DataMatrix decode', () => {
        gs1DataMatrix.decode(gs1Symbol);
      }),
      bench('dataMatrix decode (Digital Link URI)', () => {
        dataMatrix.decode(dlSymbol);
      }),
      bench('dataMatrix decode 144x144, 3000 digits', () => {
        dataMatrix.decode(bigSymbol);
      }),
    );
  });

  test('toSvg', async ({ bench }) => {
    expect(svgSymbol.width).toBe(64);
    expect(toSvg(svgSymbol)).toContain('<path');
    await bench.compare(
      bench('toSvg 64x64', () => {
        toSvg(svgSymbol);
      }),
      bench('toSvg 144x144', () => {
        toSvg(bigSymbol);
      }),
    );
  });
});

describe('Reed-Solomon (GF(256), 0x12d)', () => {
  test('255-codeword block, 20 parity codewords', async ({ bench }) => {
    expect(rsDecode(field, Uint8Array.from(rsDamaged), 20, 1, 10)).toBe(10);
    await bench.compare(
      bench('rsEncode 235 + 20', () => {
        rsEncode(field, rsData, 20, 1);
      }),
      bench('rsDecode 255, 10 errors', () => {
        rsDecode(field, Uint8Array.from(rsDamaged), 20, 1, 10);
      }),
    );
  });
});

describe('GS1 QR Code', () => {
  test('encode', async ({ bench }) => {
    expect(gs1QrSymbol.width).toBe(25);
    expect(qrBigSymbol.width).toBe(177);
    await bench.compare(
      bench('gs1Qr encode', () => {
        gs1Qr.encode(gs1Data);
      }),
      bench('qr encode (Digital Link URI)', () => {
        qr.encode(uri);
      }),
      bench('qr encode 40-L near capacity, 6900 digits', () => {
        qr.encode(qrBigUri, { ecLevel: 'L' });
      }),
    );
  });

  test('decode', async ({ bench }) => {
    expect(gs1Qr.decode(gs1QrSymbol).elementString.toString()).toBe(gs1Data);
    expect(qr.decode(qrDlSymbol).digitalLink).toBe(uri);
    expect(qr.decode(qrBigSymbol).rawData).toBe(qrBigUri);
    await bench.compare(
      bench('gs1Qr decode', () => {
        gs1Qr.decode(gs1QrSymbol);
      }),
      bench('qr decode (Digital Link URI)', () => {
        qr.decode(qrDlSymbol);
      }),
      bench('qr decode 40-L near capacity', () => {
        qr.decode(qrBigSymbol);
      }),
    );
  });

  test('toSvg and mask selection', async ({ bench }) => {
    expect(toSvg(qrBigSymbol)).toContain('<path');
    expect(penaltyScores(40, 'L', qrBigCodewords)).toHaveLength(8);
    await bench.compare(
      bench('toSvg 177x177', () => {
        toSvg(qrBigSymbol);
      }),
      bench('mask selection alone (eight penalties), 40-L near capacity', () => {
        penaltyScores(40, 'L', qrBigCodewords);
      }),
    );
  });
});
