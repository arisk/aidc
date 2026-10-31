# GS1 reference specifications and data

Official, freely available GS1 reference documents and machine-readable data files collected for the aidc library (AI element strings, check digits, GS1 Digital Link, EPC Tag Data Standard, and GS1 barcode symbologies).

Collected: 2026-10-09. All downloads were verified (PDFs start with `%PDF`, archives and JSON checked by type and size). Downloaded content is treated as untrusted reference data; nothing in this folder is executed by the build.

In git, only this README and the data files that the tests and generators read are tracked: `data/gs1-syntax-dictionary-2026-01-27.txt` and `data/tdt-2.3-draft-2026-09-15a/`. The tests download `data/gcpprefixformatlist-snapshot-2026-02-17.json` from the pinned gs1/TDT commit on first run and check its SHA-256 (`test/support/gcp-snapshot.ts`). The GS1 documents are copyrighted and are not redistributed; download them from the source URLs below into this folder.

## Current versions at a glance (as of 2026-10-09)

| Standard | Latest published | Date | Notes |
|---|---|---|---|
| GS1 General Specifications | 26.0 | Jan 2026 | 8 GSCNs already ratified for the next edition 27.0 (see `gscn/`) |
| EPC Tag Data Standard (TDS) | 2.3 | Oct 2025 | Adds twelve `++` schemes (SGTIN++, DSGTIN++, ...) on top of the TDS 2.0 `+` schemes |
| EPC Tag Data Translation (TDT) | 2.2 | Feb 2025 | Published artefacts cover TDS 2.2 (no `++` schemes yet); a TDT 2.3 draft artefact set exists on GitHub |
| GS1 Digital Link URI Syntax | 1.7.0 | Aug 2026 | |
| GS1 Digital Link Compression | 1.0.0 | Jul 2025 | Split out from the legacy combined Digital Link standard |
| GS1 Digital Link Standard (legacy combined) | 1.1.4 | Dec 2025 | Archive/reference only |
| GS1 Barcode Syntax Dictionary | release 2026-01-27 | Jan 2026 | `main` has unreleased changes up to 2026-08-29 |
| GS1 Application Identifiers (ref.gs1.org/ai) | owl:versionInfo 1.2 | modified 2026-01-26 | |

## Symbology status in GenSpecs 26.0

- **GS1 DotCode**: approved (GenSpecs section 5.8, symbology identifier `]J1`, based on AIM DotCode Rev 3.0, Aug 2014). Restricted: it SHALL only be used to meet EU tobacco traceability regulation EU 2018/574 (section 2.1.14), and only at unit pack level.
- **GS1 Aztec**: not an approved GS1 symbology. The word "Aztec" does not occur in GenSpecs 26.0, and no GSCN (2013 to the pending 27.0 set) mentions it. Some vendor libraries offer a "GS1 Aztec" mode (FNC1 in Aztec per ISO/IEC 24778), but it has no GS1 application standard and no GS1 symbology identifier.
- **GS1 symbology identifiers** (GenSpecs Table 5-2): `]E0` to `]E4` EAN/UPC and add-ons, `]I1` ITF-14, `]C1` GS1-128, `]e0` GS1 DataBar, `]e1`/`]e2` GS1 Composite, `]d2` GS1 DataMatrix, `]Q3` GS1 QR Code, `]J1` GS1 DotCode, `]d1` Data Matrix with GS1 Digital Link URI, `]Q1` QR Code with GS1 Digital Link URI.

## Specifications (this folder)

