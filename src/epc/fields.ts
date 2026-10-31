import type { AiValue } from '../ai/index.ts';
import type { PureSchemeName } from './descriptor.ts';

/**
 * The GS1 data of each scheme with a GS1 key, named as in the GS1 General Specifications and
 * `ElementString` (TDS section 7). The same for a legacy EPC and a plus EPC of the scheme.
 */
interface Gs1FieldsByScheme {
  /** (01) and (21). */
  readonly sgtin: { readonly gtin: string; readonly serial: string };
  /** (01) and (10). */
  readonly lgtin: { readonly gtin: string; readonly batch: string };
  /** (01) and (235). */
  readonly upui: { readonly gtin: string; readonly tpx: string };
  /** (8006), as its GTIN, piece and total, and (21). */
  readonly itip: {
    readonly gtin: string;
    readonly piece: string;
    readonly total: string;
    readonly serial: string;
  };
  /** (00). */
  readonly sscc: { readonly sscc: string };
  /** (414) and, when not 0, (254). */
  readonly sgln: { readonly gln: string; readonly extension?: string };
  /** (8003): '0', the 13-digit GRAI, then the serial. */
  readonly grai: { readonly grai: string; readonly serial: string };
  /** (8004). */
  readonly giai: { readonly giai: string };
  /** (8018). */
  readonly gsrn: { readonly gsrn: string };
  /** (8017). */
  readonly gsrnp: { readonly gsrnp: string };
  /** (253): the 13-digit GDTI, then the serial. */
  readonly gdti: { readonly gdti: string; readonly serial: string };
  /** (255): the 13-digit GCN, then the serial. */
  readonly sgcn: { readonly gcn: string; readonly serial: string };
  /** (8010) and (8011). */
  readonly cpi: { readonly cpid: string; readonly serial: string };
  /** (401). */
  readonly ginc: { readonly ginc: string };
  /** (402). */
  readonly gsin: { readonly gsin: string };
  /** (417). */
  readonly pgln: { readonly pgln: string };
}

/** Schemes without a GS1 key: their pure identity components by TDS name (TDS 6.3). */
interface OtherFieldsByScheme {
  readonly gid: {
    readonly generalManager: string;
    readonly objectClass: string;
    readonly serial: string;
  };
  readonly usdod: { readonly cageOrDodaac: string; readonly serial: string };
  readonly adi: {
    readonly cageOrDodaac: string;
    readonly partNumber: string;
    readonly serial: string;
  };
  readonly bic: { readonly containerCode: string };
  readonly imovn: { readonly vesselNumber: string };
}

export type Gs1SchemeName = keyof Gs1FieldsByScheme;

/** The `fields` of an EPC per scheme: its data by name, URI escapes removed. */
export type EpcFieldsByScheme = {
  readonly [S in Gs1SchemeName]: Gs1FieldsByScheme[S] & {
    /** Legacy EPCs: the GS1 Company Prefix. Plus EPCs do not encode one. */
    readonly companyPrefix?: string;
  };
} & OtherFieldsByScheme;

/** The `fields` of an EPC of scheme `S`. */
export type EpcFields<S extends PureSchemeName = PureSchemeName> = EpcFieldsByScheme[S];

/** TDS names of the components of the schemes without a GS1 key, in URI order. */
export const FIELD_NAMES: {
  readonly [S in keyof OtherFieldsByScheme]: readonly (keyof OtherFieldsByScheme[S])[];
} = {
  gid: ['generalManager', 'objectClass', 'serial'],
  usdod: ['cageOrDodaac', 'serial'],
  adi: ['cageOrDodaac', 'partNumber', 'serial'],
  bic: ['containerCode'],
  imovn: ['vesselNumber'],
};

type Lookup = (ai: string) => string;

const FROM_AIS: { readonly [S in Gs1SchemeName]: (v: Lookup) => Gs1FieldsByScheme[S] } = {
  sgtin: (v) => ({ gtin: v('01'), serial: v('21') }),
  lgtin: (v) => ({ gtin: v('01'), batch: v('10') }),
  upui: (v) => ({ gtin: v('01'), tpx: v('235') }),
  itip: (v) => {
    const k = v('8006');
    return { gtin: k.slice(0, 14), piece: k.slice(14, 16), total: k.slice(16), serial: v('21') };
  },
  sscc: (v) => ({ sscc: v('00') }),
  sgln: (v) => {
    const extension = v('254');
    return { gln: v('414'), ...(extension === '' || extension === '0' ? {} : { extension }) };
  },
  grai: (v) => ({ grai: v('8003').slice(1, 14), serial: v('8003').slice(14) }),
  giai: (v) => ({ giai: v('8004') }),
  gsrn: (v) => ({ gsrn: v('8018') }),
  gsrnp: (v) => ({ gsrnp: v('8017') }),
  gdti: (v) => ({ gdti: v('253').slice(0, 13), serial: v('253').slice(13) }),
  sgcn: (v) => ({ gcn: v('255').slice(0, 13), serial: v('255').slice(13) }),
  cpi: (v) => ({ cpid: v('8010'), serial: v('8011') }),
  ginc: (v) => ({ ginc: v('401') }),
  gsin: (v) => ({ gsin: v('402') }),
  pgln: (v) => ({ pgln: v('417') }),
};

export const isGs1Scheme = (s: PureSchemeName): s is Gs1SchemeName => Object.hasOwn(FROM_AIS, s);

/**
 * The fields of a GS1 scheme from its AIs (the pure identity's, or a plus EPC's body), with
 * the GS1 Company Prefix of a legacy EPC. Frozen.
 */
export function gs1Fields<S extends Gs1SchemeName>(
  scheme: S,
  ais: readonly AiValue[],
  companyPrefix?: string,
): EpcFields<S> {
  const v: Lookup = (ai) => ais.find(([a]) => a === ai)?.[1] ?? '';
  const out = Object.freeze({
    ...FROM_AIS[scheme](v),
    ...(companyPrefix === undefined ? {} : { companyPrefix }),
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- FROM_AIS[scheme] gives Gs1FieldsByScheme[S]
  return out as EpcFields<S>;
}
