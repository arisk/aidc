import { describe, expect, it } from 'vitest';
import { DM_POLY, QR_POLY, gf256, gfMul } from '../../src/core/gf256.ts';

describe('gf256', () => {
  it('builds the 0x12d antilog table', () => {
    const f = gf256(0x12d);
    expect(Array.from(f.exp.slice(0, 10))).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 45, 90]);
    expect(f.poly).toBe(0x12d);
    expect(f.exp.length).toBe(512);
    expect(f.log.length).toBe(256);
  });

  it('doubles the exp table and inverts it with log', () => {
    for (const poly of [DM_POLY, QR_POLY]) {
      const f = gf256(poly);
      for (let i = 0; i < 255; i++) {
        expect(f.exp[i]).toBe(f.exp[i + 255]);
        expect(f.log[f.exp[i] ?? 0]).toBe(i % 255);
      }
    }
  });

  it('exposes the two polynomials and memoises', () => {
    expect(DM_POLY).toBe(0x12d);
    expect(QR_POLY).toBe(0x11d);
    expect(gf256(DM_POLY)).toBe(gf256(0x12d));
    expect(gf256(QR_POLY)).not.toBe(gf256(DM_POLY));
    expect(gf256(QR_POLY).exp[8]).toBe(29);
  });

  it.each([0x100, 0x1ff, 0x11b, 0xff, 0x200, -1, 0x12d + 0.5, Number.NaN])('rejects %s', (poly) => {
    expect(() => gf256(poly)).toThrow(
      expect.objectContaining({ code: 'INVALID_VALUE', details: { option: 'poly', value: poly } }),
    );
  });

  it('multiplies', () => {
    const f = gf256(DM_POLY);
    expect(gfMul(f, 0, 77)).toBe(0);
    expect(gfMul(f, 77, 0)).toBe(0);
    expect(gfMul(f, 1, 77)).toBe(77);
    expect(gfMul(f, 128, 2)).toBe(45);
    for (let a = 1; a < 256; a += 7) {
      for (let b = 1; b < 256; b += 11) expect(gfMul(f, a, b)).toBe(gfMul(f, b, a));
    }
  });
});
