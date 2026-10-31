/**
 * EAN/UPC encoding tables (GenSpecs 26.0 Tables 5-3 to 5-9). Widths are element widths in
 * modules in reading order. Set C has the same numbers as set A, because the colours alternate
 * along the whole symbol (a set C character starts with a bar).
 */

/** Set A (odd parity, starts with a space). */
export const SET_A: readonly string[] = [
  '3211',
  '2221',
  '2122',
  '1411',
  '1132',
  '1231',
  '1114',
  '1312',
  '1213',
  '3112',
];

/** Set B (even parity, starts with a space). */
export const SET_B: readonly string[] = [
  '1123',
  '1222',
  '2212',
  '1141',
  '2311',
  '1321',
  '4111',
  '2131',
  '3121',
  '2113',
];

/** EAN-13 left-half number sets by leading digit (Table 5-5). */
export const EAN13_PARITY: readonly string[] = [
  'AAAAAA',
  'AABABB',
  'AABBAB',
  'AABBBA',
  'ABAABB',
  'ABBAAB',
  'ABBBAA',
  'ABABAB',
  'ABABBA',
  'ABBABA',
];

/** UPC-E number sets by check digit, number system 0 (Table 5-6). */
export const UPCE_PARITY: readonly string[] = [
  'BBBAAA',
  'BBABAA',
  'BBAABA',
  'BBAAAB',
  'BABBAA',
  'BAABBA',
  'BAAABB',
  'BABABA',
  'BABAAB',
  'BAABAB',
];

/** 2-digit add-on number sets by value mod 4 (Table 5-8). */
export const ADDON2_PARITY: readonly string[] = ['AA', 'AB', 'BA', 'BB'];

/** 5-digit add-on number sets by checksum V (Table 5-9). */
export const ADDON5_PARITY: readonly string[] = [
  'BBAAA',
  'BABAA',
  'BAABA',
  'BAAAB',
  'ABBAA',
  'AABBA',
  'AAABB',
  'ABABA',
  'ABAAB',
  'AABAB',
];

/** Start and stop guard (bar first). */
export const NORMAL_GUARD: readonly number[] = [1, 1, 1];
/** Centre guard (starts with a space). */
export const CENTRE_GUARD: readonly number[] = [1, 1, 1, 1, 1];
/** UPC-E special stop guard (starts with a space). */
export const UPCE_GUARD: readonly number[] = [1, 1, 1, 1, 1, 1];
/** Add-on guard (bar first). */
export const ADDON_GUARD: readonly number[] = [1, 1, 2];
/** Add-on character delineator (starts with a space). */
export const ADDON_DELINEATOR: readonly number[] = [1, 1];
