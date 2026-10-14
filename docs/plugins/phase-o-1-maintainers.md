# phase-o-1 · Independent plugin maintenance

_Implemented author-tooling contract, 2026-10-08. The package is prepared locally; npm publication, name ownership and external repository creation are not claimed._

## Start a repository

The independent `plugin-packages/orca-plugin-tooling` package exposes `orca-plugin`. Its CLI runs without Electron, the Orca checkout or runtime dependencies. Use Node 22.16+ and system Git 2.25+. The committed runtime snapshot bundles the same manifest, locale, grammar, path and content-hash implementations the host uses.

```sh
orca-plugin init locale ../orca-plugin-locale-pt-br --publisher alex --id locale-pt-br
orca-plugin init syntax ../orca-plugin-syntax-example --publisher alex --id syntax-example
orca-plugin init viewer ../orca-plugin-viewer-example --publisher alex --id viewer-example
orca-plugin init environment ../orca-environments-company --publisher company --id environments
```

Inside the core checkout, replace `orca-plugin` with `node plugin-packages/orca-plugin-tooling/src/cli.mjs`. `init` creates a new directory and refuses existing destinations. It creates no Git repository, tag, remote source or external account. Choose a package name, credit maintainers, review its license and initialize Git yourself.

Use one repository for each independently maintained package. The catalog remains a small separate index. Repository naming is a convention; authority comes from reviewed identity/source, never an official-looking repository name. Community publishers use their own namespace. HTTPS and SSH sources work with supported Git providers.

## What templates contain

| Template    | Example                                                          | Author checks                                                                                                           |
| ----------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Locale      | A partial Portuguese envelope with one current translation       | Data profile, declared locale, eligible source hashes, placeholders, protected copy and coverage                        |
| Syntax      | A small JSON grammar, literal language configuration and fixture | Data profile, bounded syntax/configuration, declared scopes and package-local includes                                  |
| Viewer      | A worker displaying file metadata and at most 64 prefix bytes    | Sandboxed UI profile, opened-file SDK types, prebuilt output, bounded/empty-file fixtures                               |
| Environment | Prebuilt account-aware Node adapter for a company HTTPS service  | Executable instructional approval, six lifecycle commands, separate receipt queries and contained/bounded adapter bytes |

Each generated repository vendors a `.orca-tooling` snapshot, five editor schemas and the eligible English kit, with its licenses. Its CI uses exact action revisions, a pinned Node version, read-only permissions and no persisted checkout credentials. Data packs require no dependency installation. The viewer includes a pinned independent SDK tarball and development lockfile; its build/test toolchain runs in author CI. Installing users execute none of those build commands.

Run `node .orca-tooling/src/cli.mjs validate .`. The viewer additionally runs `npm ci --ignore-scripts`, typecheck, build and tests. Commit its prebuilt worker; CI rebuilds and rejects differences. Author validation ignores unrelated development files, while release inspection enforces the complete self-contained tree. The toolkit deliberately validates the four supported families; other contributions use their host-specific validators until that author contract is added.

## Translation refresh

The kit contains English values and per-entry source hashes. Translate reviewed entries and keep their matching hashes. Missing/stale entries fall back to English. `locale export ENGLISH_JSON NEW_KIT_JSON` generates a kit using the runtime's protected-copy exclusions and bounded traversal; it refuses to overwrite an existing output. `locale diff OLD_KIT NEW_KIT` verifies hashes and reports added, changed and removed keys.

Review changed source before updating a translation's hash. The CLI does not mark translated text reviewed, stamp hashes, publish a release or open a maintainer PR. `validate --kit NEW_KIT` reports current, missing, stale and obsolete counts separately. That author-supplied kit is a preview reference; the app validates against its own English source kit at installation and activation.

## Exact release bytes

```sh
orca-plugin pack REPOSITORY NEW_RELEASE_DIRECTORY
orca-plugin inspect NEW_RELEASE_DIRECTORY
orca-plugin catalog export REPOSITORY --source HTTPS_OR_SSH_URL --ref v1.0.0 --license MIT
orca-plugin catalog diff OLD_CATALOG_JSON NEW_CATALOG_JSON
```

`pack` reads HEAD through baseline-compatible Git commands, copies its tracked files and compares each file's Git blob digest. Untracked dependencies are excluded. Missing/modified tracked files, symlinks, submodules, unsafe portable paths, oversized trees and uncommitted viewer entries fail; failed output is removed. Output must be a new directory outside the canonical repository root. Existing output is preserved. No plugin or package hook executes.

`inspect` uses the host's length-framed SHA-256 tree hash, 2,000-entry and 50 MiB limits, plus artifact checks. The hash includes the full checked-in tree: README, license, source, tooling and CI. A separately selected set of viewer files cannot substitute for the installer checkout's hash.

Generated repositories include `.gitattributes` with `* -text`; keep it committed. Text and binary release bytes then survive Windows-style `core.autocrlf=true` checkouts unchanged. The actual npm archive initializes, commits, reclones and packages all four templates with that setting; their hashes match the originals. The tool and installer use the same portable Git tree validator, including directory counts, bounded path depth/length and case/Unicode collision rejection. A transformed local checkout fails `pack` rather than publishing bytes that differ from the commit.

The installer fetches with system-Git credentials but extracts raw committed blobs without checkout, author-selected filters, template hooks, submodule execution or LFS downloading. Attribute transformations cannot change the approved release or execute a configured filter during preview. Commit actual prebuilt worker files rather than LFS pointers. The 50 MiB tree bound applies to extracted file content; it is not a hard transport-pack or download-disk ceiling.

