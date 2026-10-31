/**
 * Tables of the GS1 Digital Link compression algorithm: DL Standard 1.1.4 chapter 2 (legacy
 * and frozen; GS1 Digital Link Compression 1.0.0 only adds the EPC "eh"/"ex" forms).
 */

export interface FComponent {
  readonly enc: 'N' | 'X';
  /** Fixed length, or the maximum length when `variable`. */
  readonly length: number;
  readonly variable: boolean;
}

/**
 * Table F (section 2.5.2, pp.18-23), transcribed from the PDF and checked against the page
 * images (docs/superpowers/research/m2-dl-compression-ref/tablef.mjs). "R:a-b" keys expand to
 * every AI from a to b. Do not derive this from the Syntax Dictionary: Table F is frozen and
 * differs from it, for example (8007) is X..24 here and X..34 there.
 */
const TABLE_F_ROWS: readonly (readonly string[])[] = [
  ['00', 'N18'],
  ['01', 'N14'],
  ['02', 'N14'],
  ['03', 'N14'],
  ['10', 'X..20'],
  ['11', 'N6'],
  ['12', 'N6'],
  ['13', 'N6'],
  ['15', 'N6'],
  ['16', 'N6'],
  ['17', 'N6'],
  ['20', 'N2'],
  ['21', 'X..20'],
  ['22', 'X..20'],
  ['235', 'X..28'],
  ['240', 'X..30'],
  ['241', 'X..30'],
  ['242', 'N..6'],
  ['243', 'X..20'],
  ['250', 'X..30'],
  ['251', 'X..30'],
  ['253', 'N13', 'X..17'],
  ['254', 'X..20'],
  ['255', 'N13', 'N..12'],
  ['30', 'N..8'],
  [
    'R:3100-3105,3110-3115,3120-3125,3130-3135,3140-3145,3150-3155,3160-3165,3200-3205,3210-3215,3220-3225,3230-3235,3240-3245,3250-3255,3260-3265,3270-3275,3280-3285,3290-3295,3300-3305,3310-3315,3320-3325,3330-3335,3340-3345,3350-3355,3360-3365,3370-3375,3400-3405,3410-3415,3420-3425,3430-3435,3440-3445,3450-3455,3460-3465,3470-3475,3480-3485,3490-3495,3500-3505,3510-3515,3520-3525,3530-3535,3540-3545,3550-3555,3560-3565,3570-3575,3600-3605,3610-3615,3620-3625,3630-3635,3640-3645,3650-3655,3660-3665,3670-3675,3680-3685,3690-3695',
    'N6',
  ],
  ['37', 'N..8'],
  ['R:3900-3909', 'N..15'],
  ['R:3910-3919', 'N3', 'N..15'],
  ['R:3920-3929', 'N..15'],
  ['R:3930-3939', 'N3', 'N..15'],
  ['R:3940-3943', 'N4'],
  ['R:3950-3955', 'N6'],
  ['400', 'X..30'],
  ['401', 'X..30'],
  ['402', 'N17'],
  ['403', 'X..30'],
  ['R:410-417', 'N13'],
  ['420', 'X..20'],
  ['421', 'N3', 'X..9'],
  ['422', 'N3'],
  ['423', 'N3', 'N..12'],
  ['424', 'N3'],
  ['425', 'N3', 'N..12'],
  ['426', 'N3'],
  ['427', 'X..3'],
  ['R:4300-4301', 'X..35'],
  ['R:4302-4306', 'X..70'],
  ['4307', 'X2'],
  ['4308', 'X..30'],
  ['4309', 'N20'],
  ['R:4310-4311', 'X..35'],
  ['R:4312-4316', 'X..70'],
  ['4317', 'X2'],
  ['4318', 'X..20'],
  ['4319', 'X..30'],
  ['4320', 'X..35'],
  ['R:4321-4323', 'N1'],
  ['R:4324-4325', 'N10'],
  ['4326', 'N6'],
  ['R:4330-4333', 'N6', 'X..1'],
  ['7001', 'N13'],
  ['7002', 'X..30'],
  ['7003', 'N10'],
  ['7004', 'N..4'],
  ['7005', 'X..12'],
  ['7006', 'N6'],
  ['7007', 'N6', 'N..6'],
  ['7008', 'X..3'],
  ['7009', 'X..10'],
  ['7010', 'X..2'],
  ['7011', 'N6', 'N..4'],
  ['7020', 'X..20'],
  ['7021', 'X..20'],
  ['7022', 'X..20'],
  ['7023', 'X..30'],
  ['R:7030-7039', 'N3', 'X..27'],
  ['7040', 'N1', 'X3'],
  ['7041', 'X..4'],
  ['R:710-717', 'X..20'],
  ['R:7230-7239', 'X..30'],
  ['7240', 'X..20'],
  ['7241', 'N2'],
  ['7242', 'X..25'],
  ['7250', 'N8'],
  ['7251', 'N12'],
  ['7252', 'N1'],
  ['7253', 'X..40'],
  ['7254', 'X..40'],
  ['7255', 'X..10'],
  ['7256', 'X..90'],
  ['7257', 'X..70'],
  ['7258', 'X3'],
  ['7259', 'X..40'],
  ['8001', 'N14'],
  ['8002', 'X..20'],
  ['8003', 'N14', 'X..16'],
  ['8004', 'X..30'],
  ['8005', 'N6'],
  ['8006', 'N18'],
  ['8007', 'X..24'],
  ['8008', 'N8', 'N..4'],
  ['8009', 'X..50'],
  ['8010', 'X..30'],
  ['8011', 'N..12'],
  ['8012', 'X..20'],
  ['8013', 'X..30'],
  ['8014', 'X..25'],
  ['8017', 'N18'],
  ['8018', 'N18'],
  ['8019', 'N..10'],
  ['8020', 'X..25'],
  ['8026', 'N18'],
  ['8030', 'X..90'],
  ['8040', 'N15'],
  ['8041', 'N15'],
  ['8042', 'N32'],
  ['8043', 'N18', 'N..2'],
  ['8110', 'X..70'],
  ['8111', 'N4'],
  ['8112', 'X..70'],
  ['8200', 'X..70'],
  ['90', 'X..30'],
  ['R:91-99', 'X..90'],
];

