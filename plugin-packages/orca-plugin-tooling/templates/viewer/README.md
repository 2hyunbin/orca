# Opened-file viewer

Run `npm ci --ignore-scripts`, `npm run typecheck` and `npm run build`. Then run `node .orca-tooling/src/cli.mjs validate .`. The public SDK is vendored at a pinned version; this repository works without an Orca source checkout or a published npm name.

The example uses only metadata and a bounded byte read. Authors run in a worker, return text/table/pixels, and receive no DOM, Node, filesystem path or general network API. Orca renders the UI and owns navigation, copying and file permissions. Review and approve opened-file access before testing a development install. Write operations are unavailable.

Adapt the selector, parser, fixtures and declared format limits. Test unsupported/hostile input; host limits are recovery boundaries, not a substitute for a bounded parser. Do not calculate executable content or run native converters. Commit the built `dist/example.worker.js` before tagging. CI rebuilds it and fails on byte differences.

Replace sample license/authorship, bump manifest semver and tag the exact commit. Run `node .orca-tooling/src/cli.mjs catalog export . --source YOUR_HTTPS_OR_SSH_REPOSITORY --ref v1.0.0 --license MIT` and submit the JSON in a catalog PR. Users install committed prebuilt files; they run no dependency installation or build script.
