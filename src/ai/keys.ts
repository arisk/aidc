import { isValidCheckDigit } from '../core/check-digit.ts';

export type GS1KeyType = 'gtin' | 'sscc' | 'gln' | 'gsin' | 'gsrn-provider' | 'gsrn-recipient';

export interface KeyCandidate {
  readonly key: GS1KeyType;
  readonly ai: '01' | '00' | '414' | '402' | '8017' | '8018';
  readonly value: string;
  readonly confidence: number;
}

export function identifyKey(input: string): KeyCandidate[] {
  if (typeof input !== 'string') return [];
  const s = input.trim();
  if (!isValidCheckDigit(s)) return [];
  switch (s.length) {
    case 8:
    case 12:
    case 14:
      return [{ key: 'gtin', ai: '01', value: s.padStart(14, '0'), confidence: 1 }];
    case 13:
      return [
        { key: 'gtin', ai: '01', value: s.padStart(14, '0'), confidence: 0.7 },
        { key: 'gln', ai: '414', value: s, confidence: 0.3 },
      ];
    case 17:
      return [{ key: 'gsin', ai: '402', value: s, confidence: 1 }];
    case 18:
      return [
        { key: 'sscc', ai: '00', value: s, confidence: 0.8 },
        { key: 'gsrn-provider', ai: '8017', value: s, confidence: 0.1 },
        { key: 'gsrn-recipient', ai: '8018', value: s, confidence: 0.1 },
      ];
    default:
      return [];
  }
}
