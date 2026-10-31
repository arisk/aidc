import { describe, expect, it } from 'vitest';
import { parse } from '../../src/ai/index.ts';
import {
  tryFromDigitalLink,
  tryParseDigitalLink,
  tryToDigitalLink,
} from '../../src/digital-link/index.ts';
import { isValidKeyPath } from '../../src/digital-link/keys.ts';
import { bitsToBase64url } from '../../src/core/base64url.ts';
import { decompressSegment } from '../../src/digital-link/compress/decode.ts';
import { compressSegment } from '../../src/digital-link/compress/encode.ts';
import { tryFromScan, tryToScan } from '../../src/scan/index.ts';

describe('branch coverage: Digital Link', () => {
  it('reports a partially compressed link that repeats the path key AI', () => {
    const seg = compressSegment([
      ['01', '09506000134352'],
      ['10', 'ABC'],
    ]);
    if (typeof seg !== 'string') throw new Error('compression failed');
    const r = tryFromDigitalLink(`https://id.gs1.org/01/09506000134352/${seg}`);
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toContain('DUPLICATE_AI');
  });

  it('rejects a short path GTIN with a non-digit even when zero-suppressed GTINs are allowed', () => {
    const r = tryParseDigitalLink('https://example.com/01/1234567A', {
      permitZeroSuppressedGtin: true,
    });
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toEqual(['INVALID_LENGTH']);
  });

  it('rejects non-ASCII characters in the URI', () => {
    const r = tryParseDigitalLink('https://example.com/01/09506000134352/10/café');
    expect(r.ok ? [] : r.errors.map((e) => e.details?.['reason'])).toContain('uri-chars');
  });

  it('compresses an element string that has only the primary key', () => {
    const es = parse('(01)09506000134352');
    const r = tryToDigitalLink(es, { compressed: 'partial' });
    expect(r).toEqual({ ok: true, value: 'https://id.gs1.org/01/09506000134352' });
  });
});

describe('branch coverage: compression and keys', () => {
  it('has no valid key path when the path is empty', () => {
    expect(isValidKeyPath([])).toBe(false);
  });

  it('fails when a value inside a Table Opt sequence does not fit Table F', () => {
    expect(
      compressSegment([
        ['01', '123'],
        ['10', 'A'],
      ]),
    ).toEqual({ ai: '01', why: 'length' });
  });

  it('fails when a value outside Table Opt does not fit Table F', () => {
    expect(compressSegment([['3103', '12a456']])).toEqual({ ai: '3103', why: 'not-numeric' });
    expect(compressSegment([['10', 'A'.repeat(21)]])).toEqual({ ai: '10', why: 'length' });
  });

  it('writes an empty variable-length numeric value', () => {
    const seg = compressSegment([['30', '']]);
    if (typeof seg !== 'string') throw new Error('compression failed');
    const d = decompressSegment(seg);
    expect('cause' in d ? d.cause : d.ais).toEqual([['30', '']]);
  });

  it('reports an AI value that does not fit Table F as UNSUPPORTED when building', () => {
    // (8007) values longer than 24 characters cannot be compressed.
    const es = parse('(415)9506000134352(8020)1234(8007)GB74BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    const r = tryToDigitalLink(es, { compressed: true });
    expect(r.ok ? [] : r.errors.map((e) => [e.code, e.ai, e.details?.['reason']])).toEqual([
      ['UNSUPPORTED', '8007', 'compression-table'],
    ]);
  });

  it('reports a bad value in a non-GS1 pair', () => {
    // key "A" (6 bits), then an alphanumeric value with the unused encoding 5
    const d = decompressSegment(bitsToBase64url('111100000010000001010000000'));
    expect('cause' in d ? d.cause : 'decoded').toBe('encoding');
  });

  it('reports an AI outside Table F and a fixed-length value that is too long', () => {
    expect(compressSegment([['9999', 'A']])).toEqual({ ai: '9999', why: 'not-in-table' });
    expect(compressSegment([['11', '2612311']])).toEqual({ ai: '11', why: 'length' });
  });

  it('rejects an empty compressed segment', () => {
    const d = decompressSegment('');
    expect('cause' in d ? d.cause : 'decoded').toBe('base64url');
  });

  it('orders attributes like the engine when asked', () => {
    const es = parse('(01)09506000134352(10)ABC(17)261231(3103)000195');
    const r = tryToDigitalLink(es, { attributeOrder: 'engine' });
    expect(r).toEqual({
      ok: true,
      value: 'https://id.gs1.org/01/09506000134352/10/ABC?17=261231&3103=000195',
    });
  });
});

describe('branch coverage: scan', () => {
  it('writes a 5 digit add-on', () => {
    const r = tryToScan(parse('(01)09506000134352'), 'ean-13', { addOn: '12345' });
    expect(r).toEqual({ ok: true, value: ']E3950600013435212345' });
  });

  it('rejects add-ons that are not 2 or 5 digits', () => {
    const es = parse('(01)09506000134352');
    for (const addOn of ['123', '1a']) {
      const r = tryToScan(es, 'ean-13', { addOn });
      expect(r.ok ? [] : r.errors.map((e) => [e.code, e.details?.['reason']])).toEqual([
        ['INVALID_SCAN', 'not-representable'],
      ]);
    }
  });

  it('rejects a non-digit add-on in a ]E3 string', () => {
    const r = tryFromScan(']E39506000134352A2');
    expect(r.ok ? [] : r.errors.map((e) => [e.code, e.details?.['reason']])).toEqual([
      ['INVALID_SCAN', 'payload'],
    ]);
  });
});
