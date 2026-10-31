# aidc

aidc is an independent project, not affiliated with or endorsed by GS1. GS1 is a registered trademark of GS1 AISBL.

AI-generated code: this library, its tests and this documentation were written by Anthropic's Claude in Claude Code, directed and reviewed by a human maintainer. Its behaviour is held in place by the test suite rather than by a hand-written reference: AI rules are generated from the GS1 Barcode Syntax Dictionary, the linters are ported from GS1's reference implementation and pass its vector set, and results are differentially tested against the GS1 Syntax Engine, GS1's TDT translator, bwip-js, zint and zxing (see [Accuracy](#accuracy)). Review it as you would any dependency.

Fast, accurate, zero-dependency GS1 encoder/decoder for TypeScript and JavaScript. ESM only; runs in Node 20+, browsers, Deno, Bun and edge runtimes.

Status: v0.10.0 ships GS1 element strings (Application Identifiers), GS1 Digital Link (plain and compressed), scanner strings (AIM symbology identifiers), EPC (the 22 legacy binary schemes, the 24 "+" and "++" schemes with +AIDC data, and the EPC URIs), the linear barcodes EAN-13, UPC-A, EAN-8, UPC-E (with 2 and 5 digit add-ons), ITF-14 and GS1-128, GS1 DataMatrix (ECC 200) and GS1 QR Code (Model 2), both also as Digital Link carriers, with an SVG renderer. GS1 DataBar, composite symbols and DotCode are not scheduled yet.

## Install

    pnpm add aidc

## Usage

    import { parse, tryParse, format, hri, identifyKey, checkDigit } from 'aidc';

    const es = parse('(01)09506000134352(17)201225(10)ABC123');
    es.gtin;                      // '09506000134352'
    format(es, 'raw');            // '01095060001343521720122510ABC123'
    format(es, 'bracketed');      // '(01)09506000134352(17)201225(10)ABC123'
    hri(es);                      // ['(01) 09506000134352', '(17) 201225', '(10) ABC123']

    const r = tryParse('(01)09506000134353(10)ABC');
    if (!r.ok) r.errors;          // [Gs1Error { code: 'CHECK_DIGIT', ai: '01', position: 17,
                                  //   message: 'AI (01): The numeric check digit is incorrect.' }]

    identifyKey('9506000134352'); // [{ key: 'gtin', ai: '01', value: '09506000134352', confidence: 0.7 },
                                  //  { key: 'gln', ai: '414', value: '9506000134352', confidence: 0.3 }]
    checkDigit('950600013435');   // '2'

Raw input is the concatenated element string with GS (U+001D) after variable-length elements that are not last. In raw input, GS is written `\u001d`; a single leading `^` or GS (the FNC1 in first position) is accepted. In the example above the raw output has no GS because the variable-length AI (10) is last. `format(es, 'raw')` has no leading FNC1/GS: barcode encoders add the FNC1 in first position themselves. Raw output that contains an unknown AI (see `allowUnknownAIs`) whose length is not implied by its prefix cannot be parsed back, because raw data has no way to delimit it.

Bracketed input may contain spaces around AIs, as in HRI text, so `parse('(01) 09506000134352 (10) ABC123')` works. Only ASCII spaces directly after an AI's `)` or directly before the next `(` or the end are skipped; a space inside a value is still an `INVALID_CHAR` error. Error positions always index the original input.

HRI text (`format(es, 'hri')` and `hri()`) is for display and is not safe to parse back. As in the GS1 Syntax Engine, a `(` inside a value is printed as is, so the batch `X(17)991231` is printed `(10)X(17)991231`, which parses as a batch `X` and a separate expiry date. To store or pass on an element string as text, use `format(es)` (bracketed, `(` escaped as `\(`) or `format(es, 'raw')`; both parse back to the same AIs.

Values are data, not markup: CSET 82 includes `<`, `>`, `&`, `"` and `'`, so a valid value can look like HTML (`(91)<img src=x onerror=...>`). Escape `format()`, `hri()`, `toString()`, field values and error messages before putting them in HTML. `toSvg` escapes its own text. Error messages echo an object key only when it is 2 to 4 digits.

Object input such as `ElementString.from({ '01': ..., '10': ... })` follows JavaScript property order, in which integer-like keys like `'10'` come first. Pass an array of `[ai, value]` pairs to control order:

    format(ElementString.from([['10', 'A'], ['01', '09506000134352']]), 'raw');
    // '10A\u001d0109506000134352'

Subpath imports: `aidc/core` (check digits, character sets, errors), `aidc/ai` (element strings), `aidc/digital-link`, `aidc/scan`, `aidc/epc`, `aidc/ean-upc`, `aidc/itf`, `aidc/gs1-128`, `aidc/datamatrix`, `aidc/qr` and `aidc/render`.

## Digital Link

    import { parse, toDigitalLink, fromDigitalLink, parseDigitalLink } from 'aidc';

    const es = parse('(01)09506000134352(10)ABC123(17)201225');
    toDigitalLink(es);
    // 'https://id.gs1.org/01/09506000134352/10/ABC123?17=201225'
    toDigitalLink(es, { domain: 'https://example.com/r' });
    fromDigitalLink('https://example.com/01/09506000134352/10/ABC123?17=201225'); // ElementString

    const link = parseDigitalLink('https://example.com/r/01/09506000134352?17=201225&utm=x');
    link.stem;                // 'https://example.com/r'
    link.primaryKey;          // '01'
    link.ignoredQueryParams;  // ['utm=x']
    link.compressed;          // false | 'partial' | 'full'
    link.elementString;       // ElementString

`parseDigitalLink` returns the element string plus the URI parts; `fromDigitalLink` returns just the element string. `tryToDigitalLink`, `tryFromDigitalLink` and `tryParseDigitalLink` return a `Result` with every error instead of throwing. `domain` is validated (an empty or invalid domain is rejected, as is a path prefix that ends with a GS1 key pair such as `/01/x`) and loses its trailing slashes. `allowUnknownAIs: true` puts AIs unknown to the Syntax Dictionary in the query, matching what `fromDigitalLink` accepts with the same option. `attributeOrder` is `'canonical'` (default, lexical by AI) or `'engine'` (fixed-length AIs first, as the GS1 Syntax Engine does).

Compression follows the GS1 Digital Link Standard 1.1.4 chapter 2:

    toDigitalLink(es, { compressed: true });       // https://id.gs1.org/<one compressed segment>
    toDigitalLink(es, { compressed: 'partial' });  // https://id.gs1.org/01/09506000134352/<compressed rest>

With `compressed: 'partial'`, an element string that has only the primary key has nothing to compress, so the result is the plain, uncompressed URI.

`fromDigitalLink` and `parseDigitalLink` accept plain, partially compressed and fully compressed links. If an uncompressed parse finds no primary key but the last path segment is base64url, it is tried as a compressed link (DL URI Syntax 6.1.3 order); when that fails too, both errors are reported. Compressed data must follow the same key and qualifier rules as an uncompressed link.

A compressed link that carries an EPC (`eh` hex or `ex` base64url, DL Compression 1.0.0) decodes to the EPC's element string (see [EPC](#epc)); for a "+" or "++" EPC the DSGTIN date and the +AIDC AIs become query attributes and must be data attributes, and for "++" the URI stem wins over the hostname inside the binary. An EPC without a GS1 key (GID-96, USDOD-96, ADI-var) or an invalid EPC fails with `INVALID_DIGITAL_LINK` (`compressed-segment`); `details.cause` is the EPC error's `details.reason` (`epc-no-gs1-key` for a missing key) or, when it has none, its code, and `details.epcCode` is the EPC error's code.

