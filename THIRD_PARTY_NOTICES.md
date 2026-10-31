# Third-party notices

aidc contains data and code derived from the following works, licensed under the Apache
License, Version 2.0. The full licence text is in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)
(also at http://www.apache.org/licenses/LICENSE-2.0).

## GS1 Barcode Syntax Dictionary (release 2026-01-27)

`src/ai/table.gen.ts` is generated from the GS1 Barcode Syntax Dictionary data file.
Copyright (c) 2020-2021 BWIPP project; Copyright (c) 2020-2021 Zint Project; Copyright (c) 2021-2025 GS1 AISBL.
https://github.com/gs1/gs1-syntax-dictionary

Modifications: the data is converted to a TypeScript table by `scripts/gen-ai-table.ts`.

## GS1 Barcode Syntax Tests (linters)

Source: gs1-syntax-dictionary main @ c63d8a1 (2026-08-29), `src/lint_*.c` and
`src/gs1syntaxdictionary.h`.
Copyright (c) 2022-2026 GS1 AISBL.
https://github.com/gs1/gs1-syntax-dictionary/tree/main/src

Modifications: the files in `src/ai/linters/` were translated from C to TypeScript and modified
for aidc (including their code lists). `src/ai/linters/lint-codes.gen.ts` is generated
from `gs1syntaxdictionary.h`. Each ported file carries a header naming the upstream files it
covers.

## GS1 Digital Link compression prototype (test vectors only)

`test/vectors/dl-compression.json` contains encoder outputs generated with
gs1/GS1DigitalLinkCompressionPrototype @ 07b85c2 (Apache-2.0).
https://github.com/gs1/GS1DigitalLinkCompressionPrototype

The file is test-only and is not distributed in the package. Table F and Table Opt in
`src/digital-link/compress/tables.ts` are transcribed from the GS1 Digital Link Standard 1.1.4
PDF, not copied from that code.

## EPC conformance data (test-only)

`epc-tds` 1.4.1 (MIT) is a dev dependency used as a differential-testing oracle. It is not distributed
in the package.

`test/vectors/epc-tdt.json` contains outputs generated with GS1's TDT 2.3 draft translator
(gs1/TDT @ a655cc3, Apache-2.0). https://github.com/gs1/TDT. The file is test-only and is not
distributed in the package.

## GS1 TDT 2.3 draft tables (EPC "+" and "++" schemes)

`src/epc/tables.gen.ts` is generated from the GS1 TDT 2.3 draft tables (Table F, A and B1 to B4;
gs1/TDT, Apache-2.0, https://github.com/gs1/TDT) by `scripts/gen-epc-tables.ts`. Unlike the
GS1 Company Prefix length table, this file is shipped in the package, with this notice.
`test/vectors/epc-tdt-plus.json` contains outputs of the same translator and is test-only; it
is not distributed in the package.

The "++" hostname optimiser in `src/epc/hostname.ts` is a port of `internalHostname2Binary` from GS1's
TDTtranslator.js (gs1/TDT, Apache-2.0, https://github.com/gs1/TDT) and ships in the package.

The GS1 Company Prefix length table is NOT included in the package. Callers pass
`companyPrefixLength` as a number or a lookup function. The tests read a snapshot from
`docs/specifications/data/`, which is not part of the published package.

## Linear barcode conformance data (test-only)

`test/vectors/ean-upc.json` and `test/vectors/gs1-128.json` contain vectors derived from the unit
tests of gs1-barcode-engine (gs1/gs1-barcode-engine @ 289c899, Apache-2.0). https://github.com/gs1/gs1-barcode-engine.
The files are test-only and are not distributed in the package.

`bwip-js` 4.11.4 (MIT; it embeds BWIPP, Barcode Writer in Pure PostScript, MIT) and `zxing-wasm`
3.1.5 (MIT; it contains zxing-cpp, Apache-2.0, and zint, BSD-3-Clause) are dev dependencies used
as differential-testing oracles for the linear symbologies. They are not distributed in the package.

## DataMatrix conformance data (test-only)

`test/vectors/datamatrix.json` contains vectors derived from the unit tests of
gs1-barcode-engine (gs1/gs1-barcode-engine @ 289c899, Apache-2.0).
https://github.com/gs1/gs1-barcode-engine. It also holds symbols generated with `bwip-js` 4.11.4
(MIT; it embeds BWIPP, Barcode Writer in Pure PostScript, MIT) and symbols sampled from GS1
publications (GenSpecs 26.0, GS1 DataMatrix Guideline 2.5.1). The file is test-only and is not
distributed in the package.

`bwip-js` and `zxing-wasm` 3.1.5 (MIT; it contains zxing-cpp, Apache-2.0, and zint, BSD-3-Clause)
are dev dependencies used as differential-testing oracles for DataMatrix. zint runs inside
zxing-wasm as an oracle for encoding; it is not distributed in the package. Oracle findings: zint
treats AI (235) as a predefined-length AI and omits its separator, contrary to GenSpecs Table 7-6;
bwip-js rejects the ISO 4217 currency codes 924 and 926.

## QR Code conformance data (test-only)

`test/vectors/qr.json` contains vectors derived from the unit tests of gs1-barcode-engine
(gs1/gs1-barcode-engine @ 289c899, Apache-2.0). https://github.com/gs1/gs1-barcode-engine. It also
holds symbols generated with `bwip-js` 4.11.4 (MIT; it embeds BWIPP, Barcode Writer in Pure
PostScript, MIT) and matrices sampled from the figures of GS1 publications (GenSpecs 26.0, the GS1
2D Barcode Verification Process Implementation Guideline 1.3.21 and the GS1 2D Barcodes at Retail
POS Implementation Guideline 1.1.0), used as test data. The file is test-only and is not
distributed in the package.

`bwip-js` and `zxing-wasm` 3.1.5 (MIT; it contains zxing-cpp, Apache-2.0, and zint, BSD-3-Clause)
are dev dependencies used as differential-testing oracles for QR Code. They are not distributed in
the package. Oracle finding, no action in this library: bwip-js 4.11.4 doubles a literal `%` inside
byte segments of GS1 QR data; this library follows ISO/IEC 18004.
