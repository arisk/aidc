import { describe, expect, it } from 'vitest';
import { BitReader, BitWriter } from '../../src/core/bits.ts';

describe('BitWriter', () => {
  it('writes MSB first, zero padded to the width', () => {
    const w = new BitWriter();
    w.write(1, 4);
    w.write(0b101, 3);
    w.write(10614141123459n, 47);
    expect(w.toString()).toBe('0001101' + 10614141123459n.toString(2).padStart(47, '0'));
    expect(w.length).toBe(54);
  });

  it('rejects values that do not fit and bad widths', () => {
    const w = new BitWriter();
    expect(() => w.write(16, 4)).toThrow(RangeError);
    expect(() => w.write(-1, 4)).toThrow(RangeError);
    expect(() => w.write(0, 0)).toThrow(RangeError);
  });
});

describe('BitReader', () => {
  it('reads numbers and bigints and tracks position', () => {
    const r = new BitReader('0001101111');
    expect(r.read(4)).toBe(1);
    expect(r.readBig(3)).toBe(5n);
    expect([r.position, r.remaining, r.rest()]).toEqual([7, 3, '111']);
  });

  it('throws RangeError past the end', () => {
    const r = new BitReader('01');
    expect(() => r.read(3)).toThrow(RangeError);
    expect(() => r.readBig(3)).toThrow(RangeError);
  });
});

describe('BitReader zero widths', () => {
  it('reads zero bits as zero without consuming', () => {
    const r = new BitReader('101');
    expect(r.read(0)).toBe(0);
    expect(r.readBig(0)).toBe(0n);
    expect(r.remaining).toBe(3);
  });
});
