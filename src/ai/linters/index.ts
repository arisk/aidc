import { cset39, cset64, cset82, csetnumeric, hasnondigit, nozeroprefix } from './charset.ts';
import { hh, hhmi, mi, ss, yymmd0, yymmdd, yyyymmd0, yyyymmdd } from './datetime.ts';
import {
  hyphen,
  importeridx,
  iso3166,
  iso3166999,
  iso3166alpha2,
  iso4217,
  iso5218,
  mediatype,
  nonzero,
  packagetype,
  winding,
  yesno,
  zero,
} from './codes.ts';
import { csum, csumalpha, gcppos1, gcppos2 } from './checksum.ts';
import { couponcode, couponposoffer } from './coupon.ts';
import { iban, latitude, longitude, pcenc, pieceoftotal, posinseqslash } from './structured.ts';
import type { Linter } from './types.ts';

export type LinterName =
  | 'csetnumeric'
  | 'cset82'
  | 'cset39'
  | 'cset64'
  | 'hasnondigit'
  | 'nozeroprefix'
  | 'csum'
  | 'csumalpha'
  | 'gcppos1'
  | 'gcppos2'
  | 'yyyymmd0'
  | 'yyyymmdd'
  | 'yymmd0'
  | 'yymmdd'
  | 'hh'
  | 'mi'
  | 'ss'
  | 'hhmi'
  | 'iso3166'
  | 'iso3166999'
  | 'iso3166alpha2'
  | 'iso4217'
  | 'iso5218'
  | 'mediatype'
  | 'packagetype'
  | 'importeridx'
  | 'winding'
  | 'yesno'
  | 'zero'
  | 'nonzero'
  | 'hyphen'
  | 'pcenc'
  | 'iban'
  | 'latitude'
  | 'longitude'
  | 'pieceoftotal'
  | 'posinseqslash'
  | 'couponcode'
  | 'couponposoffer';

export const LINTERS: Readonly<Record<LinterName, Linter>> = {
  csetnumeric,
  cset82,
  cset39,
  cset64,
  hasnondigit,
  nozeroprefix,
  csum,
  csumalpha,
  gcppos1,
  gcppos2,
  yyyymmd0,
  yyyymmdd,
  yymmd0,
  yymmdd,
  hh,
  mi,
  ss,
  hhmi,
  iso3166,
  iso3166999,
  iso3166alpha2,
  iso4217,
  iso5218,
  mediatype,
  packagetype,
  importeridx,
  winding,
  yesno,
  zero,
  nonzero,
  hyphen,
  pcenc,
  iban,
  latitude,
  longitude,
  pieceoftotal,
  posinseqslash,
  couponcode,
  couponposoffer,
};

export function isLinterName(s: string): s is LinterName {
  return Object.hasOwn(LINTERS, s);
}

export type { LintError, LintResult, Linter } from './types.ts';
export type { LintCode } from './lint-codes.gen.ts';
export { LINT_MESSAGES } from './lint-codes.gen.ts';
