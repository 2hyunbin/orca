# Coding-language plugin

Replace the example language identity, extension, configuration and grammar. Keep `execution: data`. Run `node .orca-tooling/src/cli.mjs validate .`; no dependency installation is needed. Commit a representative fixture and open it in Orca to check highlighting. Grammar evaluation is isolated and bounded by the host.

Only the supported JSON grammar and literal configuration subset is accepted. No JavaScript, injection into other grammars or undeclared package dependencies. A changed manifest cannot silently add a worker or viewer. Packages that add execution need the corresponding execution profile and fresh user review.

Replace sample license/authorship with the provenance of your grammar. Commit all prebuilt/data files, bump the manifest version, tag that exact commit, and run `node .orca-tooling/src/cli.mjs catalog export . --source YOUR_HTTPS_OR_SSH_REPOSITORY --ref v1.0.0 --license MIT`. Submit the generated metadata in a catalog PR.