This fails with `UNSUPPORTED`: compressing an AI whose value does not fit DL 1.1.4 Table F. Building `eh`/`ex` links is not offered. Other malformed links fail with `INVALID_DIGITAL_LINK`; `details.reason` says why (for example `no-primary-key`, `key-qualifier-sequence`, `percent-encoding`). A path segment that is `.` or `..` (also spelled with `%2e`) is `dot-segment`, both when parsing and when building (a path value of `.` or `..`, or such a segment in `domain`, which fails as `domain`): browsers resolve these segments away, so the link they open would not be the one parsed or built. Dots inside a segment and in the query are fine. The host must be a name of letters, digits, `-` and `.`, or an IPv6 address in brackets, with an optional port up to 65535; anything else (such as `good.com:evil.com` or `[evil]`) is `domain`, in a parsed URI and in the `domain` option.

## Scanner strings

    import { fromScan, toScan } from 'aidc';

    const r = fromScan(']C1010950600013435217201225\u001d10ABC123');
    r.symbology;      // 'gs1-128'
    r.aimId;          // ']C1'
    r.elementString;  // ElementString

    toScan(es, 'gs1-128');                        // ']C1...' (GS after variable-length AIs)
    toScan(gtinOnly, 'ean-13', { addOn: '12' });  // ']E3...'
    toScan(es, 'qr', { digitalLink: { domain: 'https://example.com' } }); // ']Q1https://...'

`tryFromScan` and `tryToScan` return a `Result`. `fromScan` also takes Digital Link URIs read from plain QR, DataMatrix and DotCode (`]Q1`, `]d1`, `]J0`). One trailing CR, LF or CRLF is stripped. Symbology names (`ScanSymbology`):

| Name                                | AIM ID                    | Notes                    |
| ----------------------------------- | ------------------------- | ------------------------ |
| `'ean-13'`                          | `]E0` (`]E3` with add-on) | also UPC-A and UPC-E     |
| `'ean-8'`                           | `]E4`                     |                          |
| `'itf-14'`                          | `]I1` (reads `]I0` too)   |                          |
| `'gs1-128'`                         | `]C1`                     |                          |
| `'gs1-databar'`                     | `]e0`                     | also GS1 Composite       |
| `'gs1-datamatrix'`                  | `]d2`                     |                          |
| `'gs1-qr'`                          | `]Q3`                     |                          |
| `'gs1-dotcode'`                     | `]J1`                     |                          |
| `'datamatrix'`, `'qr'`, `'dotcode'` | `]d1`, `]Q1`, `]J0`       | carry a Digital Link URI |

`]E1`, `]E2`, `]e1` and `]e2` fail with `UNSUPPORTED`; plain text in `]Q1`, `]d1` or `]J0` fails with `INVALID_SCAN` (`not-gs1`). `AIM_IDS` and `SCAN_AIM_ID` expose the identifier tables.

## EPC

`epc` implements GS1 Tag Data Standard 2.3: the legacy binary schemes and the "+" and "++" schemes. Import it from `aidc/epc` (or from the root as `epc`).

    import { epc } from 'aidc/epc';

    // Decode: hex, bytes, tag URI, raw URI or pure identity URI
    const tag = epc.decode('3074257BF7194E4000001A85');
    tag.scheme;          // 'sgtin'
    tag.tagUri;          // 'urn:epc:tag:sgtin-96:3.0614141.812345.6789'
    epc.decode(tag.bytes!);
    epc.decode('urn:epc:tag:sgtin-96:3.0614141.812345.6789');
    epc.decode('urn:epc:raw:96.x3074257BF7194E4000001A85');
    epc.decode('urn:epc:id:sgtin:0614141.812345.6789'); // pure identity: no binary form
    // Its data by name, the same for legacy and plus EPCs (narrow on scheme for the names)
    if (tag.scheme === 'sgtin') {
      tag.fields.gtin;           // '80614141123458'
      tag.fields.serial;         // '6789'
      tag.fields.companyPrefix;  // '0614141' (plus EPCs: with companyPrefixLength)
    }

    // From an element string: pick the binary scheme, filter and company prefix length
    const e = epc.fromElementString('(01)09506000134352(21)12345', {
      scheme: 'sgtin-96',
      filter: 3,
      companyPrefixLength: 7,
    });
    e.hex;               // '30764433400D1EC000003039'
    e.tagUri;            // 'urn:epc:tag:sgtin-96:3.9506000.013435.12345'
    e.pureIdentityUri;   // 'urn:epc:id:sgtin:9506000.013435.12345'

    // And back
    epc.toElementString(e); // (01)09506000134352(21)12345

Every function has a `try` variant that returns a `Result` instead of throwing.

The library does not ship the GS1 Company Prefix length table (the official list is no longer public and GS1 says copies are incomplete). `companyPrefixLength` is either a number or a lookup function that receives the key digits and returns a length or `undefined`. Without a length, `fromElementString` to a legacy scheme fails with `GCP_LENGTH_UNKNOWN`; it never guesses. GTIN-8 needs no lookup. A length that does not fit the key is `INVALID_EPC` (`gcp-length`).

    epc.fromElementString(es, { scheme: 'sgtin-96', companyPrefixLength: 7 });
    epc.fromElementString(es, {
      scheme: 'sgtin-96',
      companyPrefixLength: (keyDigits) => (keyDigits.startsWith('950600') ? 7 : undefined),
    });

`Epc` is a union, `IdentityEpc | PlusEpc`. Both have `scheme`, `fields` and the binary properties (`filter`, `hex`, ...), so code that reads an EPC's data works on either. Narrow on `kind` (`'id'` or `'class'` for the legacy schemes and URIs, `'plus'` for "+" and "++") for the rest.

    const x = epc.decode(input);
    if (x.scheme === 'sgtin') x.fields.gtin; // legacy or plus
    if (x.kind === 'plus') {
      x.elementString; // the key, the DSGTIN date and the +AIDC AIs, in encoded order
    } else {
      x.pureIdentityUri;
    }

### Fields

