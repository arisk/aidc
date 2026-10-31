import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/ai/parse.ts';

const GS = '\u001d';
const t = (s: string, allowUnknownAIs = false) => tokenize(s, { allowUnknownAIs });
const pairs = (s: string) => t(s).elements.map((e) => [e.ai, e.value]);

describe('bracketed', () => {
  it('parses AIs and values with positions', () => {
    const r = t('(01)09506000134352(17)201225(10)ABC123');
    expect(r.errors).toEqual([]);
    expect(r.elements).toEqual([
      { ai: '01', value: '09506000134352', position: 0 },
      { ai: '17', value: '201225', position: 18 },
      { ai: '10', value: 'ABC123', position: 28 },
    ]);
  });

  it('unescapes \\( inside values (Review Focus 1)', () => {
    expect(pairs('(01)09506000134352(10)AB\\(C)(21)XYZ')).toEqual([
      ['01', '09506000134352'],
      ['10', 'AB(C)'],
      ['21', 'XYZ'],
    ]);
  });

  it('collects value errors and keeps going', () => {
    const r = t('(01)09506000134353(17)201232');
    expect(r.errors.map((e) => [e.code, e.ai, e.position])).toEqual([
      ['CHECK_DIGIT', '01', 17],
      ['INVALID_DATE', '17', 26],
    ]);
  });

  it('unknown AIs fail unless allowed', () => {
    expect(t('(89)ABC').errors[0]).toMatchObject({ code: 'UNKNOWN_AI', ai: '89', position: 0 });
    expect(t('(89)ABC', true).errors).toEqual([]);
    expect(t('(9999)X', true).errors[0]).toMatchObject({ code: 'UNKNOWN_AI' });
  });
});

describe('raw', () => {
  it('parses GS separated data', () => {
    expect(pairs(`0109506000134352${GS}10ABC${GS}17201225`)).toEqual([
      ['01', '09506000134352'],
      ['10', 'ABC'],
      ['17', '201225'],
    ]);
    expect(pairs(`${GS}010950600013435210ABC`)).toEqual([
      ['01', '09506000134352'],
      ['10', 'ABC'],
    ]);
  });

  it('parses ^ as FNC1', () => {
    expect(pairs('^0109506000134352422250^10ABC')).toEqual([
      ['01', '09506000134352'],
      ['422', '250'],
      ['10', 'ABC'],
    ]);
  });

  it('tolerates a superfluous GS after a predefined-length AI (Review Focus 2)', () => {
    expect(pairs(`0109506000134352${GS}10ABC`)).toEqual([
      ['01', '09506000134352'],
      ['10', 'ABC'],
    ]);
  });

  it('a non-predefined fixed-length AI must be followed by GS (Review Focus 2)', () => {
    expect(t('^010950600013435242225010ABC').errors[0]).toMatchObject({
      code: 'INVALID_LENGTH',
      ai: '422',
    });
  });

  it('reports positions in the original input for ^ data', () => {
    expect(t('^01095060001343521').errors[0]).toMatchObject({ code: 'UNKNOWN_AI', position: 17 });
  });

  it('fails on unknown AIs and truncated predefined values', () => {
    expect(t('0109506000134352891').errors[0]).toMatchObject({ code: 'UNKNOWN_AI', position: 16 });
    expect(t('01095060001343').errors[0]).toMatchObject({ code: 'INVALID_LENGTH', ai: '01' });
  });
});

describe('malformed input (Review Focus 4)', () => {
  it.each([
    ['', 'EMPTY_INPUT'],
    ['   ', 'SYNTAX'],
    ['()', 'SYNTAX'],
    ['(01', 'SYNTAX'],
    ['(ABC)1', 'SYNTAX'],
    ['(1)1', 'SYNTAX'],
    ['(12345)1', 'SYNTAX'],
    ['x01', 'SYNTAX'],
    ['^', 'EMPTY_INPUT'],
  ])('%j gives %s', (input, code) => {
    const r = t(input);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.code).toBe(code);
  });

  it('an empty value is INVALID_LENGTH', () => {
    expect(t('(01)09506000134352(10)').errors[0]).toMatchObject({
      code: 'INVALID_LENGTH',
      ai: '10',
    });
  });
});

