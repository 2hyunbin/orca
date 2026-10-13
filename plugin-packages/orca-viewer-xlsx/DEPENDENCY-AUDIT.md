# Parser dependency review

Reviewed 2026-10-08 against the pinned installed sources and upstream primary documentation. This is a bounded implementation review, not a claim of universal workbook fidelity or completed platform validation.

| Approach                                         | Corpus/security fit                                                                                                                     | Decision                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Whole-archive extraction followed by DOM parsing | Expansion occurs before application limits; duplicates and deceptive ZIP headers need separate treatment; unavailable DOM in the worker | Excluded before corpus execution                       |
| Native spreadsheet conversion                    | Introduces executable programs, external process/file authority and cross-platform deployment requirements outside this viewer contract | Excluded before corpus execution                       |
| Raw streaming ZIP inflation plus streaming XML   | Incremental size/CRC checks, bounded compressed feeds, incremental XML events and no document DOM                                       | Implemented; current synthetic ZIP/OOXML corpus passes |

A second format engine, `exceljs` 4.4.0 (MIT), was installed only in an isolated comparison directory and run against the same six committed workbooks. Both implementations open all three producer-generated documents (ordinary/hidden worksheets, 1904 dates and the sparse boundary), and both refuse the truncated ZIP. The comparison engine rejects the two minimal fixtures with omitted row/cell coordinates; the bounded adapter supports those implicit coordinates. This difference is recorded rather than treated as a universal compatibility advantage.

Inspection of the comparison engine's browser path found whole-part `entry.async('nodebuffer')` expansion before XML streaming, without an application-controlled expanded-byte callback. Its production dependency audit reported two moderate advisories on 2026-10-08. It is not shipped. The incremental implementation is selected for this package because it can enforce expansion limits before consuming the whole part. The initial six-file comparison is complete; a broader desktop-producer corpus and hostile resource measurements remain required.

`fflate` 0.8.3: inspected raw `Inflate` input/output allocation and callbacks in the browser module. Input is fed in 1 KiB increments. The callback checks the absolute parse deadline, actual per-part/cumulative size and advertised size before consuming XML, then checks final CRC and length. Only referenced parts inflate. Central-directory limits apply to all parts. The package does not use `unzipSync`, async inflation, library-created workers or a whole expanded archive buffer.

`sax` 1.6.1: inspected strict entity lookup, DTD callbacks, position-based buffer limits and the optional Node stream dependency. The build substitutes only the unused Node stream wrapper; parsing uses `SAXParser`. Strict XML entities are enabled, DTDs are refused, UTF-8/UTF-16 decoding is fatal on bad encoding, tags/attributes/depth are bounded and decoded input is submitted in 16 KiB slices. Default position tracking is retained because buffer checks depend on it.

Production dependency audit currently reports zero advisories for these exact versions. That result does not establish sandbox security; host isolation and hostile installed-package tests are separate gates.

Corpus covers stored/deflated OOXML, transitional/strict namespaces, UTF-16, multiple sheets, Unicode/rich text, cached/missing formulas, dates and both date systems, sparse extreme dimensions, invalid cells, external links/macros, traversal relationships/ZIP names, malformed XML, DTD/entities, depth/text limits, deceptive expanded lengths, CRC mismatch, encrypted ZIP flags, local-header mismatch, truncation and short reads.

Native macOS integration now installs the exact built package through the pinned catalog, obtains explicit executable-viewer approval, opens the independent producer workbook, changes sheets, scrolls a dense workbook horizontally, refuses a malformed ZIP and recovers after replacing the document and selecting Retry. Actual native screenshots are retained in the local implementation report. Both format packages use the same public viewer API.

Remaining before public release: extend the candidate comparison to a broader desktop-producer corpus; measure large legitimate and hostile input memory/liveness; validate packaged macOS/Linux/Windows and remote transport. Standalone CI jobs are prepared for all three operating systems; native packaged results are not yet available.

Primary references: [inflater source](https://github.com/101arrowz/fflate), [XML parser source](https://github.com/isaacs/sax-js), [Open XML shared strings](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/working-with-the-shared-string-table), [Open XML cell data](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.cell).

Comparison source: [format engine](https://github.com/exceljs/exceljs), versioned installed `lib/xlsx/xlsx.js`. Producer: [workbook writer documentation](https://openpyxl.readthedocs.io/en/stable/), pinned installed version 3.1.5.
