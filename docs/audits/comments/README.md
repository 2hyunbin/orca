# Code comment audit

Status: active. Stop at **2026-10-24 11:00 America/Los_Angeles** (18:00 UTC).

Remove comments that repeat code, names, or test assertions. Correct stale claims. Keep concise explanations of otherwise hidden constraints, ideally one line. Preserve licenses, generated-file notices, compiler/linter/test directives, compatibility markers, and required SAFETY rationales. Review generated or vendored boundaries before changing them.

## Coverage

[inventory.json](./inventory.json) records the initial tracked-file inventory, parser counts by area, and reviewed file hashes. Its counts reflect the first batch's working tree at the recorded baseline; they are a snapshot, not a claim that the audit is finished. JavaScript/TypeScript comment detection uses the Oxc parser, including inline and block comments rather than text matching. Other languages require separate review. Prose documentation, lockfiles, binary assets, and data-only JSON are outside the source inventory; executable examples and documentation scripts are included.

The initial inventory contains 37,236 source/configuration files and 217,090 JavaScript/TypeScript comments after the first cleanup. All inventoried JavaScript/TypeScript files parsed successfully. Files with no parsed comments need no editorial pass at that snapshot; files with comments remain pending unless listed in a reviewed batch. Recheck reviewed hashes and newly added files before declaring completion.

| Batch | Scope                                              | State                                                   | Validation                                                                                                           | PR      |
| ----- | -------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| 1     | `src/preload/*.ts`: all 34 files, excluding `api/` | Reviewed; 19 files edited, 96 net comment lines removed | 104 tests in 20 files pass; changed-code quality and formatting pass; source and emitted-JavaScript tokens unchanged | Pending |

Remaining areas: preload API contracts/bridges, CLI, main, renderer, shared, packages, WSL guest, mobile, cloud, tests, configuration/build scripts, native code, workflows, styles/markup, and extensionless hooks/build files. Preserve full repository scope as batches land; do not treat a completed directory as completion of the audit.

## Validation and delivery

For each batch, read comments with surrounding code, review the diff, compare source tokens, and run relevant existing tests and changed-file checks. Record checks and reviewed file hashes here. Open/update the PR and inspect its full checks, including the aggregate gate, before merging. Continue auditing while CI runs. Record failed-check evidence and retry only failed jobs when the failure is transient.
