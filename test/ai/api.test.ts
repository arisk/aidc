import { describe, expect, it } from 'vitest';
import { ElementString, Gs1Error, hri, parse, tryParse, validate } from '../../src/index.ts';

type R = ReturnType<typeof tryParse>;
const firstError = (r: R): Gs1Error | undefined => (r.ok ? undefined : r.errors[0]);
const codes = (r: R): string[] => (r.ok ? [] : r.errors.map((e) => e.code));

describe('parse / tryParse / validate', () => {
  it('parse returns an ElementString', () => {
    expect(parse('(01)09506000134352(10)ABC').gtin).toBe('09506000134352');
    expect(parse('^0109506000134352422250^10ABC').get('422')).toBe('250');
  });

  it('parse throws the first error', () => {
    expect(() => parse('(01)09506000134353(17)201232')).toThrow(
      expect.objectContaining({ code: 'CHECK_DIGIT' }),
    );
  });

  it('tryParse collects every error', () => {
    const r = tryParse('(01)09506000134353(17)201232(10)A(10)B');
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['CHECK_DIGIT', 'INVALID_DATE', 'DUPLICATE_AI']);
  });

  it('reports value and association errors together', () => {
    const r = tryParse('(10)A~');
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['INVALID_CHAR', 'MISSING_REQUIRED_AI']);
  });

  it('returns fatal syntax and empty-input errors alone', () => {
    const e = tryParse('');
    expect(e.ok).toBe(false);
    expect(codes(e)).toEqual(['EMPTY_INPUT']);
    const s = tryParse('(01');
    expect(s.ok).toBe(false);
    expect(codes(s)).toEqual(['SYNTAX']);
  });

  it('validate accepts strings, objects and ElementStrings', () => {
    expect(validate('(01)09506000134352').ok).toBe(true);
    expect(validate({ '01': '09506000134352' }).ok).toBe(true);
    const es = ElementString.from({ '01': '09506000134352' });
    expect(validate(es)).toEqual({ ok: true, value: es });
    const bad = validate({ '01': '0950600013435X' });
    expect(bad.ok).toBe(false);
    expect(firstError(bad)).toBeInstanceOf(Gs1Error);
  });

  it('validate re-checks an ElementString under stricter options', () => {
    const es = ElementString.from({ '0599': 'x' }, { allowUnknownAIs: true });
    expect(validate(es, { allowUnknownAIs: true }).ok).toBe(true);
    const r = validate(es);
    expect(r.ok).toBe(false);
    expect(codes(r)[0]).toBe('UNKNOWN_AI');
  });

  it('validate reports empty object input', () => {
    const r = validate({});
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['EMPTY_INPUT']);
  });

  it('validate reports non-AI-shaped keys', () => {
    for (const k of ['ab', '12345']) {
      const r = validate({ [k]: 'x' }, { allowUnknownAIs: true });
      expect(r.ok).toBe(false);
      expect(codes(r)[0]).toBe('UNKNOWN_AI');
    }
  });

  it('validateAssociations:false still reports DUPLICATE_AI', () => {
    const r = tryParse('(10)A(10)B', { validateAssociations: false });
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['DUPLICATE_AI']);
  });

  it('validateAssociations:false still reports invalid pairs (oracle regression)', () => {
    const r = tryParse('(01)09506000134352(02)09506000134352(37)1', {
      validateAssociations: false,
    });
    expect(codes(r)).toEqual(['INVALID_AI_PAIR', 'INVALID_AI_PAIR']);
  });

  it('validateAssociations:false still requires a serialised key with (8030) (oracle regression)', () => {
    const r = tryParse('(8003)00000000000000(8030)A', { validateAssociations: false });
    expect(codes(r)).toEqual(['INVALID_VALUE']);
  });

  it('validateAssociations:false skips only req rules', () => {
    expect(tryParse('(10)A', { validateAssociations: false }).ok).toBe(true);
  });

  it('object input reports positions relative to the value', () => {
    const r = validate({ '01': '09506000134353' });
    expect(r.ok).toBe(false);
    expect(firstError(r)?.position).toBe(13);
  });
});

