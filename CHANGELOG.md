# Changelog

Breaking changes are marked. Until 1.0, a minor version may break the API.

## 0.10.0 (2026-10-15)

- `epc.decode` and `epc.fromElementString` take `companyPrefixLength` (a number or lookup, as for legacy encoding) for plus EPCs too and set `fields.companyPrefix` from it, so legacy and plus EPCs of one key can have identical fields. Without it, or when the lookup returns `undefined`, `companyPrefix` is left out. The option moved from `EpcFromElementStringOptions` to `EpcEncodeOptions`. A length that does not fit the key, or a value of the wrong type, is `INVALID_EPC` (`gcp-length`); the wrong-type error no longer carries the key AI.
- `try*` functions never throw. An argument they cannot read (options of the wrong type or `null`, a throwing getter, Proxy, iterator or `companyPrefixLength` lookup) is `SYNTAX` with `details.reason` `argument`. `identifyKey` of a non-string returns `[]`.
- Breaking: object input to `validate` and `ElementString.from` takes at most 10,000 entries.
- Breaking: Digital Link rejects `.` and `..` path segments (also spelled with `%2e`) when parsing and building, with the new `INVALID_DIGITAL_LINK` reason `dot-segment`. The host must be a name of letters, digits, `-` and `.`, or an IPv6 address in brackets, with an optional port up to 65535; anything else is `domain`, in a parsed URI and in the `domain` option.
- Breaking: "++" hostnames are letters, digits, `-`, `.` and `_` (and `:` for a port on decode). A binary with any other hostname character is `INVALID_EPC` (`binary`); a `hostname` option with one is `INVALID_EPC` (`hostname`).
- Breaking: a raw EPC URI's hex value has at most 124 digits and its decimal value at most 150, and any EPC URI at most 1024 characters; longer is `INVALID_EPC` (`syntax`).
- Breaking: `toSvg` `foreground` and `background` must be colors (`#` and 3, 4, 6 or 8 hex digits, a color name, `rgb()`, `rgba()`, `hsl()` or `hsla()`); `url()` and other paint references are `INVALID_VALUE`. The image is at most 1,000,000 units wide and high (`INVALID_VALUE`, `details.option` `moduleSize`). Encoder `height` is at most 1000 modules for EAN/UPC, ITF-14 and GS1-128, and ITF-14 `bearerWidth` is from 2 to 100.
- An `UNKNOWN_AI` error for an object key echoes the key in `message` and `ai` only when it is 2 to 4 digits.
- Docs: HRI text is for display and does not parse back; values can contain HTML characters and must be escaped before display.
- `prepublishOnly` runs `pnpm check`. The TDT vector generator checks the GS1 tarball's SHA-256 before extracting it.

## 0.9.0 (2026-10-13)

- Every EPC, legacy or plus, has `fields`: its data by name, with the GS1 names `ElementString` uses (`gtin`, `serial`, `batch`, `sscc`, `gln`, ...) and the same names for a legacy and a plus EPC of one scheme. Legacy EPCs add `companyPrefix`; gid, usdod, adi, bic and imovn keep their TDS component names. A single `scheme` check types `fields` on both kinds.
- Breaking: the TDS reference names (`itemReference`, `serialReference`, `locationReference`, `assetType`, ...) are gone from `fields`; `components` still has the URI parts. AI (10) is `batch`, not `lot`.
- Breaking (type level): `PlusEpc` is a union type alias discriminated by `scheme`, not an interface, so `interface X extends PlusEpc` no longer works.

## 0.8.0 (2026-10-13)

- `IdentityEpc.fields` names every component of the 21 pure schemes, URI escapes removed, typed per scheme (`EpcFields<S>`). Plus EPCs are unchanged.
- Breaking (type level): `IdentityEpc` is a union type alias discriminated by `scheme`, not an interface, so `interface X extends IdentityEpc` and module augmentation of it no longer work. Reading its properties and narrowing are unaffected.

## 0.7.0 (2026-10-12)