describe('non-ASCII and long input (Review Focus 3 and 5)', () => {
  it('reports non-ASCII characters by position', () => {
    expect(t('(10)AB\u{1F600}').errors[0]).toMatchObject({ code: 'INVALID_CHAR', position: 6 });
    expect(t('(10)A\u0000').errors[0]).toMatchObject({ code: 'INVALID_CHAR', position: 5 });
  });

  it('handles 10,000 characters quickly', () => {
    const input = '(91)ABC'.repeat(1429);
    const start = performance.now();
    const r = t(input);
    expect(r.elements).toHaveLength(1429);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

const errs = (s: string) => t(s, true).errors.map((e) => e.code);

describe('unknown AIs follow the Syntax Engine permitUnknownAIs rules (oracle regressions)', () => {
  it('requires the AI length shared by known AIs with the same two-digit prefix', () => {
    expect(errs('(2399)X')).toEqual(['UNKNOWN_AI']);
    expect(errs('(31)0')).toEqual(['UNKNOWN_AI']);
    expect(errs('(239)X')).toEqual([]);
    expect(errs('(8999)X')).toEqual([]);
  });

  it('applies the GenSpecs Table 7-6 predefined lengths under 41 and 31 to 36', () => {
    expect(errs('(419)ABC')).toEqual(['INVALID_LENGTH']);
    expect(errs('(419)ABCDEFGHIJKLM')).toEqual([]);
    expect(errs('(3170)12345')).toEqual(['INVALID_LENGTH']);
    expect(errs('(3170)AB3456')).toEqual([]);
  });

  it('counts the AI within 90 characters when no known AI shares the prefix', () => {
    expect(errs(`(05)${'A'.repeat(88)}`)).toEqual([]);
    expect(errs(`(05)${'A'.repeat(89)}`)).toEqual(['INVALID_LENGTH']);
    expect(errs(`(0599)${'A'.repeat(86)}`)).toEqual([]);
    expect(errs(`(0599)${'A'.repeat(87)}`)).toEqual(['INVALID_LENGTH']);
    expect(errs(`(239)${'A'.repeat(90)}`)).toEqual([]);
  });

  it('reads unknown AIs from raw data only when the prefix fixes their length', () => {
    expect(t('^4190000000000000', true).elements).toEqual([
      { ai: '419', value: '0000000000000', position: 1 },
    ]);
    expect(t('^239AB^10X', true).elements.map((e) => [e.ai, e.value])).toEqual([
      ['239', 'AB'],
      ['10', 'X'],
    ]);
    expect(errs('^89ABC')).toEqual(['UNKNOWN_AI']);
    expect(t('^4190000000000000').errors.map((e) => e.code)).toEqual(['UNKNOWN_AI']);
  });
});

describe('leading separators (oracle regressions)', () => {
  it('accepts exactly one leading "^" or GS', () => {
    expect(t('^0109506000134352').errors).toEqual([]);
    expect(t(`${GS}0109506000134352`).errors).toEqual([]);
    expect(t('^^0109506000134352').errors.map((e) => [e.code, e.position])).toEqual([
      ['UNKNOWN_AI', 1],
    ]);
    expect(t(`${GS}${GS}0109506000134352`).errors.map((e) => [e.code, e.position])).toEqual([
      ['UNKNOWN_AI', 1],
    ]);
  });

  it('rejects "^^" as an unknown AI and a lone separator as empty input', () => {
    expect(t('^^').errors.map((e) => e.code)).toEqual(['UNKNOWN_AI']);
    expect(t('^').errors.map((e) => e.code)).toEqual(['EMPTY_INPUT']);
    expect(t(GS).errors.map((e) => e.code)).toEqual(['EMPTY_INPUT']);
  });
});

const err = (s: string) => t(s).errors.map((e) => [e.code, e.position, e.length]);

describe('error positions after \\( escapes (F3)', () => {
  it('maps an error after escapes back to the input', () => {
    expect(err('(10)\\(\\(\\(é')).toEqual([['INVALID_CHAR', 10, 1]]);
  });

  it('two escapes in a row, then an error', () => {
    expect(err('(10)\\(\\(~')).toEqual([['INVALID_CHAR', 8, 1]]);
  });

  it('an escape at the end of a value does not shift the next element', () => {
    expect(err('(01)09506000134352(10)A\\((21)~')).toEqual([['INVALID_CHAR', 29, 1]]);
  });

  it('an error on the escaped "(" spans both input characters', () => {
    expect(err('(20)\\(1')).toEqual([['INVALID_CHAR', 4, 2]]);
  });

  it('a length error covers the escaped value in input characters', () => {
    expect(err(`(10)${'A'.repeat(19)}\\(\\(`)).toEqual([['INVALID_LENGTH', 4, 23]]);
  });

  it('an error before any escape is unchanged', () => {
    expect(err('(10)~\\(')).toEqual([['INVALID_CHAR', 4, 1]]);
  });
});

describe('HRI spaces around AIs (ruling R14, F4)', () => {
  it('skips spaces after ")" and before "(" and at the end', () => {
    const r = t('(01) 09506000134352 (10)  ABC ');
    expect(r.errors).toEqual([]);
    expect(r.elements).toEqual([
      { ai: '01', value: '09506000134352', position: 0 },
      { ai: '10', value: 'ABC', position: 20 },
    ]);
  });

  it('keeps positions on the original input', () => {
    expect(t('(01) 09506000134353 (10)A').errors[0]).toMatchObject({
      code: 'CHECK_DIGIT',
      position: 18,
    });
  });

  it('a space inside a value is still INVALID_CHAR', () => {
    expect(t('(10)AB CD').errors[0]).toMatchObject({ code: 'INVALID_CHAR', position: 6 });
    expect(t('(10) AB CD (21)1').errors[0]).toMatchObject({ code: 'INVALID_CHAR', position: 7 });
  });

  it('only spaces between AIs leaves an empty value', () => {
    expect(t('(10) (21)1').errors[0]).toMatchObject({ code: 'INVALID_LENGTH', position: 5 });
  });

  it('a space inside the AI brackets is a syntax error', () => {
    expect(t('( 10)A').errors[0]?.code).toBe('SYNTAX');
  });
});

describe('error collection (F7)', () => {
  it('a SYNTAX error keeps errors collected before it', () => {
    expect(t('(01)09506000134353(10)ABC(x)').errors.map((e) => e.code)).toEqual([
      'CHECK_DIGIT',
      'SYNTAX',
    ]);
  });

  it('raw UNKNOWN_AI carries the examined length and no ai', () => {
    expect(t('^01095060001343521').errors[0]).toMatchObject({ position: 17, length: 1 });
    expect(t('0109506000134352891').errors[0]).toMatchObject({ position: 16, length: 3 });
    const e = t('^89123').errors[0];
    expect(e).toMatchObject({ code: 'UNKNOWN_AI', position: 1, length: 4 });
    expect(e?.ai).toBeUndefined();
  });
});