Exact releases accept SHA-1 and SHA-256 commit identities. SHA-1 stays compatible with Git 2.25. SHA-256 staging explicitly uses the matching object format; unsupported Git gets a clear update/retry error before fetch. The host capability cache remembers only recognized unsupported-format failures, coalesces concurrent probes and isolates native/WSL hosts. Permission, disk and transport errors remain retryable. An inherited `GIT_DEFAULT_HASH` cannot change SHA-1 staging. The real-binary CI matrix includes Git 2.25.5, the 2.29.0 SHA-256 boundary and newer versions. [The pinned 2.29 release notes](https://raw.githubusercontent.com/git/git/v2.29.0/Documentation/RelNotes/2.29.0.txt) describe SHA-256 repository support; runtime admission probes the command rather than relying on a version string.

`catalog export` packages in a temporary directory, requires a local version tag at the exact packaged commit and checks tag/manifest semver. It derives identity, contribution types, execution and compatibility, emitting the version, commit and host-compatible hash. The license identifier is the author's assertion; a nonempty license file is required, but legal suitability is not certified. Submit this metadata in a catalog PR. The app rechecks the actual remote ref, commit, bytes and source ownership before installation; offline tooling does not attest that a remote contains the local tag.

`catalog diff` reports listing additions/removals, version/source/execution/type/byte changes and owner changes. It never approves changed code, instructions or ownership. Updating a catalog does not rewrite existing installed approvals.

## Security and shared tooling

Data profiles reject worker entries, viewers, instructions and unsupported fields. Adding execution requires the correct manifest profile and fresh user review; language/syntax labels do not preserve old authority. `validate`, `inspect`, `pack` and catalog export only inspect artifacts and never execute a candidate. Host approval remains the activation boundary.

The generated JSON schemas are editor aids. JSON Schema cannot represent every Zod refinement, cross-field class rule, filesystem check, freshness constraint or byte bound. Use the CLI/runtime validator for release checks, not an editor's green schema badge.

Core maintainers regenerate with `node config/scripts/snapshot-plugin-tooling.mjs`; `--check` compares without writing. It verifies the runtime bundle, four schemas and English kit. Independent-package CI prepares the check on macOS/Linux/Windows; these configured jobs are not evidence of a completed platform run. Refresh vendored tooling deliberately and review source/license changes. Contributor CI has no publishing secrets. Opt-in translation-refresh PR automation remains future work.

## App-owned data snapshots

The first migrated snapshots live in `resources/plugins/launch/stablyai.orca-locale-es` and `resources/plugins/launch/stablyai.orca-syntax-typst`. `bundled-plugins.json` marks them `activation: "bundled-data"` and pins their complete tree hashes. They remain app resources; startup never copies them over an installed release or version pin. Optional releases still use the normal reviewed Git/catalog source and qualified package identity. The Included with Orca controls disable/restore each family without removing its resources or changing optional-package approval.

Run `pnpm run sync:bundled-data-plugins` after deliberate core-source changes, then `pnpm run verify:bundled-data-plugins`. The build runs the verification automatically. Generation uses the actual host manifest, locale, grammar and tree validators, preserving grammar license/provenance files. It also regenerates the core-only Spanish security resource; review security-copy changes in core.

Existing locale-envelope source hashes are translator review receipts. Regeneration preserves them, so an English source change reports stale entries and falls back to English. Use the locale kit/diff workflow to review a translation and update its receipt; do not refresh all hashes merely to make a build green. New ordinary strings may intentionally be missing. The generated protected resource contains only core-reviewed keys and is separate from package translation authority.

Independent repositories can publish later locale or grammar releases through the same author tooling and catalog workflow. Their immutable commits, source ownership and full hashes must validate before install. A matching development-directory identity cannot take over a bundled alias. A dedicated official local-preview workflow remains future work; use a separate contribution identity for development previews. No external repositories or releases have been created by this implementation.

The local migration passes offline defaults, optional-plugin-off behavior, main/renderer translations and plurals, native worker highlighting, disable/restore, restart and approved installed-pin precedence. Actual packaged resources, app upgrades and the supported client/host matrix remain release checks.

## Verified locally

The real npm tarball initializes all four templates from a `node_modules` installation, including creating another repository from a vendored snapshot. A separate temporary directory outside the Orca checkout validates, commits, tags, packages, exports and inspects all three, with matching catalog/packed/host hashes. The viewer independently installs its locked author dependencies, typechecks, builds and passes two fixture tests; rebuilt output is byte-identical. The toolkit has 19 passing tests, including malformed profiles, changed/unsafe release files, kit drift, actual archive contents, binary-icon containment and non-overwrite behavior.

A real background macOS Electron journey installs all three generated packages through catalog/Git/IPC, applies the partial locale (the visible language field becomes “Idioma”), colors an opened syntax fixture, explicitly approves opened-file access and displays actual binary bytes through the viewer. The packages use a community publisher and a GitLab-style HTTPS source mapped to isolated local Git repositories; this verifies provider-neutral Git installation, not an external GitLab API or credential service. Six actual screenshots record those steps. The broader native catalog and XLSX/STL regression journeys also pass. Packaged Windows/Linux and live remote execution remain integration gates.

## Company environment adapters

[Repository-shipped adapters](environment-portable-adapters.md) use Orca’s pinned Node runtime and explicit account-level code approval. The environment template validates offline without executing code; its eight client/bundle tests run from a generated repository without dependency installation. Authors explicitly install the pinned build tool with `npm ci --ignore-scripts` when changing source, keep the included lockfile and prebuilt single ESM bundle, then use the same exact release and catalog commands. Its contributor CI only validates files and receives no backend credentials.
