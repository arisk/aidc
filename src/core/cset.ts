export const CSET82: string =
  '!"%&\'()*+,-./0123456789:;<=>?ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
export const CSET39: string = '#-/0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const CSET64: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const CSET32: string = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export type Cset = 'N' | 'X' | 'Y' | 'Z';

function table(chars: string): Uint8Array {
  const t = new Uint8Array(128);
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = 1;
  return t;
}

const TABLES: Readonly<Record<Cset, Uint8Array>> = {
  N: table('0123456789'),
  X: table(CSET82),
  Y: table(CSET39),
  Z: table(`${CSET64}=`),
};

export function firstInvalidChar(s: string, cset: Cset): number {
  const t = TABLES[cset];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 127 || t[c] === 0) return i;
  }
  return -1;
}

export function isDigits(s: string): boolean {
  return s.length > 0 && firstInvalidChar(s, 'N') === -1;
}