| Filename | Title | Version | Date | Source URL | Use in the library |
|---|---|---|---|---|---|
| `gs1-general-specifications-v26.0.pdf` | GS1 General Specifications Standard | 26.0 (Ratified) | Jan 2026 | https://ref.gs1.org/standards/genspecs/ | Normative source for AI definitions, GS1 keys, check digit algorithm, GCP/prefix rules, all symbology rules (sections 5.x), symbology identifiers, HRI, FNC1/GS handling, application standards |
| `gscn/gscn-25-035-mudi-for-genspecs-v27.pdf` | GSCN 25-035: AIDC application standard Master UDI-DI | ratified for 27.0 | 2026-06 | https://ref.gs1.org/standards/genspecs/gscn/2025/WR25-035-MUDI.pdf | Upcoming GenSpecs 27 change |
| `gscn/gscn-25-223-productvariation-dpp-for-genspecs-v27.pdf` | GSCN 25-223: Rename AI (22) CPV to Product Variation Number (PVN) | ratified for 27.0 | 2026-09 | https://ref.gs1.org/standards/genspecs/gscn/2025/GSCN-25-223-ProductVariation-DPP.pdf | AI (22) title change; affects AI tables and Digital Link |
| `gscn/gscn-25-306-mandassoc03-for-genspecs-v27.pdf` | GSCN 25-306: Data relationships with AI (03) | ratified for 27.0 | 2026-04 | https://ref.gs1.org/standards/genspecs/gscn/2025/GSCN-25-306-MandAssoc03.pdf | AI association/exclusion rules (already in Syntax Dictionary `main`) |
| `gscn/gscn-25-423-hcare-02-37-for-genspecs-v27.pdf` | GSCN 25-423: Use of AI (02) and (37) in healthcare | ratified for 27.0 | 2026-07 | https://ref.gs1.org/standards/genspecs/gscn/2025/GSCN-25-423-HCare-02-37.pdf | AI association rules |
| `gscn/gscn-26-081-extpackapp-for-genspecs-v27.pdf` | GSCN 26-081: Extended packaging application standards and DPP | ratified for 27.0 | 2026-05 | https://ref.gs1.org/standards/genspecs/gscn/2026/GSCN-26-081-ExtPackApp.pdf | Application standards context |
| `gscn/gscn-26-103-glossary-for-genspecs-v27.pdf` | GSCN 26-103: GenSpecs glossary improvements | ratified for 27.0 | 2026-06 | https://ref.gs1.org/standards/genspecs/gscn/2026/WR26-103-Glossary.pdf | Terminology |
| `gscn/gscn-26-144-truncation-for-genspecs-v27.pdf` | GSCN 26-144: Truncated EAN/UPC barcodes | ratified for 27.0 | 2026-06 | https://ref.gs1.org/standards/genspecs/gscn/2026/GSCN-26-144-Truncation.pdf | EAN/UPC rendering rules |
| `gscn/gscn-26-226-dpp-provisional-v2-for-genspecs-v27.pdf` | GSCN 26-226: Updated Digital Product Passport provisional standard | ratified for 27.0 | 2026-06 | https://ref.gs1.org/standards/genspecs/gscn/2026/GSCN-26-226-dpp-provisional-v2.pdf | DPP / Digital Link context |
| `epc-tag-data-standard-v2.3.pdf` | EPC Tag Data Standard (TDS) | 2.3 (Ratified) | Oct 2025 | https://ref.gs1.org/standards/tds/ | EPC binary/hex/URI encodings, partition tables, filter values, `+` and `++` schemes, Gen2 memory layout; Appendix E has worked encoding/decoding examples usable as test vectors |
| `epc-tag-data-translation-v2.2.pdf` | EPC Tag Data Translation (TDT) | 2.2 (Ratified) | Feb 2025 | https://ref.gs1.org/standards/tdt/ | Describes the machine-readable TDT definition files and translation process |
| `gs1-digital-link-uri-syntax-v1.7.0.pdf` | GS1 Digital Link Standard: URI Syntax | 1.7.0 (Ratified) | Aug 2026 | https://ref.gs1.org/standards/digital-link/uri-syntax/1.7.0/GS1-Digital-Link-Standard-URI-Syntax-i1-7-r-2026-08-06.pdf | Normative Digital Link URI syntax, ABNF, primary key / qualifier paths, element string conversion |
| `gs1-digital-link-uri-syntax-v1.7.0.html` | GS1 Digital Link Standard: URI Syntax (HTML edition) | 1.7.0 | Aug 2026 | https://ref.gs1.org/standards/digital-link/uri-syntax/ | Same content; source for the extracted ABNF file |
| `gs1-digital-link-compression-v1.0.0.pdf` | GS1 Digital Link Standard: Compression | 1.0.0 (Ratified) | Jul 2025 | https://ref.gs1.org/standards/digital-link/compression/ | Compressed Digital Link URI encode/decode |
| `gs1-digital-link-standard-legacy-v1.1.4.pdf` | GS1 Digital Link Standard (legacy combined) | 1.1.4 (Ratified) | Dec 2025 | https://ref.gs1.org/standards/digital-link/1.1.4/ | Background; superseded by URI Syntax + Compression |
| `gs1-barcode-syntax-resource-user-guide-v1.0.1.pdf` | GS1 Barcode Syntax Resource User Guide | 1.0.1 (Final) | Nov 2022 | https://ref.gs1.org/tools/gs1-barcode-syntax-resource/user-guide/ | How to interpret the Syntax Dictionary format and linters |
| `gs1-datamatrix-guideline-v2.5.1.pdf` | GS1 DataMatrix Guideline | 2.5.1 (Ratified) | Jan 2018 | https://ref.gs1.org/guidelines/datamatrix/2.5.1/ | FNC1 placement, encodation, symbol sizes, examples |
| `gs1-2d-barcodes-at-retail-pos-implementation-guideline-v1.1.0.html` | 2D Barcodes at Retail Point-of-Sale Implementation Guideline (HTML) | 1.1.0 | Dec 2025 | https://ref.gs1.org/guidelines/2d-in-retail/1.1.0/ | GS1 QR Code / QR with Digital Link / GS1 DataMatrix at POS, sizing, quiet zones |
| `gs1-qr-code-powered-by-gs1-best-practices-2023.pdf` | Best practices for creating your QR Code powered by GS1 | n/a | 2023 (rev. Apr 2024) | https://ref.gs1.org/docs/2023/QR-Code_powered-by-GS1-best-practices.pdf | QR + Digital Link practical guidance (there is no separate "GS1 QR Code Guideline") |
| `gs1-practical-guide-start-your-2d-barcode-journey-2024-11.pdf` | Practical guide: start your 2D barcode journey | full version | Nov 2024 | https://www.gs1.org/sites/gs1/files/2024-11/practical-guide-start-your-2d-barcode-journey-full-version.pdf | 2D migration context, examples |
| `gs1-fact-sheet-overview-of-all-gs1-2d-barcodes-v1.0-2023.pdf` | GS1 Barcodes fact sheet: all GS1 2D barcodes | 1.0 | May 2023 | https://www.gs1.org/sites/default/files/2023-06/gs1_barcodes_fact_sheet-overview_of_all_gs1_2d_barcodes-final_v1.0.pdf | Overview of DataMatrix, QR, DotCode usage scope |
| `gs1-fact-sheet-overview-of-all-gs1-barcodes-2021.pdf` | GS1 Barcodes fact sheet: overview of all GS1 barcodes | n/a | Aug 2021 | https://www.gs1.org/docs/barcodes/GS1_Barcodes_Fact_Sheet-overview_of_all_GS1_barcodes.pdf | Symbology overview |
| `gs1-fact-sheet-gs1-databar-family-2015.pdf` | GS1 Barcodes fact sheet: GS1 DataBar family | n/a | Jan 2015 | https://www.gs1.org/docs/barcodes/GS1_Barcodes_Fact_Sheet-GS1_DataBar_family.pdf | DataBar variants overview (no free technical "DataBar introduction" exists any more) |
| `gs1-databar-business-case-2007.pdf` | Business Case for GS1 DataBar | n/a | Aug 2007 | https://www.gs1.org/docs/barcodes/databar/GS1_DataBar_Business_Case_Complete.pdf | Background only |
| `gs1-fact-sheet-ean-upc-family-2015.pdf` | GS1 Barcodes fact sheet: EAN/UPC family | n/a | 2015 | https://www.gs1.org/docs/barcodes/GS1_Barcodes_Fact_Sheet-GS_EAN_UPC_family.pdf | EAN-13, UPC-A, UPC-E, EAN-8 overview |
| `gs1-fact-sheet-1d-symbols-for-general-distribution-itf14-gs1-128-2015.pdf` | GS1 Barcodes fact sheet: 1D symbols for general distribution only | n/a | 2015 | https://www.gs1.org/docs/barcodes/GS1%20Barcodes%20Fact%20Sheet%20-%20GS1%201D%20symbols%20for%20general%20distribution%20only.pdf | ITF-14 and GS1-128 overview (no separate official ITF-14 guide exists on gs1.org) |
| `gs1-logistic-label-guideline-v1.3.pdf` | GS1 Logistic Label Guideline | 1.3 (Ratified) | Jul 2019 | https://ref.gs1.org/guidelines/logistic-label/1.3.0/ | GS1-128 / SSCC label layout, AI usage on logistic labels |
| `gs1-scan4transport-implementation-guideline-v1.1.pdf` | Encoding Transport Process Information (Scan4Transport) | 1.1 (Ratified) | Dec 2021 | https://ref.gs1.org/guidelines/scan-4-transport/1.1.0/ | 2D (DataMatrix/QR) transport AIs; realistic test payloads |
| `gs1-hri-implementation-guideline-v1.3.pdf` | GS1 Human Readable Interpretation (HRI) Implementation Guideline | 1.3 (Ratified) | Jun 2026 | https://ref.gs1.org/guidelines/human-readable-interpretation/1.3.0/ | HRI text formatting for rendered symbols |
| `gs1-1d-barcode-verification-process-implementation-guideline-v24.1.pdf` | GS1 1D Barcode Verification Process Implementation Guideline | release 24.1 (as printed), ratified | Jul 2015 | https://www.gs1.org/docs/barcodes/1D_Barcode_verification_implementation_guideline.pdf | Data/structure checks performed by verifiers on 1D symbols |
| `gs1-2d-barcode-verification-process-implementation-guideline-v1.3.21.pdf` | GS1 2D Barcode Verification Process Implementation Guideline | 1.3.21 (as printed) | Jul 2015 | https://www.gs1.org/docs/barcodes/2D_Barcode_Verification_Process_Implementation_Guideline.pdf | Data/structure checks for GS1 DataMatrix / QR |
| `gs1-rfid-barcode-interoperability-guideline-v1.1.pdf` | GS1 RFID/Barcode Interoperability Guideline | 1.1 (Ratified) | Nov 2016 | https://www.gs1.org/docs/barcodes/RFID_Barcode_Interoperability_Guidelines.pdf | Element string to EPC conversion, GCP length issue |
| `gs1-application-identifiers-overview-2015.pdf` | GS1 Application Identifiers (overview sheet) | n/a | Jun 2015 | https://www.gs1.org/sites/default/files/docs/barcodes/GS1%20Application%20Identifiers.pdf | Historical overview only; use the JSON / Syntax Dictionary instead |
| `gs1-linear-encoder-software-user-guide-2020.pdf` | GS1 Barcode Engine (linear encoder) user guide | n/a | Jun 2020 | https://www.gs1.org/sites/default/files/gs1_linear_encoder_software_user_guide.pdf | Describes GS1's reference encoder (see `data/repos/gs1-barcode-engine-*`) |
| `gs1-how-to-calculate-check-digit-manually.html` | How to calculate a check digit manually (web page) | n/a | retrieved 2026-10-09 | https://www.gs1.org/services/how-calculate-check-digit-manually | Mod-10 (3-1 weighting) check digit description with worked example |