Every EPC has `fields`: its data by name, the same names for a legacy EPC and a plus EPC of one scheme. Narrow on `scheme` to type them (`EpcFields<'grai'>` is one scheme's type). Schemes with a GS1 key use the GS1 names (as `ElementString` does: `gtin`, `serial`, `batch`, ...), with values as in the AIs, check digits included. A legacy EPC also has `companyPrefix`, the GS1 Company Prefix it encodes. A plus EPC does not encode one: pass `companyPrefixLength` to `decode` or `fromElementString` to set it, the same number or lookup as for legacy encoding. It is optional; without it, or when the lookup returns `undefined`, `companyPrefix` is left out. Decoding a legacy EPC ignores the option.

    const p = epc.decode('F7380614141123458046A140', { companyPrefixLength: 7 });
    p.fields; // { gtin: '80614141123458', serial: '6789', companyPrefix: '0614141' }

Schemes without a GS1 key use their TDS component names. Values are strings, so leading zeros stay, and URI escapes are removed (`components` keeps the URI form: a GRAI serial `A%2FB` is `fields.serial` `A/B`).

`fields` holds the EPC's identity only. A plus EPC's prioritised date and +AIDC AIs are in its `elementString` and `aidc`. `fields` is set even for data GS1 rules reject: the TDT vector `urn:epc:id:cpi:15895246363.98.0` has `fields.serial` `'0'`, while `epc.toElementString` fails because (8011) must not start with 0.

| scheme        | fields                              | AIs           |
| ------------- | ----------------------------------- | ------------- |
| sgtin         | gtin, serial                        | (01) (21)     |
| lgtin (class) | gtin, batch                         | (01) (10)     |
| upui          | gtin, tpx                           | (01) (235)    |
| itip          | gtin, piece, total, serial          | (8006) (21)   |
| sscc          | sscc                                | (00)          |
| sgln          | gln, extension (absent when 0)      | (414) (254)   |
| grai          | grai (13 digits), serial            | (8003)        |
| giai          | giai                                | (8004)        |
| gsrn          | gsrn                                | (8018)        |
| gsrnp         | gsrnp                               | (8017)        |
| gdti          | gdti (13 digits), serial            | (253)         |
| sgcn          | gcn (13 digits), serial             | (255)         |
| cpi           | cpid, serial                        | (8010) (8011) |
| ginc          | ginc                                | (401)         |
| gsin          | gsin                                | (402)         |
| pgln          | pgln                                | (417)         |
| gid           | generalManager, objectClass, serial |               |
| usdod         | cageOrDodaac, serial                |               |
| adi           | cageOrDodaac, partNumber, serial    |               |
| bic           | containerCode                       |               |
| imovn         | vesselNumber                        |               |

The GS1 schemes also have `companyPrefix`: always on legacy EPCs, and on plus EPCs decoded with `companyPrefixLength`.

### "+" and "++" schemes

The 24 schemes `sgtin+`, `dsgtin+`, `sscc+`, `sgln+`, `grai+`, `giai+`, `gsrn+`, `gsrnp+`, `gdti+`, `sgcn+`, `itip+`, `cpi+` and the same with `++` need no company prefix length. A "++" scheme also carries the hostname of a Digital Link resolver and needs the `hostname` option. Besides the key, a plus EPC can carry any further AIs as +AIDC data (TDS 15.3): `fromElementString` puts every AI the scheme body does not carry into `aidc` (unless `aidc: false`), in element string order, and `dsgtin+`/`dsgtin++` also carry one prioritised date.

    const p = epc.fromElementString('(01)09506000134352(21)12345(17)271231(10)LOT7', {
      scheme: 'sgtin++',
      filter: 3,
      hostname: 'id.example.com',
    });
    p.kind;          // 'plus'
    p.hostname;      // 'id.example.com'
    p.aidc;          // [['17', '271231'], ['10', 'LOT7']]
    p.hex;           // 'FDB0950600013435205181CC94197C61DBC3665B62E6F3E20C859C9F6000'
    epc.decode(p.hex).elementString.toString(); // (01)09506000134352(21)12345(17)271231(10)LOT7

A `PlusEpc` has `binaryScheme`, `scheme` (the family, such as `'sgtin'`), `fields` (see [Fields](#fields)), `filter`, `elementString`, `aidc`, `hostname` (for "++"), `hex`, `bytes`, `bitLength`, `rawUri` and `control`. It has no `pureIdentityUri` and no `tagUri`: TDS defines none for these schemes, because a plus EPC is equivalent to its element string. To get a legacy URI, pass `x.elementString` to `fromElementString` with a legacy scheme and a `companyPrefixLength`.

- `dateAi` picks the DSGTIN prioritised date AI. The default is the first present of (11), (13), (15), (16), (17), (7006) and (7007). A 12-digit (7007) range cannot be the prioritised date (TDS 14.5.3): the default skips it for another date AI when one is present and it goes to +AIDC, and a lone 12-digit (7007) range gives `no-date`. `dateAi` on a scheme without a prioritised date, or without that AI in the data, is `INVALID_EPC`. `dateAi` and `aidc` apply when an EPC is encoded (`fromElementString`, or `decode` into a different scheme, filter or hostname). When `decode` re-encodes nothing (the same scheme, filter and hostname), they are ignored.
- Encodable AIs (Table F): AIs missing from it ((03), (8014), (3954), (3955), (717), (8040) to (8043)) and values over a Table F maximum (for example (8007) over 24 characters) fail with `EPC_FIELD_OVERFLOW` (`field` is the AI, `why` is `not-encodable` or `too-long`) instead of being dropped. Pass `aidc: false` to leave the extra AIs out. An encoded EPC over 496 bits is `EPC_FIELD_OVERFLOW` (`too-long`); longer input is rejected on decode too.
- Hostnames: on encode, `hostname` is 1 to 63 letters, digits, `-`, `.` and `_`, is required for "++" and is an error for any other scheme. On decode the same characters and `:` (for a port) are accepted, so a decoded hostname is safe to put in a URL host or HTML as is. TDS allows any CSET 82 character, but `/`, `?`, `@`, `%`, quotes, `<` and the like would let a tag change the URL built from it, so a binary carrying them is `INVALID_EPC` (`binary`). A decoded hostname with a port, such as `host:8080`, cannot be re-encoded (`decode` with `filter` or a scheme conversion fails with `INVALID_EPC` `hostname`).
- Repeated identical +AIDC entries in a binary are kept on decode (both appear in `aidc` and `elementString`); encoding from that element string drops the repeat, so the re-encoded bits can differ.
- `decode(hexOrRawUri, { scheme })` of a plus EPC can only re-encode into another plus scheme of the same family; anything else is `INVALID_EPC` (`scheme`). A plus EPC never converts to a legacy scheme by itself.
- New `INVALID_EPC` reasons: `hostname`, `no-date` and `aidc`. Options of the wrong type (for example a non-string `scheme`, `epcScheme` or `dateAi`, or a bad `companyPrefixLength`) return a `Gs1Error`. Errors for AIs inside plus binaries carry no bit position.

### Legacy EPCs

An `IdentityEpc` is immutable and has these fields: `scheme` (pure scheme such as `'sgtin'`), `kind` (`'id'` or `'class'`), `components`, `fields` (see [Fields](#fields)), `pureIdentityUri`, and, when it has a binary encoding, `binaryScheme`, `filter`, `tagUri`, `rawUri`, `hex`, `bytes` (a fresh copy on each read), `bitLength` and `control` (Gen2 `att`, `umi` and `xpc` fields, kept in the tag and raw URIs). Options `scheme`, `filter` and `control` also work on `decode` to re-encode into another binary scheme of the same EPC. `control` takes `att` (an integer 0 to 255), `umi` (a boolean) and `xpc` (an integer 0 to 0xFFFFFFFF); anything else is `INVALID_EPC` (`control`). `components` and `control` are canonical: escapes as in `pureIdentityUri`, and only the non-zero control fields.

Binary schemes (22): SGTIN-96, SGTIN-198, SSCC-96, SGLN-96, SGLN-195, GRAI-96, GRAI-170, GIAI-96, GIAI-202, GSRN-96, GSRNP-96, GDTI-96, GDTI-113 (deprecated), GDTI-174, SGCN-96, ITIP-110, ITIP-212, GID-96, CPI-96, CPI-var, USDOD-96 and ADI-var.

URI-only identifiers (pure identity, no binary form): BIC, IMOVN, PGLN, UPUI, GINC, GSIN and the LGTIN class URI.

Compressed Digital Links that carry an EPC (`eh`, `ex`) decode through `fromDigitalLink`. Not yet supported: pattern URIs such as `urn:epc:idpat:` (M8).

## Barcodes

The linear symbologies encode to a `LinearPattern` (plain data: rows of alternating dark and light module widths, human readable text and quiet zones), decode from one, and render to SVG with `toSvg`. The pattern is frozen and JSON-friendly. Import the symbologies from `aidc/ean-upc`, `aidc/itf` and `aidc/gs1-128`, and `toSvg` from `aidc/render` (all are also exported from the root).

    import { ean13, itf14, gs1128, toSvg } from 'aidc';

    const p = ean13.encode('9506000134352');
    p.symbology;            // 'ean-13'
    p.rows[0].widths;       // [1, 1, 1, ...] module widths, even index dark
    toSvg(p, { moduleSize: 3 });  // '<svg xmlns="http://www.w3.org/2000/svg" ...>'

    const d = ean13.decode(p);
    d.aimId;                // ']E0'
    d.rawData;              // '9506000134352'
    d.elementString;        // (01)09506000134352

Every symbology is an object `{ name, encode, tryEncode, decode, tryDecode }`. `encode(data, options?)` takes an `ElementString` or a string and returns a `LinearPattern`; `decode(pattern)` returns a `DecodedSymbol` `{ symbology, aimId, elementString, rawData, errorsCorrected, addOn?, metadata }`. `tryEncode` and `tryDecode` return a `Result`. Encoder options (all optional): `height` in modules (at most 1000), `hri` (human readable text, default `true`) and the symbology options below.

`rawData` is the data a scanner transmits after the AIM identifier, so `fromScan(d.aimId + d.rawData)` gives back `d.elementString` (and the add-on). `errorsCorrected` is 0 for linear symbols.

### EAN-13, UPC-A, EAN-8 and UPC-E

`ean13`, `upcA`, `ean8`, `upcE` and `eanUpc` (accepts all four on decode; `eanUpc.encode(data, { form })` takes `'ean-13' | 'upc-a' | 'ean-8' | 'upc-e' | 'auto'`, default `'auto'`: EAN-8 for a GTIN starting `000000`, UPC-A for one starting `00`, EAN-13 otherwise; never UPC-E unless asked).

    import { ean13, upcA, ean8, upcE, eanUpc, upceCompress, upceExpand } from 'aidc/ean-upc';

    ean13.encode('9506000134352');
    upcA.encode('012345678905');
    ean8.encode('96385074');
    upcE.encode('042100005264');    // a zero-suppressible GTIN-12
    upceCompress('042100005264');   // '425261' (the 6 digits), or undefined when not zero-suppressible
    upceExpand('425261');           // '042100005264'
    ean13.encode('9506000134352', { addOn: '12345' });
    toSvg(ean13.encode('9506000134352', { addOn: '12' }), { moduleSize: 3 });

Input rules (the same for all four and for ITF-14): an `ElementString` whose only element is (01), or a string. Data without an (01) fails parsing and association validation first (for example `(10)A` gives `MISSING_REQUIRED_AI`); other elements alongside (01) give `NOT_REPRESENTABLE`. `eanUpc.name` is `'ean-13'`, like `ean13.name`, because it is the multi-form entry. A string of only digits with length 8, 12, 13 or 14 is a GTIN including its check digit; it is validated (`CHECK_DIGIT` on a mismatch), never computed. Any other string is parsed as an element string, so a raw string of exactly 8, 12, 13 or 14 digits is always read as a GTIN; use brackets, as in `(15)251231`, for AI data. The GTIN is normalised to 14 digits and must be representable, otherwise `NOT_REPRESENTABLE` (the data is never changed silently):

- EAN-13 carries a 14-digit GTIN starting `0`; UPC-A one starting `00`; UPC-E one starting `000` whose GTIN-12 is zero-suppressible; EAN-8 one starting `000000`.
- EAN-13, UPC-A and UPC-E reject a 13-digit value `00000` followed by two digits that are not `00` (the GTIN-8 collision range, GenSpecs Table 1-4).
- Any element besides (01) is not representable.

Add-ons: option `addOn` (2 or 5 digits) on EAN-13, UPC-A and UPC-E; EAN-8 and the other symbologies give `NOT_REPRESENTABLE`. `addOnGap` is the space between the main symbol and the add-on in modules; the default is 7 (EAN-13), 9 (UPC-A) and 7 (UPC-E), and it may be raised up to 12. A decoded symbol with an add-on has `aimId` `]E3`, `rawData` of the 13 digits followed by the add-on, and `addOn`. A pattern that holds only an add-on fails with `INVALID_SYMBOL` (`add-on-only`). The main symbol is 69 modules high (EAN-8: 55) and `hri: false` removes the digits and also the `<` and `>` quiet zone markers; `quietZoneMarkers: false` removes only the markers.

Decoding: both the EAN-13 and UPC-A decoders accept any 13-digit main symbol, and the result is `'upc-a'` when the digits start with `0` and `'ean-13'` otherwise (the bars are identical). `ean8.decode` accepts only EAN-8 and `upcE.decode` only UPC-E, otherwise `INVALID_SYMBOL` (`symbology`). UPC-E has number system 0 only; a complemented parity row is `INVALID_SYMBOL` (`parity`). A non-canonical UPC-E body is decoded and sets `metadata.upceCanonical: false`.

### ITF-14

    import { itf14 } from 'aidc/itf';

    const p = itf14.encode('09506000134352');                         // frame bearer, ratio 2.5
    itf14.encode('09506000134352', { wideToNarrow: 3, bearer: 'top-bottom', bearerWidth: 8 });
    itf14.decode(p).metadata;  // { reversed: false, wideToNarrow: 2.5 }

ITF-14 carries any GTIN-14, and only (01). A narrow element is 1 module and a wide element is `wideToNarrow` modules, from 2.25 to 3.0 (default 2.5). `bearer` is `'frame'` (default), `'top-bottom'` or `'none'`, and `bearerWidth` (default 5) is from 2 to 100. The human readable text is the 14 digits on one line. Decoding classifies each element as narrow or wide at the midpoint of the narrowest and widest, needs exactly two width classes, and accepts ratios from 2.0 to 3.0.

### GS1-128

    import { gs1128 } from 'aidc/gs1-128';

    const p = gs1128.encode('(01)09506000134352(17)201225(10)ABC123');
    const d = gs1128.decode(p);
    d.aimId;      // ']C1'
    d.rawData;    // '01095060001343521720122510ABC123'
    d.metadata;   // { reversed, symbolValues, dataCharacters, overLength?, linkage? }

The encodation is minimal over code sets B and C (GS1 data never needs A): the shortest sequence of symbol characters, which reproduces GenSpecs Table 5-27, with a fixed tie-break (stay in the current set before latching, then C before B). The limit is 48 transmitted data characters: the raw form of the element string with GS separators between variable-length elements; the leading FNC1 (which only marks the symbol as GS1-128) does not count. More fails with `DATA_TOO_LONG` (`details.limit: 48`, `details.actual`). `optimizeOrder: true` reorders the elements to put fixed-length AIs first, which saves separators and can make a longer string fit. The 165.10 mm limit depends on the X-dimension and is not enforced (see `SYMBOL_SPECS` in `aidc/render`). Decoding accepts longer symbols and sets `metadata.overLength: true`; it accepts code sets A, B and C, SHIFT and a GS (set A value 93), and it reports a trailing composite linkage character as `metadata.linkage` (`'cc-a-b'` or `'cc-c'`). The encoder never emits that flag.

A string passed to `gs1128.encode`, and the data read by `decode`, are parsed without association checks (`validateAssociations: false`), because one symbol may carry only part of a label's data. An `ElementString` you pass in is used as given. Call `validate()` first if you need the association checks.

The human readable text is the element string as `(ai)value` pieces in encoded order. Lines wrap only between elements, so with real data (up to 48 characters in an 8 module font) the text stays on one line; the estimate uses 0.6 em per character.

### Rendering

    toSvg(pattern, { moduleSize: 3, unit: 'px', quietZone: true, hri: true, title: 'GTIN' });

`toSvg` returns a deterministic SVG string: one `<path>` for all bars, optional `<title>` and background `<rect>`, then `<text>` items. Options: `moduleSize` (default 2), `unit` (`'px'` or `'mm'`), `quietZone` (`true` for the symbology's minimum, `false`, a number of modules, or `{ left, right, top, bottom }`), `hri`, `foreground` (`'#000'`), `background` (`'#fff'`, `null` for none), `fontFamily` (`'OCR-B,OCRB,monospace'`) and `title`. Text options are escaped. `foreground` and `background` must be colors: `#` and 3, 4, 6 or 8 hex digits, a color name, or `rgb()`, `rgba()`, `hsl()` or `hsla()`; `url()` and other paint references are `INVALID_VALUE`, so the SVG never references other content. The image is at most 1,000,000 units wide and high; a larger `moduleSize` or `quietZone` is `INVALID_VALUE` (`details.option` `moduleSize`). There is no height option: bar heights belong to the encoder. Text whose baseline is within the bar height (EAN/UPC digits, add-on digits, quiet zone markers) is positioned in content coordinates; text below the bars (ITF-14 and GS1-128) hangs off the bottom of the rendered body, below the bottom quiet zone and bearer, so it never overprints a bearer. The image grows where text would fall outside the quiet zone, for example with `quietZone: false`. `toSvg` also renders a `ModuleMatrix` (the same options, no new ones; the matrix becomes one row of runs per module row, and `quietZone: true` means the symbology's 1 module). `tryToSvg` returns a `Result`. `SYMBOL_SPECS` holds GenSpecs sizes (X-dimension, minimum bar height, quiet zones) as metadata; nothing is enforced.

Rendering tips:

- For raster targets keep `moduleSize` a whole number of pixels. For ITF-14 also keep `moduleSize` times `wideToNarrow` a whole number of pixels: WebKit was seen to misread ITF-14 at `moduleSize: 3` with ratio 2.25 (fractional 6.75 px wide bars). For example ratio 3 at any whole `moduleSize`, or ratio 2.5 at an even one.
- The text defaults to OCR-B, falling back to a monospace font. The layout assumes an advance of 0.6 em per character, measured against a monospace fallback only.

### Decoding patterns

`decode` reads a `LinearPattern`, not an image. It needs the exact logical widths in modules (not measured, noisy widths). Build a pattern from widths with `linearPattern(widths)` (even index dark; a leading 0 starts with a light run). The pattern may be read in either direction (`metadata.reversed`), and may have light runs at the start and end (quiet zones) or a leading 0. A pattern that cannot be decoded fails with `INVALID_SYMBOL`; `details.reason` is one of `pattern`, `length`, `guard`, `character`, `parity`, `check-character`, `no-start`, `no-stop`, `sequence`, `symbology` or `add-on-only`, `details.element` is the index into the `widths` of the row you passed in (before trimming and reversal) and `details.row` the row. Hostile input (empty, non-number or huge widths) gives a `Gs1Error`, never another exception.

### Barcode errors

- `INVALID_SYMBOL`: a pattern that is not a valid symbol (see above).
- `DATA_TOO_LONG`: GS1-128 data over 48 characters (`details.limit`, `details.actual`).
- `NOT_REPRESENTABLE`: valid data the symbology cannot carry (`details.symbology`), for example a GTIN-14 with indicator 1 in EAN-13.
- `UNSUPPORTED` (`details.reason`): valid Code 128 that is not GS1 (`not-gs1`) and FNC2, FNC3 and FNC4 (`fnc2`, `fnc3`, `fnc4`).

## 2D barcodes: DataMatrix

GS1 DataMatrix (ECC 200) encodes to a `ModuleMatrix` and decodes from one. A `ModuleMatrix` is frozen plain data: `{ kind: 'matrix', symbology, width, height, rows, quietZone, hri }`, where `rows` are strings of `'1'` (dark) and `'0'` (light), row 0 at the top, the quiet zone excluded. Two symbology objects share the usual shape `{ name, encode, tryEncode, decode, tryDecode }`; import them from `aidc/datamatrix` (or the root).

    import { gs1DataMatrix, dataMatrix, toSvg } from 'aidc';

    const m = gs1DataMatrix.encode('(01)09506000134352(17)201225(10)ABC123');
    m.symbology;                 // 'gs1-datamatrix'
    m.width;                     // 20 (a 20 x 20 symbol; quiet zone 1 module on every side)
    m.rows[0];                   // '10101010101010101010'

    const d = gs1DataMatrix.decode(m);
    d.aimId;                     // ']d2'
    d.rawData;                   // '01095060001343521720122510ABC123'
    d.elementString;             // (01)09506000134352(17)201225(10)ABC123
    d.errorsCorrected;           // 0
    d.metadata;                  // { rows: 20, columns: 20, shape: 'square', codewords: [232, 131, ...],
                                 //   ecCodewords: 18, blocks: 1, encodation: ['ascii'],
                                 //   orientation: { rotation: 0, mirrored: false }, inverted: false }

    toSvg(m, { moduleSize: 4 }); // '<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88" ...>'

`gs1DataMatrix` (`name: 'gs1-datamatrix'`, AIM identifier `]d2`) carries an element string with FNC1 in the first position. A bundle that uses only `gs1DataMatrix` contains no Digital Link code. `dataMatrix` (`name: 'datamatrix'`, `]d1`) is the GS1 Digital Link carrier: the symbol holds a URI as plain text.

    const u = dataMatrix.encode('(01)09506000134352(10)ABC123');   // an element string, built into a URI
    dataMatrix.encode('https://id.gs1.org/01/09506000134352/10/ABC123');  // or a URI, encoded verbatim

    const r = dataMatrix.decode(u);
    r.aimId;          // ']d1'
    r.digitalLink;    // 'https://id.gs1.org/01/09506000134352/10/ABC123'
    r.rawData;        // the same URI
    r.elementString;  // (01)09506000134352(10)ABC123

Options (all optional):

- `size`: `'square'` (default: the smallest square that fits, the most common choice in the GS1 DataMatrix Guideline), `'rectangular'` (the 6 rectangular sizes), `'auto'` (the smallest area of all 30 sizes, square on ties) or `{ rows, columns }`, which must be one of the 30 ECC 200 sizes (10 x 10 to 144 x 144, 8 x 18 to 16 x 48). Anything else, including the DMRE sizes, is `INVALID_VALUE` with `details.option: 'size'`. Data that does not fit is `DATA_TOO_LONG` with `details.limit`, `details.actual` and `details.unit: 'codewords'`; the global limit is 1558 data codewords (the 144 x 144 symbol).
- `encodation`: `'auto'` (default) or `'ascii'` (restricts the encoder to ASCII mode).
- `optimizeOrder`: fixed-length AIs first, saving separators (`gs1DataMatrix` only; it has no effect on `dataMatrix`, where the URI order comes from `digitalLink.attributeOrder`).
- `hri` (default `false`) and `hriSize` (font size in modules, default 3): one human readable `(ai)value` line per element string, left-aligned below the symbol.
- `digitalLink` (`dataMatrix` only): the options of `toDigitalLink`, applied as in `toScan(es, 'datamatrix', { digitalLink })`.

Encodation: the encoder finds the minimal number of codewords over ASCII, C40, Text, X12 and EDIFACT with an exact search; ties prefer ASCII. This reproduces the symbol sizes printed in the GS1 DataMatrix Guideline. FNC1 is the separator between variable-length elements. The encoder does not use Base 256 or the upper shift (GS1 data never needs them), so it cannot encode arbitrary binary data.

Input rules: `gs1DataMatrix` takes an `ElementString` or a string; a string is parsed without association checks (as GS1-128, because one symbol may carry part of a label's data), so call `validate()` first if you need them. `dataMatrix` takes a URI (a string starting with `http://` or `https://`; scheme detection ignores case, but the URI must be a valid GS1 Digital Link, whose scheme is `http`, `https`, `HTTP` or `HTTPS`, so mixed case such as `Https://` is rejected with `INVALID_DIGITAL_LINK`): it is validated as a GS1 Digital Link and encoded verbatim. Any other string or an `ElementString` is parsed (associations are validated, because a URI needs a primary key) and built into a URI. An invalid URI is `INVALID_DIGITAL_LINK`. Bundle cost: the Digital Link carrier pulls in the Digital Link builder and parser and, through it, the EPC tables, so a `dataMatrix` bundle is about 56.7 KB gzip against about 28.0 KB for `gs1DataMatrix` alone (minified, gzip -9, measured with `test/oracle/bundle.test.ts`). Import only `gs1DataMatrix` if you do not need Digital Link carrier symbols.

### Decoding matrices

`decode` reads a `ModuleMatrix`, not an image: build one with `matrixFromRows(rows)` (strings of `'0'` and `'1'`, or arrays of 0, 1 and booleans; 1 to 1024 rows of equal length) from modules you have already sampled, and read single modules with `moduleAt(m, x, y)`. The matrix may be:

- in any of the 8 orientations (rotated by 0, 90, 180 or 270 degrees, mirrored or not; for rectangles, the orientations that give a valid size), reported as `metadata.orientation`;
- inverted (light modules on dark), reported as `metadata.inverted`;
- with or without a light border: all-light outer rows and columns are trimmed. A symbol cropped with an extra frame around its quiet zone (for example a dark label edge outside the light quiet zone) is not trimmed and fails.

Every ECC 200 encodation mode is decoded (ASCII, C40, Text, X12, EDIFACT and Base 256). Reed-Solomon correction fixes up to floor(EC / 2) wrong codewords per block (`errorsCorrected` is the total over all blocks). A block with more is `RS_UNCORRECTABLE` with `details: { block, blocks, ecCodewords, capacity }`. Rarely, damage beyond capacity decodes to different data; a symbol with unreadable modules should be rescanned.

Failures are `INVALID_SYMBOL` with `details.reason`: `size` (dimensions that are no ECC 200 size), `finder` (more than a quarter of the finder and clock modules mismatch in the best orientation), `codeword` (an invalid codeword, with `details.codeword`) or `pattern` (not a matrix). The reason `timing` is reserved for symbologies with alignment patterns and is not produced by DataMatrix. `gs1DataMatrix` and `dataMatrix` decode only GS1 content; everything else is `UNSUPPORTED` with `details.reason`:

- `not-gs1`: plain text, or for `gs1DataMatrix` a `]d1` symbol; for `dataMatrix` a `]d1` symbol whose text is not a GS1 Digital Link URI (`details.text` holds the text, `details.aimId` the identifier).
- `macro` (05 and 06 macros), `eci`, `structured-append`, `reader-programming` and `fnc1-second` (FNC1 in the second position): these are decoded fully and then refused, with `details.aimId` and `details.rawData` so the caller can still use the data.
- `dmre`: the DMRE rectangular sizes are recognised but not decoded.

`dataMatrix.decode` also reads `]d2` symbols and reports them as `symbology: 'gs1-datamatrix'`. The element string of a `]d2` symbol is parsed without association checks, as for GS1-128.

All decode results are frozen. Hostile input (ragged rows, characters other than 0 and 1, throwing getters) gives a `Gs1Error`, never another exception.

## 2D barcodes: QR Code

Quick start: encode an element string to a QR Code, draw it, read it back.

    import { gs1Qr } from 'aidc/qr';
    import { toSvg } from 'aidc/render';      // or import both from 'aidc'

    const m = gs1Qr.encode('(01)09506000134352(17)201225(10)ABC123');
    const svg = toSvg(m, { moduleSize: 4 });       // '<svg xmlns="http://www.w3.org/2000/svg" width="132" ...>'
    const d = gs1Qr.decode(m);
    String(d.elementString);                       // '(01)09506000134352(17)201225(10)ABC123'

To put a GS1 Digital Link URI in a plain QR Code (the common choice for consumer-facing labels), use `qr` instead:

    import { qr } from 'aidc/qr';

    const u = qr.encode('(01)09506000134352(10)ABC123');       // an element string, built into a URI
    qr.decode(u).digitalLink;                                    // 'https://id.gs1.org/01/09506000134352/10/ABC123'

Bundles stay small: with a bundler (esbuild, Rollup, Rolldown, Vite, webpack), a bundle that uses only `gs1Qr` contains no Digital Link or EPC code (about 28.9 KB gzip, minified), whether you import it from `aidc` or `aidc/qr`; the `qr` carrier adds the Digital Link builder and parser and the EPC tables behind them (about 57.6 KB gzip, about 29 KB more). Import only `gs1Qr` if you do not need Digital Link carrier symbols. The sizes are measured with `test/oracle/bundle.test.ts`.

Without a bundler (Node, Deno, or a browser `<script type="module">` loading `dist` directly), importing `aidc/qr` also loads the Digital Link and EPC modules, even if you use only `gs1Qr`: ES modules load every static import of a module, and `aidc/qr` exports both objects, the `qr` carrier importing the Digital Link code. The same holds for `aidc/datamatrix`. This costs load time only (about 0.5 MB of unminified JavaScript in total for either subpath, the AI table included), not behaviour. If that matters, bundle your code.

The rest of this section gives the details. Both symbology objects have the usual shape `{ name, encode, tryEncode, decode, tryDecode }` and work on a `ModuleMatrix` (see [2D barcodes: DataMatrix](#2d-barcodes-datamatrix)). `gs1Qr` (`name: 'gs1-qr'`, AIM identifier `]Q3`) carries an element string with FNC1 in the first position. `qr` (`name: 'qr'`, `]Q1`) is the GS1 Digital Link carrier: the symbol holds a URI as plain text, taken verbatim from a GS1 Digital Link URI, or built from an element string (or a string in element string syntax) as in `toScan(es, 'qr', { digitalLink })`.

    const d = gs1Qr.decode(m);
    d.aimId;           // ']Q3'
    d.rawData;         // '01095060001343521720122510ABC123'
    d.errorsCorrected; // 0
    d.metadata;        // { version: 2, ecLevel: 'M', mask: 7, codewords: [81, 6, ...], dataBits: 151,
                       //   ecCodewords: 16, blocks: 1,
                       //   segments: [{ mode: 'numeric', count: 26 }, { mode: 'alphanumeric', count: 6 }],
                       //   orientation: { rotation: 0, mirrored: false }, inverted: false }

Options (all optional):

- `ecLevel`: `'L'`, `'M'` (default), `'Q'` or `'H'`. The level is used exactly: there is no automatic boost to a higher level. EU 2018/574 (tobacco traceability) requires `'H'`, so pass it explicitly there.
- `version`: `'auto'` (default, the smallest of versions 1 to 40 that holds the data at the level) or one version 1 to 40. Data that does not fit is `DATA_TOO_LONG` with `details.limit`, `details.actual` and `details.unit: 'bits'` (and `details.version` for an explicit version).
- `mask`: `'auto'` (default) or one ISO mask pattern 0 to 7, to force it. Any mask is valid, because readers take it from the format information.
- `optimizeOrder` (`gs1Qr` only), `hri` (default `false`) and `hriSize` (default 3): as for DataMatrix.
- `digitalLink` (`qr` only): the options of `toDigitalLink`.

Out-of-range options are `INVALID_VALUE` with `details.option`. The quiet zone is 4 modules on every side.

Segmentation: the encoder finds the fewest bits over numeric, alphanumeric and byte segments with an exact search, and picks the smallest version at which they fit (the count field is longer for larger versions, so it searches the three version ranges 1-9, 10-26 and 27-40). It never emits Kanji; a character above 0x7E is `NOT_REPRESENTABLE`. In GS1 mode FNC1 is `%` inside an alphanumeric segment (a literal `%` is written `%%`) and 0x1D inside a byte segment. Tip for Digital Links: alphanumeric mode only holds upper-case letters, so a URI with an upper-case scheme and host is shorter. For example `HTTPS://ID.GS1.ORG/01/09506000134352/10/AAAAAAAAAAAAA` is a version 3 symbol where the same URI in lower case is version 4. Pass it as `digitalLink: { domain: 'HTTPS://ID.GS1.ORG' }` or as the URI itself; the encoder never changes the case of what you give it. Only the scheme and host may change case freely; the path and query are case sensitive.

Mask choice: of the eight masks, the encoder takes the one with the lowest penalty, scored with the BWIPP-compatible rule set (the same as bwip-js and the GS1 barcode engine) over the full symbol with its function patterns. This is a deliberate choice: the ISO/IEC 18004 text can be read in more than one way, and the reading that matches the two widely used generators was chosen so that results agree with them. A generator that follows the ISO text literally (for example the one behind GenSpecs Figure 6-5) can pick another mask for the same data; the symbols are equally valid and decode identically. Use `mask` to reproduce another generator's choice. Version and data bits were never larger than what bwip-js and zint produce at the same level in differential tests, and strictly smaller in some cases.

### Decoding QR matrices

`decode` reads a `ModuleMatrix`, not an image: build one with `matrixFromRows(rows)` from modules you have already sampled. The matrix may be a logical module matrix in any of the 8 orientations (rotated by 0, 90, 180 or 270 degrees, mirrored or not; `metadata.orientation`), inverted (`metadata.inverted`), and with or without a quiet zone (all-light outer rows and columns are trimmed). The side must be 21 + 4k modules (versions 1 to 40).

Reed-Solomon correction fixes up to floor(EC / 2) wrong codewords per block, except for the small symbols where ISO/IEC 18004 limits correction to protect against misdecoding: 1-L corrects 2, 1-M 4 and 2-L 4 (these values are recalled from the standard, not read from it). `errorsCorrected` is the total over all blocks. A block with more errors is `RS_UNCORRECTABLE` with `details: { block, blocks, ecCodewords, capacity }`. Both copies of the format information and of the version information are used, and up to 3 bit errors in each are tolerated.

Failures are `INVALID_SYMBOL` with `details.reason`: `size` (no QR side length), `finder` (no orientation with three finder patterns), `timing` (more than a quarter of the timing pattern wrong), `format` (neither format copy is readable), `version` (a clean version-information copy that disagrees with the size), `codeword` (an invalid bit stream, with `details.codeword`) or `pattern` (not a matrix). `gs1Qr` and `qr` decode only GS1 content; everything else is `UNSUPPORTED` with `details.reason`:

- `not-gs1`: plain text, or for `gs1Qr` a `]Q1` symbol; for `qr` a `]Q1` symbol whose text is not a GS1 Digital Link URI (`details.text` and `details.rawData` hold the text).
- `eci` (`details.eci`), `structured-append` (`details.position`, `total`, `parity`), `fnc1-second` (`details.applicationIndicator`) and `kanji`: decoded fully and then refused, with `details.aimId` and `details.rawData` so the caller can still use the data. For `]Q5` (FNC1 in the second position) the application indicator is put in front of the data in `details.rawData`.

`qr.decode` also reads `]Q3` symbols and reports them as `symbology: 'gs1-qr'`. In the GS1 FNC1 mode, `%%` is read as `%` and a single `%` as GS. Encoders disagree on a literal `%` inside a byte segment: bwip-js 4.11.4 doubles it, which is not what ISO/IEC 18004 says; this library follows the standard.

## Compatibility notes

- Digital Link parsing follows the GS1 Syntax Engine, with two deliberate differences: `;` is accepted as a query delimiter (DL 4.10 ABNF), and a `%` not followed by two hex digits is rejected (DL 4.2 requires `%25`).
- Like the engine, a trailing slash is rejected, any repeated AI is a `DUPLICATE_AI` error and the rightmost primary key wins. A short (01) in the path fails unless `permitZeroSuppressedGtin` is set, while a short (01) in the query is always padded to 14 digits.
- `toDigitalLink` orders query parameters canonically (lexical by AI, DL 4.12) by default, so output can differ from the engine's; pass `attributeOrder: 'engine'` to match it.
- `fromScan` accepts more than the engine: `]E3`, `]I1`/`]I0`, and the engine's joined `]E0<13>|]e0<AI data>` composite form, whose associations are checked on the merged GTIN and composite data (so `]E09506000134352|]e010ABC` gives (01)(10)). `]E0`/`]E4` give AI (01) padded to 14 digits.
- EPC `hex` and `bytes` are zero-padded to 16-bit words (TDS Appendix E, Gen2 memory); `bitLength` is the unpadded length. The decoder accepts zero padding up to 496 bits in all (the Gen2 maximum, as for raw URIs) and either hex case; non-zero padding or longer input is `INVALID_EPC` (`binary`). A raw URI's hex value (and AFI) has at most 124 digits and its decimal value at most 150; longer is `INVALID_EPC` (`syntax`), even when the extra digits are leading zeros. Any EPC URI has at most 1024 characters (the longest valid one is about 250). For a plus EPC with +AIDC data, any all-zero tail is padding, so an all-zero (00) SSCC as the last +AIDC entry cannot be told apart from padding and does not survive a round trip.
- EPC URI output is canonical: GS3A3 fields escape exactly `" % & / < > ?`, CPRef and ADI fields escape `/` and `#`, hex is upper case. Input escapes may use either hex case, and over-escaping an allowed character is accepted. An escape that decodes to a character outside the field's set is `INVALID_EPC` (`escape`).
- EPC encoding rejects GTINs with restricted prefixes (TDS 7.3.3 to 7.3.8, for example RCN-8, `02`, `04`, `977`, `98x`, `99`) for SGTIN, LGTIN, UPUI and ITIP with `INVALID_EPC` (`restricted-prefix`). ISBN and ISMN (`978`, `979`) are allowed.
- There is no silent scheme fallback: a value the chosen scheme cannot hold (for example a serial with leading zeros in a 96-bit scheme, or too many characters) is `EPC_FIELD_OVERFLOW`, never moved to a longer scheme. This differs from `epc-tds`, which drops leading zeros.
- SGLN: an element string without (254) maps to extension `0`, and extension `0` maps back to no (254).
- Raw URIs: the AFI form is not an EPC (`UNSUPPORTED`, `raw-afi`), and bit counts above 496 are rejected. A filter or control value without a binary scheme is an error, as is a filter on GID-96. A CPI serial of `0` has no element string form. This is an upstream conflict: GS1 General Specifications v26 3.9.11 allows an (8011) serial of exactly `0` (it "SHALL NOT begin with a '0' digit, unless the entire serial number consists of the single digit '0'"), while the GS1 Barcode Syntax Dictionary applies `nozeroprefix` to (8011) with no such exception. The library follows the Syntax Dictionary for AI validation, as the GS1 Syntax Engine does, so `toElementString` fails with `INVALID_VALUE` on (8011).
- `toScan` cannot emit the joined `]E0..|]e0..` form: `toScan(es, 'ean-13')` carries only a GTIN. Composite output arrives with the composite symbology milestone (M7).

## Parse options

- `validateAssociations` (default `true`): `false` disables only the mandatory-association (`req`) rules. Invalid pairs (`ex`), the (8030) serialised-key rule and conflicting duplicate AIs are still checked.
- `allowUnknownAIs` (default `false`): follows the GS1 Syntax Engine's permitUnknownAIs rules.
  - The AI must have the length that known AIs with the same two-digit prefix use, and no known AI may be a prefix of it.
  - Unknown 3-digit AIs under prefix 41 take a fixed 13 characters, and unknown 4-digit AIs under prefixes 31 to 36 take a fixed 6.
  - Otherwise AI plus value must fit in 90 characters.
  - If no known AI shares the two-digit prefix, any 2 to 4 digit AI is accepted in bracketed input, with AI plus value up to 90 characters; such AIs cannot appear in raw input.
  - Raw input can only carry unknown AIs whose length is implied by the prefix.
  - `hri()` titles unknown AIs `UNKNOWN`.

## Errors

Every failure is a `Gs1Error` with a `code`, a `message` and, where known, `ai`, `position` and `length`. For string input `position` indexes the input string. For object input (`ElementString.from`, `validate` of an object, iterable or ElementString) value errors index into the AI value and association errors (`MISSING_REQUIRED_AI`, `INVALID_AI_PAIR`, `DUPLICATE_AI`, the (8030) serial rule) have no position.

`Gs1ErrorCode` is an open union that will grow in later releases (for example for later barcode families). Digital Link and scanner strings add `INVALID_DIGITAL_LINK`, `INVALID_SCAN` and `UNSUPPORTED`; barcodes add `INVALID_SYMBOL`, `DATA_TOO_LONG` and `NOT_REPRESENTABLE`, and the 2D symbologies add `RS_UNCORRECTABLE` (`details.block`, `blocks`, `ecCodewords`, `capacity`); EPC adds `INVALID_EPC` (with `details.reason`), `EPC_FIELD_OVERFLOW`, `EPC_UNKNOWN_HEADER` and `GCP_LENGTH_UNKNOWN`. Avoid exhaustive `switch` statements over it without a `default` branch.

`try*` functions never throw, whatever they are given. An argument they cannot read (options of the wrong type or `null`, a throwing getter, Proxy or iterator, a `companyPrefixLength` lookup that throws) is a `SYNTAX` error with `details.reason` `argument`. Object input to `validate` and `ElementString.from` takes at most 10,000 entries.

## Changes

See [CHANGELOG.md](CHANGELOG.md).

## Accuracy

AI rules are generated from the official GS1 Barcode Syntax Dictionary (release 2026-01-27). All GS1 linters are ported from GS1's reference implementation and pass its full unit-test vector set. Results are differentially tested against the official GS1 Syntax Engine.

## Performance

Benchmarks are in `bench/ai.bench.ts`, `bench/digital-link.bench.ts`, `bench/epc.bench.ts`, `bench/linear.bench.ts` and `bench/matrix.bench.ts`. Baseline from `pnpm bench` (vitest 5) on an Apple M2 Max with Node 24.18.0, the mean of two runs:

- Element strings, four elements, (01), (17), (10) and (21), with full validation: parse bracketed about 514,000 ops/s, parse raw about 594,000 ops/s, format raw about 6,200,000 ops/s.
- Digital Link, five elements, (01), (10), (21), (17) and (3103): `toDigitalLink` about 560,000 ops/s, `fromDigitalLink` about 224,000 ops/s; compressed, about 145,000 and 87,000 ops/s.
- EPC: `toElementString` about 892,000 ops/s, `decode` of SGTIN-96 hex about 244,000 ops/s, `fromElementString` to SGTIN-96 about 181,000 ops/s, `decode` of an SGTIN-198 tag URI about 121,000 ops/s, `decode` of SGTIN++ hex about 88,000 ops/s, `fromElementString` to DSGTIN+ with two +AIDC AIs about 76,000 ops/s.
- Linear barcodes (GTIN 9506000134352; GS1-128 data `(01)09506000134352(17)201225(10)ABC123`): encode EAN-13 about 652,000 ops/s, with a 5-digit add-on about 537,000, ITF-14 about 1,450,000, GS1-128 about 183,000; decode EAN-13 about 324,000 ops/s, with add-on about 242,000, ITF-14 about 310,000, GS1-128 about 189,000; `toSvg` of a GS1-128 pattern about 87,000 ops/s, of an EAN-13 pattern about 128,000.
- Bundle size (gzip -9, entry plus the chunks it imports, including the shared `ai` chunk): `render` about 7.9 KB, `ean-upc` about 40.1 KB, `itf` about 34.9 KB, `gs1-128` about 37.0 KB. `symbology/linear` does not import `scan`, so Digital Link and EPC code stays out of these bundles.
- DataMatrix (`(01)09506000134352(17)201225(10)ABC123` as GS1 DataMatrix; the Digital Link URI `https://id.gs1.org/01/09506000134352/10/ABC123?17=201225`; the 144 x 144 symbol is a URI with 3000 digits, 1500 data codewords): `gs1DataMatrix` encode about 78,000 ops/s, decode about 28,000; `dataMatrix` encode of the URI about 43,000 ops/s, decode about 17,000; encode of the 144 x 144 symbol about 1,070 ops/s (0.9 ms), decode about 530 (1.9 ms); `toSvg` of a 64 x 64 symbol about 3,100 ops/s, of the 144 x 144 symbol about 590. Reed-Solomon on a 255-codeword block (235 data, 20 parity): `rsEncode` about 67,000 ops/s, `rsDecode` with 10 errors about 22,000.
- Bundle size of DataMatrix (gzip -9, minified, with the chunks it imports): `gs1DataMatrix` about 28.0 KB, `dataMatrix` about 56.7 KB (it adds the Digital Link code and the EPC tables behind it).
- QR Code (same data and URI; the large symbol is version 40-L, a URI with 6900 digits): `gs1Qr` encode about 17,500 ops/s, decode about 74,000; `qr` encode of the URI about 8,300 ops/s, decode about 39,000; encode of the 40-L symbol about 230 ops/s (4.3 ms), decode about 860 (1.2 ms); `toSvg` of a 177 x 177 symbol about 370 ops/s; mask selection alone (eight full-symbol penalties) for the 40-L symbol about 290 ops/s (3.4 ms).
- Bundle size of QR (gzip -9, minified, with the chunks it imports): `gs1Qr` about 28.9 KB, `qr` about 57.6 KB.
- Scanner strings, same data: `fromScan` of GS1-128 about 450,000 ops/s, of a QR Code Digital Link about 219,000 ops/s.

`pnpm bench` builds first and benchmarks the built package through its public entry points (`aidc`, `aidc/epc`, `aidc/qr` and so on), as a consumer imports it. The `bench` vitest project externalizes `dist` and `src`, so Node loads them natively (the Reed-Solomon and mask selection cases import internal source modules through Node's type stripping). Vitest's module runner would otherwise wrap every cross-module export in a getter, which made the per-byte Galois field calls 3 to 10 times slower and the other cases about half as fast.

## Development

    pnpm install
    pnpm check        # format, lint, typecheck, tests + coverage, oracle, build, package checks
    pnpm test:browser # Chromium, Firefox and WebKit
    pnpm gen          # regenerate the AI table from docs/specifications/data

## License

MIT. Includes Apache-2.0 licensed GS1 data; see THIRD_PARTY_NOTICES.md.
