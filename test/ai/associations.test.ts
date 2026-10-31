import { describe, expect, it } from 'vitest';
import { checkAssociations } from '../../src/ai/associations.ts';

const el = (...pairs: Array<[string, string]>) =>
  pairs.map(([ai, value], position) => ({ ai, value, position }));
const codes = (...pairs: Array<[string, string]>) =>
  checkAssociations(el(...pairs)).map((e) => [e.code, e.ai]);

describe('checkAssociations', () => {
  it('passes a valid combination', () => {
    expect(codes(['01', '09506000134352'], ['17', '201225'], ['10', 'ABC'])).toEqual([]);
  });

  it('reports missing required AIs with the Syntax Engine message', () => {
    const errs = checkAssociations(el(['10', 'ABC']));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ code: 'MISSING_REQUIRED_AI', ai: '10' });
    expect(errs[0]?.message).toBe('Required AIs for AI (10) are not satisfied: 01,02,03,8006,8026');
  });

  it('supports AND groups (req=01+10)', () => {
    expect(codes(['01', '09506000134352'], ['7004', '12'])).toEqual([
      ['MISSING_REQUIRED_AI', '7004'],
    ]);
    expect(codes(['01', '09506000134352'], ['10', 'A'], ['7004', '12'])).toEqual([]);
  });

  it('every req rule must hold (37: req=00 req=02,8026)', () => {
    expect(codes(['00', '006141411234567890'], ['37', '5'])).toEqual([
      ['MISSING_REQUIRED_AI', '37'],
    ]);
  });

  it('supports wildcard patterns in req', () => {
    expect(codes(['01', '09506000134352'], ['3103', '000500'], ['3922', '100'])).toEqual([]);
  });

  it('reports invalid pairs once, with patterns', () => {
    const errs = checkAssociations(
      el(['01', '09506000134352'], ['3103', '000500'], ['3102', '000500']),
    );
    expect(errs.map((e) => e.code)).toEqual(['INVALID_AI_PAIR']);
    expect(errs[0]?.message).toBe('It is invalid to pair AI (3103) with AI (3102)');
  });

  it('an AI is not exclusive of itself (Review Focus 5)', () => {
    expect(codes(['01', '09506000134352'], ['3103', '000500'], ['3103', '000500'])).toEqual([]);
  });

  it('conflicting duplicates fail, identical duplicates pass (Review Focus 5)', () => {
    expect(codes(['01', '09506000134352'], ['10', 'ABC'], ['10', 'ABD'])).toEqual([
      ['DUPLICATE_AI', '10'],
    ]);
    expect(codes(['01', '09506000134352'], ['10', 'ABC'], ['10', 'ABC'])).toEqual([]);
  });

  it('reports a conflicting duplicate AI only once', () => {
    expect(codes(['01', '09506000134352'], ['10', 'A'], ['10', 'B'], ['10', 'C'])).toEqual([
      ['DUPLICATE_AI', '10'],
    ]);
  });

  it('skips rules for unknown AIs', () => {
    expect(codes(['89', 'X'])).toEqual([]);
  });

  it('handles 2,000 identical elements quickly', () => {
    const pairs: Array<[string, string]> = [['01', '09506000134352']];
    for (let i = 0; i < 2000; i++) pairs.push(['91', 'ABC']);
    const input = el(...pairs);
    const start = performance.now();
    const errs = checkAssociations(input);
    const ms = performance.now() - start;
    expect(errs).toEqual([]);
    expect(ms).toBeLessThan(100);
  });
});

describe('digital signature (8030) needs a serialised key (oracle regressions)', () => {
  it('rejects (8003) without its serial component', () => {
    const errs = checkAssociations(el(['8003', '00000000000000'], ['8030', 'A']));
    expect(errs.map((e) => [e.code, e.ai, e.message])).toEqual([
      [
        'INVALID_VALUE',
        '8003',
        'Serial component must be present for AI (8003) when used with AI (8030)',
      ],
    ]);
  });

  it('rejects (253) and (255) without serial components', () => {
    expect(codes(['253', '0000000000000'], ['255', '0000000000000'], ['8030', 'A'])).toEqual([
      ['INVALID_VALUE', '253'],
      ['INVALID_VALUE', '255'],
    ]);
  });

  it('accepts serialised keys and keys without (8030)', () => {
    expect(codes(['8003', '000000000000001'], ['8030', 'A'])).toEqual([]);
    expect(codes(['253', '0000000000000X'], ['8030', 'A'])).toEqual([]);
    expect(codes(['8003', '00000000000000'])).toEqual([]);
  });
});

describe('requisites option', () => {
  it('requisites:false skips req rules but keeps exclusions (oracle regression)', () => {
    const errs = checkAssociations(el(['01', '09506000134352'], ['02', '09506000134352']), {
      requisites: false,
    });
    expect(errs.map((e) => [e.code, e.ai])).toEqual([['INVALID_AI_PAIR', '02']]);
  });
});