## Data files (`data/`)

| Filename | Title | Version | Date | Source URL | Use in the library |
|---|---|---|---|---|---|
| `data/gs1-syntax-dictionary-2026-01-27.txt` | GS1 Barcode Syntax Dictionary | release 2026-01-27 | Jan 2026 | https://github.com/gs1/gs1-syntax-dictionary/blob/2026-01-27/gs1-syntax-dictionary.txt | Primary machine-readable AI table: format, components, linters, FNC1 requirement, `req`/`ex` associations, `dlpkey` Digital Link qualifiers. Generate AI tables from this |
| `data/gs1-syntax-dictionary-main-c63d8a1-2026-08-29.txt` | GS1 Barcode Syntax Dictionary (unreleased `main`) | commit c63d8a1 | 2026-08-29 | https://github.com/gs1/gs1-syntax-dictionary | Preview of next release (AI (03) relationships per WR 25-306) |
| `data/gs1-syntax-dictionary-CHANGES-main-c63d8a1.txt` | Syntax Dictionary change log | commit c63d8a1 | 2026-08-29 | same repo | Tracks AI additions/changes per GSCN |
| `data/gs1-syntax-dictionary-README-main-c63d8a1.md` | Syntax Dictionary README (format spec) | commit c63d8a1 | 2026-08-29 | same repo | Grammar of the dictionary file |
| `data/gs1-syntax-tests-docs-main-c63d8a1/` | GS1 Barcode Syntax Tests (linters) Doxygen docs | commit c63d8a1 | 2026-08-29 | https://ref.gs1.org/tools/gs1-barcode-syntax-resource/syntax-tests/ | Semantics of each linter (csum, csumalpha, gcppos1/2, iso3166, iso4217, yymmd0, pcenc, couponcode, ...) to port to TypeScript |
| `data/gs1-application-identifiers-v1.2-2026-01-26.jsonld` | GS1 Application Identifiers (JSON-LD) | owl:versionInfo 1.2 | modified 2026-01-26 | https://ref.gs1.org/ai/GS1_Application_Identifiers.jsonld | 542 nodes: per-AI title, formatString, regex, components, separatorRequired, requires/excludes, Digital Link attributes |
| `data/gs1-application-identifiers-v1.2-2026-01-26.json` | GS1 Application Identifiers (plain JSON) | same | same | https://ref.gs1.org/ai/ (HTTP `Accept: application/json`) | Same data as plain array |
| `data/gs1-digital-link-uri-syntax-v1.7.0.abnf` | GS1 Digital Link URI ABNF (extracted) | 1.7.0 | Aug 2026 | extracted from https://ref.gs1.org/standards/digital-link/uri-syntax/1.7.0/ | 354 ABNF rules mechanically extracted from the standard's rule tables; the PDF is normative |
| `data/gs1-digital-link-grammar-v1.2-legacy-digital-link-js.abnf` | GS1 Digital Link grammar 1.2 (legacy) | 1.2 | 2020 to 2023 | https://github.com/gs1/digital-link.js/tree/master/grammar | Older grammar used by digital-link.js; comparison only |
| `data/gs1-digital-link-js-identifier-list.json` | digital-link.js identifier list | n/a | Jan 2023 | https://github.com/gs1/digital-link.js | Legacy key/qualifier list; comparison only |
| `data/tdt-2.2.0/` | TDT 2.2 normative artefacts (XML + JSON + XSD + JSON Schema, 38 scheme and table definitions plus manifest) | 2.2.0 | 2025-02-13 | https://ref.gs1.org/standards/tdt/artefacts | Data-driven EPC encode/decode for SGTIN-96/198, SSCC-96, SGLN-96/195, GRAI, GIAI, GSRN(P), GDTI, CPI, SGCN, ITIP, GID, USDOD, ADI and the TDS 2.0 `+` schemes (SGTIN+, DSGTIN+, ...); tables B/E/F/K |
| `data/tdt-2.2.0-artefacts-2025-02-13.zip` | Same artefacts as published zip | 2.2.0 | 2025-02-13 | https://ref.gs1.org/standards/tdt/2.2.0/2025-02-13_TDT_2-2_artefacts.zip | Pristine copy |
| `data/tdt-2.3-draft-2026-09-15a/` | TDT 2.3 DRAFT artefacts (adds `++` schemes, tables A, B1 to B4) | draft 2026-09-15a | manifest 2026-09-14 | https://github.com/gs1/TDT/tree/main/TDT_2_3_demo | Needed for TDS 2.3 `++` schemes until TDT 2.3 is ratified. Not normative |
| `data/tds-2.3-packed-objects-id-table.csv` | TDS 2.3 Packed Objects ID Table (ISO/IEC 15961 Format 9) | 2.3 | Oct 2025 | https://ref.gs1.org/standards/tds/2.3.0/TDS_2-3_Packed_Objects_ID_Table.csv | User memory (Packed Objects) AI mapping |
| `data/gcpprefixformatlist-snapshot-2026-02-17.json` | GS1 Company Prefix length table (snapshot) | dated 2026-02-17 | Feb 2026 | https://github.com/gs1/TDT/blob/main/demo/gcpprefixformatlist.json | GCP length lookup for partition values of pre-TDS-2.0 schemes and EPC URI dot placement. See note below |
| `data/repos/gs1-syntax-dictionary-main-c63d8a1-2026-08-29.tar.gz` | gs1/gs1-syntax-dictionary snapshot | c63d8a1 | 2026-08-29 | https://github.com/gs1/gs1-syntax-dictionary | Linter C sources with embedded unit tests (`UNIT_TEST` blocks) = test vectors for AI validation |
| `data/repos/gs1-syntax-engine-1.4.1-ec595ff-2026-05-28.tar.gz` | gs1/gs1-syntax-engine release 1.4.1 | 1.4.1 | 2026-05-28 | https://github.com/gs1/gs1-syntax-engine | Reference parser for bracketed AI, unbracketed/FNC1 data, scan data with symbology identifiers, Digital Link URIs; extensive unit tests (`ai.c`, `dl.c`, `scandata.c`, `syn.c`) |
| `data/repos/gs1-barcode-engine-master-289c899-2024-09-26.tar.gz` | gs1/gs1-barcode-engine snapshot | 289c899 | 2024-09-26 | https://github.com/gs1/gs1-barcode-engine | GS1 reference symbol generator: EAN/UPC, GS1-128, GS1 DataBar (all), GS1 Composite CC-A/B/C, GS1 DataMatrix, GS1 QR; unit tests with expected module patterns per symbology |
| `data/repos/gs1-tdt-main-a655cc3-2026-09-19.tar.gz` | gs1/TDT snapshot | a655cc3 | 2026-09-19 | https://github.com/gs1/TDT | TDT JavaScript translator (TDTtranslator.js), TDT 2.2 and 2.3 demo, batch translation tool |
| `data/repos/gs1-digital-link-toolkit-js-master-facedb8-2025-05-01.tar.gz` | gs1/GS1DigitalLinkToolkit.js | facedb8 | 2025-05-01 | https://github.com/gs1/GS1DigitalLinkToolkit.js | Reference element string to Digital Link translation |
| `data/repos/gs1-digital-link-compression-prototype-master-07b85c2-2025-12-03.tar.gz` | gs1/GS1DigitalLinkCompressionPrototype | 07b85c2 | 2025-12-03 | https://github.com/gs1/GS1DigitalLinkCompressionPrototype | Reference compression/decompression implementation |
| `data/repos/gs1-digital-link-js-master-91c85c0-2023-01-31.tar.gz` | gs1/digital-link.js | 91c85c0 | 2023-01-31 | https://github.com/gs1/digital-link.js | Older SDK with ABNF-based validation and tests (`tests/index.js`) |
| `data/repos/gs1-interpretgs1scan-master-a887c79-2025-06-18.tar.gz` | gs1/interpretGS1scan | a887c79 | 2025-06-18 | https://github.com/gs1/interpretGS1scan | Scan string interpretation (symbology identifiers, GS1 prefix to MO lookup) |