- New `aidc/qr`: `gs1Qr` (GS1 QR Code, Model 2, versions 1 to 40, levels L, M, Q and H) and `qr` (QR Code as a GS1 Digital Link carrier), with encode and decode, and the types `QrOptions`, `QrDlOptions`, `QrMetadata` and `QrEcLevel`. Also exported from the root. See [2D barcodes: QR Code](README.md#2d-barcodes-qr-code).
- Additive only. `SymbologyName` adds `'gs1-qr'` and `'qr'`, and `SYMBOL_SPECS` has rows for them. New `INVALID_SYMBOL` reasons `format` and `version`; new `UNSUPPORTED` reason `kanji`. The reasons `size`, `finder`, `timing` and `codeword` now also come from QR (`timing` was reserved in 0.6.0).
- The mask is chosen with the BWIPP-compatible penalty rules, so it matches bwip-js and the GS1 barcode engine; the `mask` option forces a mask.

## 0.6.0 (2026-10-12)

- New `aidc/datamatrix`: `gs1DataMatrix` (GS1 DataMatrix ECC 200, all 30 sizes) and `dataMatrix` (Data Matrix as a GS1 Digital Link carrier), with encode and decode, and the types `DataMatrixOptions`, `DataMatrixDlOptions`, `DataMatrixMetadata`, `DmMode` and `DmSizeOption`. New `ModuleMatrix` output type, `matrixFromRows` and `moduleAt` in `aidc/render`; `toSvg` renders matrices. See [2D barcodes: DataMatrix](README.md#2d-barcodes-datamatrix).
- New error code `RS_UNCORRECTABLE`. New `INVALID_SYMBOL` reasons `size`, `finder`, `codeword` and `timing` (reserved; DataMatrix does not produce it). New `UNSUPPORTED` reasons `macro`, `eci`, `structured-append`, `reader-programming`, `fnc1-second` and `dmre`.
- Breaking: the internal render helpers (`freezePattern`, `symbolError`, `notRepresentable`, `dataTooLong`, `readRows`, `readPlacedRows`) are no longer exported from `aidc/render`. They were marked `@internal` and live in a non-exported module now.
- Breaking (behaviour): decode results are frozen for every symbology, linear included: the `DecodedSymbol`, its `metadata` and the arrays inside it. Code that mutated a result must copy it first.
- Breaking (type level): `Symbology` has a third type parameter, `S extends LinearPattern | ModuleMatrix = LinearPattern`, for the symbol type of `encode`, `tryEncode`, `decode` and `tryDecode`. Declarations that name `Symbology<Opts, M>` compile unchanged. `SymbologyName` adds `'gs1-datamatrix'` and `'datamatrix'`, and `DecodedSymbol` has an optional `digitalLink`.
- `SYMBOL_SPECS` has rows for the two DataMatrix names; `minHeight` is optional.
- Reed-Solomon and GF(256) arithmetic are internal to the library and not exported.

## 0.5.0 (2026-10-12)

- New linear symbologies: EAN-13, UPC-A, EAN-8 and UPC-E with 2 and 5 digit add-ons (`aidc/ean-upc`), ITF-14 (`aidc/itf`) and GS1-128 (`aidc/gs1-128`): encode to a `LinearPattern`, decode from one. New `aidc/render` with `toSvg`, `tryToSvg`, `linearPattern` and `SYMBOL_SPECS`. All are also exported from the root. See [Barcodes](README.md#barcodes).
- New error codes: `INVALID_SYMBOL`, `DATA_TOO_LONG` and `NOT_REPRESENTABLE`.
- Breaking: `toScan(es, 'ean-13')` now fails with `INVALID_SCAN` (`not-representable`) for a 13-digit value that starts with `00000` followed by two digits that are not `00` (the unused GTIN-8 range, GenSpecs Table 1-4); it used to emit it. The EAN/UPC decoders are lenient the other way: they accept a 13-digit value in that range (prefixes 0000001 to 0000099) even though the encoders and `toScan('ean-13')` refuse to produce one.
- Dev dependencies for differential tests only: bwip-js 4.11.4 and zxing-wasm 3.1.5. They are not distributed.

## 0.4.0 (2026-10-10)

- The EPC "+" and "++" schemes (TDS 2.x): 24 binary schemes, +AIDC data, the DSGTIN prioritised date and "++" hostnames. They decode and encode through the existing `epc` functions; `fromElementString` gains the options `hostname`, `dateAi` and `aidc`.
- Breaking (type level): `Epc` is now the union `IdentityEpc | PlusEpc`. Code that reads `pureIdentityUri` or `tagUri` must first narrow on `kind` (`kind === 'plus'` has neither).
- Breaking: "+" and "++" EPCs no longer fail with `UNSUPPORTED` reason `epc-scheme`; they decode. `epc-scheme` is no longer produced.
- Compressed Digital Links (`eh`, `ex`) now carry "+" and "++" EPCs. For "++" the URI stem wins over the hostname in the binary (DL Compression 1.0.0 4.2 step 3).
- Tables for the plus schemes are generated into `src/epc/tables.gen.ts` from the GS1 TDT 2.3 draft.

## 0.3.0 (2026-10-10)

- New `epc` module (`aidc/epc`, root export `epc`): GS1 Tag Data Standard 2.3 decoding and encoding for the 22 legacy binary schemes, tag, raw, pure identity and LGTIN class URIs, and mapping to and from element strings.
- New error codes: `INVALID_EPC`, `EPC_FIELD_OVERFLOW`, `EPC_UNKNOWN_HEADER` and `GCP_LENGTH_UNKNOWN`.
- Breaking: compressed Digital Links that carry an EPC (`eh`/`ex`) no longer fail with `UNSUPPORTED` reason `epc-compressed-link`. A legacy EPC now decodes to its element string; a "+" or "++" scheme fails with `UNSUPPORTED` reason `epc-scheme`; an invalid EPC fails with `INVALID_DIGITAL_LINK` (`compressed-segment`). Code that matched `epc-compressed-link` must be updated.
