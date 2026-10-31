import { describe, expect, it } from 'vitest';
import { ElementString } from '../../../src/ai/index.ts';
import { gtinInput } from '../../../src/symbology/linear/gtin-input.ts';

function failure(data: unknown) {
  const r = gtinInput(data, 'ean-13');
  if (r.ok) throw new Error('expected failure');
  return r.errors[0];
}

describe('gtinInput', () => {
  it.each([
    '9506000134352',
    '09506000134352',
    '(01)09506000134352',
    '(01) 09506000134352',
    ElementString.from({ '01': '09506000134352' }),
  ])('normalises %s to a GTIN-14', (input) => {
    const r = gtinInput(input, 'ean-13');
    expect(r).toEqual({ ok: true, value: '09506000134352' });
  });

  it('pads 8 and 12 digit GTINs', () => {
    expect(gtinInput('96385074', 'ean-8')).toEqual({ ok: true, value: '00000096385074' });
    expect(gtinInput('012345678905', 'upc-a')).toEqual({ ok: true, value: '00012345678905' });
  });

  it('reports a wrong check digit with ai 01', () => {
    const e = failure('9506000134353');
    expect(e?.code).toBe('CHECK_DIGIT');
    expect(e?.ai).toBe('01');
    expect(failure('(01)09506000134353')?.code).toBe('CHECK_DIGIT');
  });

  it('rejects other elements as NOT_REPRESENTABLE', () => {
    const e = failure('(01)09506000134352(10)A');
    expect(e?.code).toBe('NOT_REPRESENTABLE');
    expect(e?.details?.['symbology']).toBe('ean-13');
    expect(failure(ElementString.from({ '01': '09506000134352', '10': 'A' }))?.code).toBe(
      'NOT_REPRESENTABLE',
    );
  });

  it('rejects other types as INVALID_VALUE', () => {
    expect(failure(42)?.code).toBe('INVALID_VALUE');
    expect(failure(null)?.code).toBe('INVALID_VALUE');
  });

  it('parses digit strings of other lengths as element strings', () => {
    expect(gtinInput('12345', 'ean-13').ok).toBe(false);
  });
});