function parseComponent(spec: string): FComponent {
  const variable = spec.startsWith('..', 1);
  return {
    enc: spec.startsWith('N') ? 'N' : 'X',
    length: Number(spec.slice(variable ? 3 : 1)),
    variable,
  };
}

function expandTableF(): ReadonlyMap<string, readonly FComponent[]> {
  const out = new Map<string, readonly FComponent[]>();
  for (const [key = '', ...specs] of TABLE_F_ROWS) {
    const comps = Object.freeze(specs.map((s) => Object.freeze(parseComponent(s))));
    if (!key.startsWith('R:')) {
      out.set(key, comps);
      continue;
    }
    for (const range of key.slice(2).split(',')) {
      const [a = '', b = ''] = range.split('-');
      for (let n = Number(a); n <= Number(b); n++)
        out.set(String(n).padStart(a.length, '0'), comps);
    }
  }
  return out;
}

export const TABLE_F: ReadonlyMap<string, readonly FComponent[]> = /* @__PURE__ */ expandTableF();

/** Table P (section 2.5.3): AI length by its first two digits, derived from Table F. */
export const TABLE_P: ReadonlyMap<string, number> = /* @__PURE__ */ new Map(
  [...TABLE_F.keys()].map((ai) => [ai.slice(0, 2), ai.length] as const),
);

/** Table Opt (section 2.6): optimisation codes in ascending order (the order breaks ties). */
export const TABLE_OPT: ReadonlyArray<readonly [code: number, ais: readonly string[]]> = [
  [0x0a, ['01', '22']],
  [0x0b, ['01', '10']],
  [0x0c, ['01', '21']],
  [0x0d, ['01', '17']],
  [0x0e, ['01', '7003']],
  [0x0f, ['01', '30']],
  [0x1a, ['01', '10', '21', '17']],
  [0x1b, ['01', '15']],
  [0x1c, ['01', '11']],
  [0x1d, ['01', '16']],
  [0x1e, ['01', '91']],
  [0x1f, ['01', '10', '15']],
  [0x2a, ['01', '3100']],
  [0x2b, ['01', '3101']],
  [0x2c, ['01', '3102']],
  [0x2d, ['01', '3103']],
  [0x2e, ['01', '3104']],
  [0x2f, ['01', '3105']],
  [0x3a, ['01', '3200']],
  [0x3b, ['01', '3201']],
  [0x3c, ['01', '3202']],
  [0x3d, ['01', '3203']],
  [0x3e, ['01', '3204']],
  [0x3f, ['01', '3205']],
  [0x9a, ['8010', '8011']],
  [0x9b, ['8017', '8019']],
  [0x9c, ['8018', '8019']],
  [0x9d, ['414', '254']],
  [0xa0, ['01', '3920']],
  [0xa1, ['01', '3921']],
  [0xa2, ['01', '3922']],
  [0xa3, ['01', '3923']],
  [0xa4, ['01', '3924']],
  [0xa5, ['01', '3925']],
  [0xa6, ['01', '3926']],
  [0xa7, ['01', '3927']],
  [0xa8, ['01', '3928']],
  [0xa9, ['01', '3929']],
  [0xc0, ['255', '3900']],
  [0xc1, ['255', '3901']],
  [0xc2, ['255', '3902']],
  [0xc3, ['255', '3903']],
  [0xc4, ['255', '3904']],
  [0xc5, ['255', '3905']],
  [0xc6, ['255', '3906']],
  [0xc7, ['255', '3907']],
  [0xc8, ['255', '3908']],
  [0xc9, ['255', '3909']],
  [0xca, ['255', '3940']],
  [0xcb, ['255', '3941']],
  [0xcc, ['255', '3942']],
  [0xcd, ['255', '3943']],
];

export const OPT_BY_CODE: ReadonlyMap<number, readonly string[]> = /* @__PURE__ */ new Map(
  TABLE_OPT,
);

/** Bits of a length field for maximum length `max` (flowcharts C7/C9): bitLength(max). */
export function lengthBits(max: number): number {
  return 32 - Math.clz32(max);
}

/**
 * Bits of an L-digit integer (C6-C9, with the flowcharts' +0.01): 1 for L = 0 and 197 for
 * L = 59, where the exact bitLength(10^L - 1) would give 0 and 196.
 */
export function valueBits(digits: number): number {
  return Math.ceil((digits * Math.log(10)) / Math.log(2) + 0.01);
}
