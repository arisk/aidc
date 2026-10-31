import { describe, expect, it } from 'vitest';
import { Gs1Error, fail, ok, unwrap } from '../../src/core/index.ts';
import { guard, placeError, shiftError } from '../../src/core/errors.ts';

describe('Gs1Error', () => {
  it('carries code, ai, position, length and details', () => {
    const e = new Gs1Error({
      code: 'CHECK_DIGIT',
      message: 'bad',
      ai: '01',
      position: 17,
      length: 1,
      details: { lint: 'INCORRECT_CHECK_DIGIT' },
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('Gs1Error');
    expect(e.message).toBe('bad');
    expect(e.code).toBe('CHECK_DIGIT');
    expect(e.ai).toBe('01');
    expect(e.position).toBe(17);
    expect(e.length).toBe(1);
    expect(e.details).toEqual({ lint: 'INCORRECT_CHECK_DIGIT' });
  });

  it('leaves optional fields undefined', () => {
    const e = new Gs1Error({ code: 'SYNTAX', message: 'x' });
    expect(e.ai).toBeUndefined();
    expect(e.position).toBeUndefined();
    expect(e.length).toBeUndefined();
    expect(e.details).toBeUndefined();
  });
});

describe('Result helpers', () => {
  it('ok and unwrap', () => {
    const r = ok(42);
    expect(r).toEqual({ ok: true, value: 42 });
    expect(unwrap(r)).toBe(42);
  });

  it('fail and unwrap throws the first error', () => {
    const a = new Gs1Error({ code: 'SYNTAX', message: 'first' });
    const b = new Gs1Error({ code: 'SYNTAX', message: 'second' });
    const r = fail<number>([a, b]);
    expect(r.ok).toBe(false);
    expect(() => unwrap(r)).toThrow(a);
  });

  it('fail with no errors is a programming error', () => {
    expect(() => fail([])).toThrow(TypeError);
  });
});

describe('guard', () => {
  it('passes a Result through', () => {
    expect(guard(() => ok(1))).toEqual({ ok: true, value: 1 });
  });

  it('returns a thrown Gs1Error as the failure', () => {
    const e = new Gs1Error({ code: 'CHECK_DIGIT', message: 'bad' });
    const r = guard<number>(() => {
      throw e;
    });
    expect(r.ok).toBe(false);
    expect(r).toEqual({ ok: false, errors: [e] });
  });

  it('turns anything else thrown into SYNTAX (argument)', () => {
    const thrown = [new TypeError('x'), 'text', null, undefined, 42];
    // A Proxy whose prototype lookup throws makes even `instanceof` throw.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('no prototype for you');
        },
      },
    );
    const outcomes = [...thrown, hostile].map((value) => {
      const r = guard<number>(() => {
        throw value;
      });
      return r.ok ? r.value : r.errors.map((e) => [e.code, e.details]);
    });
    expect(outcomes).toEqual(
      Array.from({ length: thrown.length + 1 }, () => [['SYNTAX', { reason: 'argument' }]]),
    );
  });
});

describe('shiftError and placeError', () => {
  const e = new Gs1Error({
    code: 'CHECK_DIGIT',
    message: 'bad',
    ai: '01',
    position: 15,
    length: 1,
    details: { lint: 'INCORRECT_CHECK_DIGIT' },
  });

  it('shiftError moves the position and keeps everything else', () => {
    const s = shiftError(e, 3);
    expect(s).toBeInstanceOf(Gs1Error);
    expect([s.code, s.message, s.ai, s.position, s.length, s.details]).toEqual([
      'CHECK_DIGIT',
      'bad',
      '01',
      18,
      1,
      { lint: 'INCORRECT_CHECK_DIGIT' },
    ]);
  });

  it('shiftError leaves an error without position unpositioned', () => {
    const s = shiftError(new Gs1Error({ code: 'MISSING_REQUIRED_AI', message: 'm' }), 3);
    expect(s.position).toBeUndefined();
    expect(s.ai).toBeUndefined();
  });

  it('placeError sets position and length', () => {
    const p = placeError(e, 40, 12);
    expect([p.position, p.length, p.code, p.ai]).toEqual([40, 12, 'CHECK_DIGIT', '01']);
  });

  it('accepts the new codes', () => {
    for (const code of ['INVALID_DIGITAL_LINK', 'INVALID_SCAN', 'UNSUPPORTED'] as const) {
      expect(new Gs1Error({ code, message: code }).code).toBe(code);
    }
  });

  it('accepts the EPC codes', () => {
    for (const code of [
      'INVALID_EPC',
      'EPC_FIELD_OVERFLOW',
      'EPC_UNKNOWN_HEADER',
      'GCP_LENGTH_UNKNOWN',
    ] as const) {
      expect(new Gs1Error({ code, message: code }).code).toBe(code);
    }
  });
});
