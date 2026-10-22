# Dependency policy

Run `pnpm check:dependencies` to audit every pnpm workspace, including development
and optional dependencies. Each workspace is installed with its frozen lockfile
and lifecycle scripts disabled before collecting `pnpm audit --json` and
`pnpm licenses list --json`. This does not launch Orca or rebuild native modules.

Select one workspace with `pnpm check:dependencies --workspace mobile` (repeat the
option to select several). `--root /path/to/checkout` scans another checkout with
the current tooling and policy; reports stay in the tooling checkout. The configured workspaces are desktop (`.`), mobile,
cloud, the documentation site, and the isolated audit tools.

License inventories cover installed packages for the current host. CI runs the
JavaScript check separately on macOS, Linux, and Windows because pnpm's license
inventory follows the host dependency graph even when other platforms' packages
are installed. Other architectures, libc variants, and packages explicitly
excluded by workspace policy need separate license review. Vulnerability audits
use the lockfiles on every host.

The commands build the internal process wrapper first. On a fresh checkout,
install root dependencies with `pnpm install --frozen-lockfile --ignore-scripts`.
Run `pnpm rebuild:node` or the normal development command afterwards if you need
native modules that a script-free install has not built.

## What fails

[The policy](./dependency-policy.json) blocks high and critical
advisories and licenses outside its explicit allowlist. Lower severity findings
remain visible. SPDX `OR` expressions pass when an allowed option exists; `AND`
requires every obligation to be allowed. Missing, invalid, and custom license
metadata requires review. Copyleft licenses are not broadly allowed by default.

Registry failures, interrupted commands, truncated output, incomplete reports,
stale lockfiles, empty license inventories, and expired exceptions fail the check.
The runner checks the remaining workspaces after a failure and saves JSON reports
under `tmp/dependency-policy/`. Set `--report-dir /absolute/path` to change this.

Existing findings have no automatic baseline exemption. They must be fixed or
explicitly reviewed before this policy can pass. Metadata checks do not establish
code reachability, detect all malicious packages, generate third-party notices,
or establish compliance for redistributed binaries and embedded native libraries.
Keep the existing release delay, build-script restrictions, and bundled license
notices.

## Reviewing exceptions

Advisory exceptions require these fields:

```json
{
  "workspace": "mobile",
  "package": "affected-package",
  "version": "1.2.3",
  "advisory": "GHSA-xxxx-xxxx-xxxx",
  "reason": "Explain exposure, mitigation, and the condition for removal",
  "owner": "Responsible maintainer",
  "expires": "2026-11-01"
}
```

License exceptions use the same fields, replacing `advisory` with the exact
reported `license` expression (including `Unknown` when reviewing missing
metadata). Match the workspace, package, version, and advisory or license exactly.
An exception never covers future versions or another workspace. Exceptions expire
at the start of the named UTC date. Release checks consider expiry only for their
selected workspaces and advisory scope. Retain notices and document the applicable
license terms or usage restrictions in the reason; accepting missing metadata is
not a substitute for checking the distributed license text.

Reviewed high-severity patches from #31681 have advisory exceptions through
2026-11-20. Each records the exact pnpm patch path and SHA-256. The runner checks
both the workspace's `patchedDependencies` registration and the reviewed bytes
before a frozen install; removing, changing, or retargeting the patch fails.
Replace the exception and patch with an upstream fixed release when available.
No license exceptions are included.

## Rust

Install the pinned scanner once:

```sh
cargo install cargo-deny --locked --version 0.20.2
pnpm check:dependencies:rust
```

The runner discovers `native/*/Cargo.toml` and checks every manifest with
`--locked` and [the Cargo policy](./cargo-deny.toml). It checks all
features without restricting the target graph, including build dependencies.
The policy checks advisories and licenses, denies wildcard requirements and
unapproved registries or Git sources, and permits duplicate versions. Unpublished
first-party crates are excluded from license checks, while their dependencies
remain checked. Logs are saved alongside the JavaScript reports.

Rust advisory exceptions are reviewed in the Cargo policy and require a reason.
The dated exception mechanism in the JSON policy applies to pnpm findings only;
cargo-deny manages Rust exceptions separately.

## CI

`Cut Release` resolves the requested ref once and runs a read-only security gate
on that immutable SHA before the write-enabled job can create tags or publish
recovered drafts. It audits desktop, embedded mobile web, isolated build tools,
and native Rust with current advisory databases. Dry runs use the same gate.
Recovered tags must match the scanned source, allowing only a root manifest
version bump. The normal cut also changes only that version before tagging.

`--security-only` retains license findings in JavaScript reports without blocking
on them; Rust runs only `cargo deny check advisories`. JavaScript high/critical
findings, invalid reports and scanner failures block. Lower severities remain
visible; reviewed advisory exceptions must name an exact package/version and
workspace, an owner, a mitigation reason, and an expiry. There are no automatic
exemptions for development dependencies or locally patched versions. A reviewed
patch still requires an explicit exception while registry audits flag its version.
Rust uses cargo-deny's advisory handling and can also block unmaintained crates.

The reusable release security workflow selects a fixed profile:

| Release entry point            | Graph checked                                | Publication dependency                                                          |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------- |
| Desktop cut                    | Root, embedded mobile web, audit tools, Rust | Before tagging and recovered-draft publication                                  |
| Standalone macOS release build | Same desktop graph                           | Before signing/uploading; resolves the tag once and pins checkout               |
| iOS / Android release          | Mobile pnpm graph                            | Before the build/upload job; both use the event commit                          |
| Docs production                | Docs pnpm graph                              | After tag authorization, before deployment credentials; uses the authorized SHA |
| Relay/fence image publication  | Cloud pnpm graph                             | Before new images are built/pushed from the event commit                        |
| Push gateway production        | Cloud pnpm graph                             | Before building the explicitly requested source SHA                             |

Scans check out tooling and policy from the immutable workflow commit, and release
source in a separate directory. Candidate refs cannot replace the scanner or
weaken its policy. Older refs do not need to contain the new tooling. Scans run
with read-only repository access, no inherited release secrets, and script-free installs. Workspaces include development and optional dependencies.
Source inputs must be full commit SHAs; arbitrary release profile names fail.
Reports upload on failure. A failed or cancelled gate cannot enter publication,
including the macOS job's custom status condition.

Existing-image mirrors, rollouts, and rollback jobs keep their digest-based paths.
A source lockfile audit cannot certify an already published container image.
This gate does not scan container layers, downloaded binaries, OS packages,
CocoaPods, Gradle or Ruby dependencies. Native mobile dependency scanning remains
separate work. License findings do not block security-only releases.

The dedicated `Dependency policy` workflow runs for dependency and policy changes,
on relevant pushes to main, every day at 09:37 UTC, and manually. JavaScript and
Rust run as separate jobs; all upload their reports even when findings fail the
check. The scanner version is pinned, while advisory databases stay current.

These workflow jobs report failures but are not automatically required by branch
protection. Making them required is a repository setting and should follow
triage of the initial findings. Because PR runs use path filters, require these
checks only with a ruleset that handles unchanged dependency files, or change the
workflow to run on every PR before requiring it globally.
