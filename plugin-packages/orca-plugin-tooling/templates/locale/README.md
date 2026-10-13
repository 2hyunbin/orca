# Interface-language plugin

Change the name, locale and artifact path in `orca-plugin.json`. Keep `execution: data`. Run `node .orca-tooling/src/cli.mjs validate .`; no dependency installation is needed.

The sample translates one eligible entry. `.orca-tooling/locale-kit.json` contains the English text and source hashes. Translate entries you have reviewed, preserving their source hashes and interpolation tokens. Untranslated entries stay English; old source hashes become stale and fall back to English.

For a new English kit, run `node .orca-tooling/src/cli.mjs locale diff OLD_KIT NEW_KIT`. Review changed text before replacing a translation's source hash. Removing old keys or stamping all hashes as current does not constitute translation review. The validator reports current, missing, stale and obsolete counts separately.

Change the license and authorship to describe your work. Commit all release files, bump the manifest version, and make an immutable matching version tag. Generate a listing with `node .orca-tooling/src/cli.mjs catalog export . --source YOUR_HTTPS_OR_SSH_REPOSITORY --ref v1.0.0 --license MIT`. Submit the output in a catalog PR. Source ownership and permissions are reviewed in Orca.
