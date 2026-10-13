# XLSX tables

A standalone Orca file-viewer package. It opens worksheets as read-only tables using the public `@orca/plugin-sdk/viewer` contract. All parsing runs inside Orca's isolated worker; the package receives bytes only for the document the user opens.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

Commit `dist/xlsx.worker.js`, `orca-plugin.json`, `LICENSE` and `THIRD-PARTY-LICENSES.txt` in a release. Orca installs that prebuilt worker; it does not run package scripts or install dependencies. `package-lock.json` pins authoring dependencies. The vendored SDK archive includes its source and license, so this directory can become an independent `orca-viewer-xlsx` repository without access to the application checkout. When the public SDK is published, replace the archive dependency with an exact published version.

Supported: multiple worksheets, sparse cells, shared/rich/inline strings, Unicode, booleans, errors, ISO dates, common numeric/date/time/percentage styles, and cached formula results. Dates use an unambiguous ISO display; the 1900 leap-day placeholder is preserved. Unsupported custom number formats display their stored number. Formula results are identified as cached; missing results say “Cached value unavailable.” Formulas are never calculated. Hidden worksheets are available in the sheet picker.

Macro-enabled workbooks, external workbook links, connections, encrypted ZIP entries, ZIP64 and DTDs are refused. Plain hyperlink text is displayed without navigation. Charts, drawings, merged-cell layout and conditional formatting are not rendered. Rich text is shown as plain text. The viewer never saves or opens another application.

Bounds: 50 MiB input, 128 MiB cumulative declared/actual expansion, 20 MiB per part, 10,000 parts, 100 sheets, 500,000 cells/shared strings, 32 MiB retained text, 8,192 code units per value, 1 million rows and 16,384 columns, 2 million XML elements, depth 64, and 10 seconds total parsing. Every read is at most 192 KiB. Decompression consumes at most 1 KiB compressed input per step, validates actual expansion and CRC, and yields periodically for host liveness. Sparse dimensions do not allocate empty cells. Orca separately bounds each visible table response and owns the table UI.

Runtime dependencies are `fflate` 0.8.3 (MIT) and `sax` 1.6.1 (Blue Oak Model License 1.0.0). The worker uses raw streaming inflation and the synchronous XML parser. It does not use whole-archive extraction, a DOM, the optional Node stream wrapper, or asynchronous library workers. Exact dependency licenses ship with the release. See `DEPENDENCY-AUDIT.md` for the current review and its remaining release gates.
