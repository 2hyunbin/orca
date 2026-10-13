# Orca plugin tooling

An offline CLI and library for interface-language, syntax and host-ui file-viewer packages. It uses a bundled snapshot of Orca's actual runtime validators. No Electron installation, core checkout or runtime npm dependency is required. This package and `@orca/plugin-sdk` are prepared artifacts; npm name ownership and publication are not established by this change.

From this repository run `node src/cli.mjs --help`. An installed tarball exposes `orca-plugin`. Node 22.16+ and system Git 2.25+ are required. Use your platform's normal Git credentials when publishing; these commands make no network requests or credential changes.

```sh
orca-plugin init locale ../orca-plugin-locale-pt-br --publisher alex --id locale-pt-br
orca-plugin init syntax ../orca-plugin-syntax-example --publisher alex --id syntax-example
orca-plugin init viewer ../orca-plugin-viewer-example --publisher alex --id viewer-example
```

Every generated repository includes a fixed `.orca-tooling` snapshot, license notices, a pinned CI workflow and a working example. Data templates require no dependency install. The viewer template includes the independent SDK tarball, a locked development toolchain, fixtures and prebuilt output. `init` never initializes Git, executes plugin code or overwrites an existing directory. Rename the sample, identify maintainers, review the license and adapt its fixture before publishing.

## Commands

| Command                                                                                         | Behavior                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate DIRECTORY [--kit KIT]`                                                                | Validate the strict v2 manifest, execution profile and declared locale/grammar/prebuilt viewer artifacts; require nonempty LICENSE. Author directories may contain ignored development files.                                                                                                             |
| `inspect DIRECTORY [--kit KIT]`                                                                 | Validate and hash a complete self-contained release tree using the host's exact content-hash algorithm; report size, types, execution and translation coverage. Symlinks, unsafe paths and oversized trees fail.                                                                                          |
| `pack GIT_REPOSITORY NEW_DIRECTORY [--kit KIT]`                                                 | Copy committed files at HEAD into a new directory outside the source; compare every file with its committed Git blob identity. Reject symlinks/submodules, missing or changed files and uncommitted prebuilt output. Return exact commit/hash. Ignore untracked files; never execute build/install hooks. |
| `catalog export GIT_REPOSITORY --source URL --ref VERSION_TAG --license LICENSE_ID [--kit KIT]` | Package/validate in a temporary directory; require the local version tag to match the packaged commit and manifest semver; emit a v2 listing with derived contribution types and exact hash. Remote source/tag ownership is rechecked by the installer, not attested offline.                             |
| `catalog diff PREVIOUS_JSON CURRENT_JSON`                                                       | Validate two catalog v2 documents and report added/removed/changed listings, source/execution/type/byte changes and catalog-owner changes. Does not grant approval.                                                                                                                                       |
| `locale export ENGLISH_JSON NEW_KIT_JSON`                                                       | Export canonical eligible source text/hashes; preserve security-copy exclusions and bounded traversal. Refuse to overwrite a kit.                                                                                                                                                                         |
| `locale diff PREVIOUS_KIT CURRENT_KIT`                                                          | Verify both kits' hashes and report added/changed/removed keys. Does not refresh translations or mark them reviewed.                                                                                                                                                                                      |

All results are JSON on stdout; errors use stderr and exit 1. License IDs are author assertions; validation checks the included license text exists, not legal suitability. JSON schemas under `schemas/` are generated editor aids. Zod refinements, path containment, cross-field classification, grammar includes, freshness, protected copy and byte limits require the CLI/runtime validator. Do not use JSON Schema alone as an installation or consent boundary.

Generated repositories commit `.gitattributes` with `* -text` so text and binary bytes stay identical under Windows-style line-ending settings. Keep that file. `pack` rejects transformed or changed local files and shares the installer’s portable tree validator: directories count toward the 2,000-entry bound; file contents total at most 50 MiB; paths are at most 1,024 UTF-8 bytes/depth 64, without case/Unicode collisions, symlinks, submodules or reserved metadata aliases. The app downloads exact Git blobs without checkout filters or hooks; commit real prebuilt artifacts rather than LFS pointers.

## Independent release

1. Run the template's validation and fixtures. Viewer authors run explicit `npm ci --ignore-scripts`, typecheck, build and test; commit `dist` output. Users never run that toolchain.
2. Commit the complete release tree. Keep untracked files and installed dependencies out of Git. Version and source hashes represent the full tracked checkout, including README/license/CI; a hand-picked artifact hash is not interchangeable.
3. Tag the matching semver commit. Run `catalog export` with the intended HTTPS/SSH repository and license ID. Submit the listing to a reviewed catalog. Its checked revision and bytes do not transfer to another branch/tag.
4. Data updates remain data. Adding a worker, instructions or viewer requires the corresponding profile and fresh review in Orca. The toolkit never changes installed approvals.

Keep one repository per independently maintained package, using names such as `orca-plugin-locale-pt-br`, `orca-plugin-syntax-example` and `orca-plugin-viewer-example`; publisher-qualified IDs remain independent of repository spelling. Supported Git providers work through HTTPS or SSH. No central author account is required. Community authors may submit package improvements or independent catalog entries.

## Updating shared tooling

The core generator is `node config/scripts/snapshot-plugin-tooling.mjs`. It refreshes the bundled runtime, four schemas and the English translation kit; CI checks drift against the host sources. Generated templates vendor a copy rather than downloading mutable tooling in contributor CI. Refresh that snapshot deliberately, review its source/license changes, and update only reviewed translations. New toolkit releases do not publish plugins or edit external repositories automatically.