### Note on the GS1 Company Prefix length table

The official table (`https://www.gs1.org/docs/gcp_length/gcpprefixformatlist.xml` and `.json`) has been password protected since early 2026; the URLs now redirect to https://www.gs1.org/standards/bc-epc-interop, which asks for an access request via https://gs1.wufoo.com/forms/gcp-length-table-request-for-access/. The snapshot in `data/` is the copy GS1 publishes in its public, Apache-2.0 licensed `gs1/TDT` repository (dated 2026-02-17, 192,979 entries). GS1 notes the table is incomplete for some countries, so the library must also accept an explicit GCP length. For production, request access or treat the snapshot as best-effort.

## Official test-vector sources

- TDS 2.3 Appendix E (non-normative): worked EPC encoding and decoding examples, plus worked examples for the TDS 2.x encoding methods (variable-length alphanumeric, base 64, 7-bit ASCII, custom hostname encodings).
- TDT 2.2 / 2.3 artefacts: each scheme definition contains patterns and field rules; `gs1/TDT` TDTtranslator.js and `TDT_2_3_demo/test.html` can be used to generate cross-check vectors.
- `gs1/gs1-syntax-dictionary`: unit tests embedded in every linter source file.
- `gs1/gs1-syntax-engine`: unit tests for AI parsing, Digital Link URI parsing and generation, and scan data with symbology identifiers.
- `gs1/gs1-barcode-engine`: unit tests with expected symbol output for EAN/UPC, GS1-128, GS1 DataBar, Composite, DataMatrix and QR.
- GS1 Digital Link URI Syntax 1.7.0 and Compression 1.0.0 contain many worked examples (uncompressed and compressed URIs with equivalent element strings).
- GenSpecs 26.0 contains worked examples throughout (check digit calculation, symbology identifier transmitted data, HRI).

