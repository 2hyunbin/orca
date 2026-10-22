# Dependency security checks

`pnpm check:dependencies` audits the desktop, mobile, cloud, docs, and isolated
audit-tool lockfiles, including development and optional dependencies. It does not
install those workspaces or execute their pnpm hooks. High/critical advisories and
scanner failures fail the check; lower severities remain visible in JSON reports
under `tmp/dependency-security/`.

The Linux workflow runs on dependency changes, relevant main pushes, daily, and
manually. Its Rust job runs pinned cargo-deny 0.20.2 directly against every native
manifest with `--locked`, all features, and no target restriction. Reports upload
even on failure. These checks do not gate releases or change branch protection.

The only JavaScript exceptions cover previously reviewed local patches. Each
names an exact workspace, package, version, advisory, owner, expiry, patch path,
and SHA-256. An exception is considered only for an actual high/critical finding.
The patch bytes, workspace registration, and locked patch hash/snapshots must
match before the exception applies. Expired exceptions stop exempting findings;
stale exceptions for removed/fixed packages do not fail clean scans. Remove an
exception and its patch when an upstream fixed version replaces them.

This initial check covers JavaScript and native Rust advisories. It does not
establish reachability or scan licenses, container layers, downloaded binaries,
CocoaPods, Gradle, or Ruby dependencies. Registry/advisory outages fail visibly in
CI without blocking release workflows. After installing cargo-deny, the Rust
command can also be run locally:

```sh
cargo deny --manifest-path native/windows-agent-hook/Cargo.toml --locked --config config/cargo-deny.toml check advisories
```
