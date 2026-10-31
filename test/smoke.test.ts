import { describe, expect, it } from 'vitest';
import * as root from '../src/index.ts';
import * as ai from '../src/ai/index.ts';
import * as core from '../src/core/index.ts';
import * as dl from '../src/digital-link/index.ts';
import * as scan from '../src/scan/index.ts';
import * as epcModule from '../src/epc/index.ts';
import * as render from '../src/symbology/render/index.ts';
import * as linear from '../src/symbology/linear/index.ts';
import * as matrix from '../src/symbology/matrix/index.ts';
import * as datamatrixEntry from '../src/symbology/matrix/datamatrix.ts';
import * as qrEntry from '../src/symbology/matrix/qr.ts';
import { gs1Qr as entryGs1Qr, qr as entryQr } from '../src/symbology/matrix/qr.ts';
import { dataMatrix, gs1DataMatrix, gs1Qr, matrixFromRows, moduleAt, qr } from '../src/index.ts';

describe('public API surface', () => {
  it('root re-exports core and ai', () => {
    for (const k of Object.keys(core)) expect(root).toHaveProperty(k);
    for (const k of Object.keys(ai)) expect(root).toHaveProperty(k);
    for (const k of Object.keys(dl)) expect(root).toHaveProperty(k);
    for (const k of Object.keys(scan)) expect(root).toHaveProperty(k);
    for (const k of Object.keys(epcModule)) expect(root).toHaveProperty(k);
    for (const k of Object.keys(linear)) expect(root).toHaveProperty(k);
    for (const k of Object.keys(matrix)) expect(root).toHaveProperty(k);
  });

  it('exports exactly the documented names', () => {
    expect(new Set(Object.keys(root))).toEqual(
      new Set([
        'AIM_IDS',
        'CSET32',
        'CSET39',
        'CSET64',
        'CSET82',
        'DEFAULT_DIGITAL_LINK_DOMAIN',
        'ElementString',
        'Gs1Error',
        'PACKAGE_NAME',
        'SCAN_AIM_ID',
        'SYNTAX_DICTIONARY_RELEASE',
        'checkCharacterPair',
        'checkDigit',
        'dataMatrix',
        'fail',
        'firstInvalidChar',
        'format',
        'fromDigitalLink',
        'fromScan',
        'getAi',
        'hri',
        'identifyKey',
        'isDigits',
        'isValidCheckCharacterPair',
        'isValidCheckDigit',
        'mod10',
        'epc',
        'ok',
        'parse',
        'parseDigitalLink',
        'toDigitalLink',
        'toScan',
        'tryFromDigitalLink',
        'tryFromScan',
        'tryParse',
        'tryParseDigitalLink',
        'tryToDigitalLink',
        'tryToScan',
        'unwrap',
        'validate',
        'SYMBOL_SPECS',
        'ean13',
        'ean8',
        'eanUpc',
        'gs1128',
        'gs1DataMatrix',
        'gs1Qr',
        'itf14',
        'linearPattern',
        'matrixFromRows',
        'moduleAt',
        'qr',
        'toSvg',
        'tryToSvg',
        'upcA',
        'upcE',
        'upceCompress',
        'upceExpand',
      ]),
    );
  });

  it('does not leak internals', () => {
    expect(root).not.toHaveProperty('tokenize');
    expect(root).not.toHaveProperty('LINTERS');
    expect(root).not.toHaveProperty('AI_TABLE');
    expect(root).not.toHaveProperty('createElementString');
    expect(root).not.toHaveProperty('checkElement');
    expect(root).not.toHaveProperty('shiftError');
    expect(root).not.toHaveProperty('BitWriter');
    expect(root).not.toHaveProperty('BINARY_SCHEMES');
    expect(root).not.toHaveProperty('encodeBinary');
    expect(ai).not.toHaveProperty('createElementString');
    for (const k of [
      'symbolError',
      'freezePattern',
      'readRows',
      'readPlacedRows',
      'dataTooLong',
      'notRepresentable',
      'C128_WIDTHS',
      'C128_LOOKUP',
      'encodeTokens',
      'hriLines',
      'gtinInput',
      'placeCodewords',
      'encodeCodewords',
      'chooseSize',
      'readDataMatrix',
      'decodeCodewords',
      'specialError',
      'gs1FromData',
      'DM_SIZES',
      'DM_FNC1',
      'freezeMatrix',
      'readMatrix',
      'freezeDecoded',
      'rsUncorrectable',
      'buildSymbol',
      'encodeSegments',
      'chooseVersion',
      'segment',
      'readQr',
      'decodeBits',
      'qrVersion',
      'invalidOption',
      'encodedOrder',
      'renamed',
    ])
      expect(root).not.toHaveProperty(k);
  });
});

describe('datamatrix entry', () => {
  it('exports exactly gs1DataMatrix and dataMatrix', () => {
    expect(new Set(Object.keys(datamatrixEntry))).toEqual(new Set(['gs1DataMatrix', 'dataMatrix']));
    expect(new Set(Object.keys(matrix))).toEqual(
      new Set(['gs1DataMatrix', 'dataMatrix', 'gs1Qr', 'qr']),
    );
  });
  it('works from the package root', () => {
    const m = gs1DataMatrix.encode('(01)09501101020917');
    expect(moduleAt(m, 0, m.height - 1)).toBe(true);
    expect(gs1DataMatrix.decode(matrixFromRows(m.rows)).rawData).toBe('0109501101020917');
    expect(dataMatrix.name).toBe('datamatrix');
  });
});

describe('qr entry', () => {
  it('exports exactly gs1Qr and qr', () => {
    expect(new Set(Object.keys(qrEntry))).toEqual(new Set(['gs1Qr', 'qr']));
    expect(gs1Qr).toBe(entryGs1Qr);
    expect(qr).toBe(entryQr);
  });
  it('works from the package root', () => {
    const m = gs1Qr.encode('(01)09506000134352(17)201225(10)ABC123');
    expect(m.width).toBe(25);
    expect(moduleAt(m, 0, 0)).toBe(true);
    expect(gs1Qr.decode(matrixFromRows(m.rows)).rawData).toBe('01095060001343521720122510ABC123');
    const d = qr.decode(qr.encode('https://id.gs1.org/01/09506000134352'));
    expect(d.digitalLink).toBe('https://id.gs1.org/01/09506000134352');
    expect([gs1Qr.name, qr.name]).toEqual(['gs1-qr', 'qr']);
  });
});

describe('render entry', () => {
  it('exports exactly the public names', () => {
    expect(new Set(Object.keys(render))).toEqual(
      new Set(['SYMBOL_SPECS', 'linearPattern', 'matrixFromRows', 'moduleAt', 'toSvg', 'tryToSvg']),
    );
    expect(Object.keys(render)).toHaveLength(6);
  });
  it('does not export the internal helpers', () => {
    for (const k of [
      'freezePattern',
      'symbolError',
      'notRepresentable',
      'dataTooLong',
      'readRows',
      'readPlacedRows',
      'freezeDecoded',
      'freezeMatrix',
      'readMatrix',
      'rsUncorrectable',
    ])
      expect(render).not.toHaveProperty(k);
  });
});