describe('HRI input (ruling R14)', () => {
  it('parses hri() output joined with or without spaces', () => {
    const es = parse('(01)09506000134352(17)201225(10)ABC123(21)XYZ');
    expect(parse(hri(es).join(' ')).equals(es)).toBe(true);
    expect(parse(hri(es).join('')).equals(es)).toBe(true);
  });

  it('tryParse accepts spaces around AIs', () => {
    const r = tryParse('(01) 09506000134352 (10) ABC');
    expect(r.ok && r.value.entries()).toEqual([
      ['01', '09506000134352'],
      ['10', 'ABC'],
    ]);
  });
});

describe('error positions by input kind (ruling R15)', () => {
  it('object input: association errors have no position', () => {
    const missing = validate({ '10': 'ABC' });
    expect(firstError(missing)).toMatchObject({ code: 'MISSING_REQUIRED_AI', ai: '10' });
    expect(firstError(missing)?.position).toBeUndefined();

    const pair = validate({ '01': '09506000134352', '255': '0950600013439' });
    expect(firstError(pair)?.code).toBe('INVALID_AI_PAIR');
    expect(firstError(pair)?.position).toBeUndefined();

    const dup = validate([
      ['01', '09506000134352'],
      ['10', 'A'],
      ['10', 'B'],
    ]);
    expect(firstError(dup)?.code).toBe('DUPLICATE_AI');
    expect(firstError(dup)?.position).toBeUndefined();

    const sig = validate({ '8003': '00000000000000', '8030': 'A' });
    expect(firstError(sig)).toMatchObject({ code: 'INVALID_VALUE', ai: '8003' });
    expect(firstError(sig)?.position).toBeUndefined();

    let thrown: unknown;
    try {
      ElementString.from({ '10': 'ABC' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Gs1Error);
    expect(thrown instanceof Gs1Error && thrown.position).toBeUndefined();
  });

  it('object input: value errors keep their index into the value', () => {
    expect(firstError(validate({ '10': 'AB~' }))).toMatchObject({
      code: 'INVALID_CHAR',
      position: 2,
    });
  });

  it('string input: association errors index the input', () => {
    expect(firstError(tryParse('(01)09506000134352(10)A(10)B'))).toMatchObject({
      code: 'DUPLICATE_AI',
      position: 23,
    });
    expect(firstError(tryParse('(17)201225(10)A'))).toMatchObject({
      code: 'MISSING_REQUIRED_AI',
      position: 0,
    });
  });
});

/**
 * The API as a JavaScript caller sees it: any argument type. Method parameters are bivariant,
 * so the typed functions fit without a cast.
 */
interface Untyped {
  tryParse(input: unknown): R;
  parse(input: unknown): ElementString;
  validate(input: unknown): R;
  from(input: unknown): ElementString;
}
const js: Untyped = { tryParse, parse, validate, from: ElementString.from.bind(ElementString) };

describe('guards for JavaScript callers (F7)', () => {
  it('tryParse and parse reject non-strings with SYNTAX', () => {
    expect(codes(js.tryParse(42))).toEqual(['SYNTAX']);
    expect(() => js.parse(null)).toThrow(Gs1Error);
  });

  it('validate rejects non-objects with SYNTAX and non-string values with INVALID_VALUE', () => {
    expect(codes(js.validate(42))).toEqual(['SYNTAX']);
    expect(codes(js.validate(null))).toEqual(['SYNTAX']);
    expect(codes(js.validate({ '10': 123, '01': '09506000134352' }))).toEqual(['INVALID_VALUE']);
    expect(codes(js.validate([['01']]))).toEqual(['SYNTAX']);
    const r = js.validate([[1, 'x']]);
    expect(codes(r)).toEqual(['UNKNOWN_AI']);
    expect(firstError(r)?.ai).toBeUndefined();
  });

  it('ElementString.from throws Gs1Error, not TypeError', () => {
    for (const bad of [5, null, 'abc', [['01']], [42]]) {
      expect(() => js.from(bad)).toThrow(Gs1Error);
    }
  });

  it('validate accepts an iterable of pairs, in order', () => {
    const r = validate([
      ['10', 'ABC'],
      ['01', '09506000134352'],
    ]);
    expect(r.ok && r.value.entries()).toEqual([
      ['10', 'ABC'],
      ['01', '09506000134352'],
    ]);
    const m = new Map([
      ['01', '09506000134352'],
      ['10', 'ABC'],
    ]);
    expect(validate(m).ok).toBe(true);
  });
});
