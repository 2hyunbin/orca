# Repository-shipped environment adapters

An environment provider may ship a prebuilt Node ESM bundle instead of requiring a separately installed company CLI. This is an executable instructional plugin: installing, inspecting, configuring an account and enabling it do not execute its adapter. Each lifecycle or receipt command runs only after current source/release approval and account/host admission. A data-only language or syntax package cannot declare this family.

```json
{
  "program": "orca:node",
  "entry": "dist/provider.mjs",
  "args": [],
  "timeoutSeconds": 120
}
```

Portable lifecycle commands require protocol 2. The six actions remain create, delete, sleep, list, resume/wake and archive; a separately declared receipt command handles interrupted operations. Ordinary literal CLI commands remain supported. Older strict validators reject the new command rather than guessing an execution path.

The entry is a contained regular UTF-8 `.mjs` file, at most 1 MiB. Absolute paths, traversal and `.git`/`node_modules` entries are refused. Installation reads files without execution. Admission captures recipe and adapter digests; owner/source/permission changes or corrupted files withdraw authority. The host executes the captured reviewed source rather than reopening an executable path after approval.

## Runtime and authority

The control host uses Orca's existing pinned Node download/cache verifier, choosing its own supported platform/architecture/libc target. No Electron binary, PATH executable, desktop fallback, package installation or build hook substitutes for it. Runtime preparation receives cancellation and authority-withdrawal signals; the reviewed release is verified again before launch. A known preparation failure records a refusal without leaving a possibly applied mutation. An interruption after launch remains unverifiable.

A host-owned bootstrap receives the captured code and bounded request through stdin. This avoids source-sized command lines on Windows. It preserves literal arguments and exposes the logical entry as `process.argv[1]`, then presents the request on `process.stdin`. Node built-ins work; authors must bundle relative dependencies into one ESM file. Native addons and relative runtime imports are outside this contract. The executor removes inherited `NODE_OPTIONS`, `NODE_PATH` and `ELECTRON_RUN_AS_NODE`; deadlines, bounded output, process retirement, current authority and journal fences reuse the existing command transport.

Approval permits full account-level code execution, filesystem access, host credentials and network access. Node's heap limit is an operational bound, not a sandbox or complete process memory limit. The review displays the adapter entry, runtime, arguments and this account authority. A company must review the adapter and backend contract as executable code.

## Company repository

Use `orca-plugin init environment ../orca-environments-company --publisher company --id environments`. The generated repository includes all six commands, separately correlated receipt queries, source, prebuilt output, tests, a vendored validator and static validation CI. A name such as `orca-environments-devpods` is a maintenance convention; reviewed publisher/source identity grants authority.

The example forwards the exact account/operation request to an HTTPS company service using `ORCA_ENVIRONMENT_PROVIDER_URL` and `ORCA_ENVIRONMENT_PROVIDER_TOKEN` configured on the control host. It refuses embedded URL credentials, query/fragment and redirects, bounds UTF-8 responses and validates correlation using Orca's actual protocol implementation. It makes no automatic retry. Missing credentials return an authentication-required response without network access. Replace this client with the company's API adapter; commit the prebuilt bundle and release an exact version tag.

The backend must explicitly select and verify the requested account before any operation, enforce operation-ID idempotence and revision conflicts, and return authoritative receipts without replaying mutations. List absence, connection loss or an unknown receipt never proves deletion, exit or successful sleep. Long-lived machines and ephemeral sandboxes retain separate stable identities and lifetimes. SSH destination and changed-endpoint approval still apply independently.

## Qualification

The current macOS checks cover actual installed adapter subprocesses for all six actions, literal argv, source tampering, runtime-preparation refusal/cancellation, authority withdrawal, account migration and receipt recovery across restart. The author tarball initializes and packages all four families under Windows-style Git line-ending settings without dependency installs. A real pinned-runtime/cache check runs Node 24.21.0 on macOS arm64. These checks do not qualify a corporate service, Windows/Linux execution, active SSH endpoint migration or paired control-host lifecycle RPC; those remain release gates.
