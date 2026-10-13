# File-viewer corpus

These are authored test documents, not user files. They are distributed under the repository's MIT license.

`Budget.xlsx` and `Dense.xlsx` contain valid ZIP/OOXML parts produced by the standalone viewer's test fixture builder, with cached formula values and dense long text respectively. `Malformed.xlsx` is intentionally truncated. `Pyramid.stl` contains six binary triangle records. Expected values and geometry are defined independently of the parser implementation.

`ProducedBudget.xlsx`, `Produced1904.xlsx` and `ProducedSparse.xlsx` are written by the independent Python workbook producer `openpyxl` 3.1.5, with `et-xmlfile` 2.0.0. They cover ordinary producer styles/relationships, inline Unicode, formulas without caches, hidden sheets, the alternate date epoch and a sparse boundary coordinate. Regenerate with `generate-producer-workbooks.py` in an isolated environment containing those exact versions; Python is not needed to execute the committed corpus.

Copies of the producer files and generation recipe are included in the standalone package's tests, so its entire corpus remains self-contained in an independent repository. The native app journey installs both prebuilt format packages through a pinned catalog and opens these real binary formats through the same public API.
