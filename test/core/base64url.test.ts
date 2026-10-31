import { describe, expect, it } from 'vitest';
import {
  BASE64URL,
  base64urlIndex,
  base64urlToBits,
  bitsToBase64url,
  isBase64url,
} from '../../src/core/base64url.ts';

describe('base64url (RFC 4648 section 5)', () => {
  it('uses the URL-safe alphabet', () => {
    expect(BASE64URL).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_');
    expect([
      base64urlIndex(0x41),
      base64urlIndex(0x5f),
      base64urlIndex(0x2b),
      base64urlIndex(0x3d),
      base64urlIndex(0xe9),
    ]).toEqual([0, 63, -1, -1, -1]);
  });

  it('converts bit strings, right-padding with zeros, no "="', () => {
    expect(bitsToBase64url('000000111111')).toBe('A_');
    expect(bitsToBase64url('1')).toBe('g');
    expect(base64urlToBits('A_')).toBe('000000111111');
  });

  it('isBase64url', () => {
    expect(isBase64url('DBFKk4XBoAowOQ')).toBe(true);
    expect(['', 'a+b', 'a/b', 'ab=', 'a b'].filter((s) => isBase64url(s))).toEqual([]);
  });
});

describe('base64urlIndex outside ASCII', () => {
  it('gives -1 for code units of 128 and above', () => {
    expect(base64urlIndex(0xe9)).toBe(-1);
    expect(isBase64url('\u00e9')).toBe(false);
  });
});