There is no single official, versioned conformance test suite for GS1 barcodes or TDS; the sources above are the closest official equivalents.

## Not freely available

These symbology and AIDC standards are referenced normatively by GenSpecs but are sold by ISO/IEC (or national bodies) or AIM. They were not downloaded.

| Standard | Subject | Used for | Free substitutes |
|---|---|---|---|
| ISO/IEC 15420 | EAN/UPC symbology | EAN-13, EAN-8, UPC-A, UPC-E, 2/5 digit add-ons | GenSpecs 26.0 section 5.2 (symbol structure, encodation tables, dimensions, add-ons); gs1-barcode-engine `ean.c` |
| ISO/IEC 16390 | Interleaved 2 of 5 | ITF-14 | GenSpecs 26.0 section 5.3 (ITF-14 structure, bearer bars, dimensions) |
| ISO/IEC 15417 | Code 128 | GS1-128 | GenSpecs 26.0 section 5.4 (GS1-128 rules, FNC1, character sets A/B/C summary); gs1-barcode-engine `ucc128.c` |
| ISO/IEC 24724 | GS1 DataBar | All seven DataBar variants | GenSpecs 26.0 section 5.5 (overview only); gs1-barcode-engine `rss14.c`, `rsslim.c`, `rssexp.c`, `rssutil.c` |
| ISO/IEC 24723 | GS1 Composite | CC-A, CC-B, CC-C | GenSpecs 26.0 composite sections (overview); gs1-barcode-engine `cc.c` |
| ISO/IEC 15438 | PDF417 | Basis of CC-B/CC-C | gs1-barcode-engine `cc.c` (CC-B/CC-C use PDF417 / MicroPDF417 structures) |
| ISO/IEC 24728 | MicroPDF417 | Basis of CC-A/CC-B | gs1-barcode-engine `cc.c` |
| ISO/IEC 16022 | Data Matrix | GS1 DataMatrix, Data Matrix with Digital Link | GS1 DataMatrix Guideline 2.5.1; GenSpecs 26.0 sections 5.6 and 5.9; gs1-barcode-engine `dm.c` |
| ISO/IEC 18004:2015 (and 2024 edition) | QR Code | GS1 QR Code, QR with Digital Link | GenSpecs 26.0 sections 5.7 and 5.10; 2D at Retail POS guideline; gs1-barcode-engine `qr.c` |
| AIM ISS DotCode (GenSpecs cites Rev 3.0, Aug 2014; AIM's current is Rev 4.0) | DotCode | GS1 DotCode | Sold by AIM (not free). GenSpecs 26.0 section 5.8 has GS1-specific rules (FNC1 handling, `]J1`, quality, use restriction). No GS1 reference encoder exists for DotCode. ISO/IEC 21471:2019 is the ISO extended-rectangular Data Matrix (DMRE) standard, not DotCode; it is also paid |
| ISO/IEC 24778 | Aztec Code | Not a GS1 symbology | None needed for GS1 conformance (Aztec is not approved by GS1) |
| ISO/IEC 15424 | Symbology identifiers | `]E0`, `]C1`, `]d2`, `]Q3`, ... | GenSpecs 26.0 Table 5-2 lists every identifier used in the GS1 system |
| ISO/IEC 15434 | Syntax for high-capacity ADC media | Not used for GS1 element strings in symbols (only for mixed formats) | GenSpecs mentions; not required |
| ISO/IEC 15415 / 15416 / 29158 | Print quality grading (2D / 1D / DPM) | Verification, out of scope for an encoder | GS1 1D and 2D Barcode Verification Process Implementation Guidelines (data checks only) |
| ISO/IEC 15418 / ANSI MH10.8.2 | AI and Data Identifier registry | AI mapping | GS1 AI JSON-LD and Syntax Dictionary (authoritative for AIs) |
| ISO/IEC 15961 / 15962 | RFID data protocol (Packed Objects) | TDS user memory | `data/tds-2.3-packed-objects-id-table.csv` plus TDS 2.3 |
| ISO/IEC 18000-63 | UHF RFID air interface | Tag memory context | GS1 EPC UHF Gen2 Air Interface Protocol 3.0.1 is free at https://ref.gs1.org/standards/gen2/ (not downloaded; only memory bank layout is relevant and TDS covers it) |

Notes:

- ISO publishes free preview pages (scope, terms, table of contents) via the ISO Online Browsing Platform (https://www.iso.org/obp) and national stores; these do not contain the encodation tables.
- Open-source cross-references (not official, use only for comparison): Barcode Writer in Pure PostScript (BWIPP, MIT), Zint (BSD-3), zxing-cpp (Apache-2.0). BWIPP and Zint both implement every GS1 symbology including DotCode and GS1-mode Aztec.
- Documents searched for but not existing as separate official GS1 publications in 2026: a dedicated GS1 QR Code guideline, GS1 DotCode guideline, GS1 Composite guideline, GS1 DataBar technical introduction, and ITF-14 guide. Their content lives in GenSpecs 26.0 section 5.
