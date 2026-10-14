# Node control-host SSH composition

The Node control host now installs the same SSH connection manager, target store, mutation rules, managed-server decision and public state publication used by the desktop. Provider accounts, credentials, SSH configuration, agent, source approvals, saved target generations and machine history remain on that host. A paired desktop does not dial its provider endpoint locally.

Startup creates a writable SQLite profile, then the SSH registry and managed-server actions, then provider admission, before exposing RPC. SSH target management and provider SSH capabilities reflect actual composition. A second owner or a stopping host cannot install another registry.

Connecting runs the existing deployment/conversion/tunnel policy. A raw SSH transport becoming connected stays private while the managed-server decision is pending. The app publishes readiness only after that decision. Headless authentication uses the host's existing SSH configuration and agent; this phase does not forward interactive credential prompts through paired RPC.

Managed-server status, update, rollback, recovery, stop, cancel-stop and forget use the same lifecycle implementation. Stop still requires authoritative remote exit evidence; loss of contact remains unverifiable. Forget retains its explicit unlink policy. Protected managed SSH targets cannot be removed through ordinary SSH settings. The Node host has no active renderer-selected environment.

Shared transport teardown and target mutation policy have no Electron import. Desktop adapters retain credential dialogs and local browser partition cleanup. Removed-server metadata retirement is shared; desktop browser storage retirement remains in its adapter. These boundaries allow plain Node to reuse the policy without installing desktop IPC handlers.

Shutdown first stops RPC, then retires provider admission and drains provider activity. Managed-server admission is withdrawn and accepted maintenance is drained before SSH teardown and profile finalization. The existing quit gate fences further connections. Incomplete SSH draining fails shutdown and keeps profile admission fenced until process exit. Closing contact preserves the machine, workspace and server ownership records.

Current checks cover plain-Node bundle loading without Electron, encrypted paired provider review/save on a writable SQLite profile, durable saved-target data after shutdown, wrong-generation refusal, approval withdrawal, shared target protection, suppressed premature readiness with controlled transport/decision collaborators, and accepted-maintenance draining. Existing desktop lifecycle checks cover the extracted policies.

A fresh packaged Darwin Node host starts with its pinned Node 24.21.0, a live writable SQLite authority and a passing terminal-daemon PTY self-test. Real encrypted RPC advertises composed SSH/managed-server support, adds/lists/removes a target without dialing it, then stops with exit 0. Its isolated home and owned daemon are cleaned up.

The standalone entry reports the installed slot’s bounded, validated `.version` marker, even when its supervisor carries an older `ORCA_VERSION`. Unpackaged entries retain the explicit environment version or `0.0.0-orcad` fallback. SSH compatibility and plugin engine checks use the compiled Orca app version separately from that artifact identity. The entry resolves its real slot before resource lookup, including symlinked launchers.

A control-host package can carry the existing verified deployment matrix without recursively enlarging ordinary deployed server slots:

```sh
node config/scripts/build-orcad-template.mjs
node config/scripts/build-orcad-node.mjs --target darwin-arm64 --out-dir out/control-host/orcad --deployment-template out/orcad-template
```

Use the actual control host target for `--target`. Release builds require every normal template target by default; they need the existing merged native prebuild matrix. `--deployment-targets linux-arm64-glibc` explicitly narrows a CI-only package and refuses a missing `--deployment-template`. Ordinary one-target builds remain available without a matrix. The builder refuses incomplete, corrupt, overlapping and different-build templates. It copies declared files into `resources/orcad-template`, rechecks staged bytes, and publishes atomically. Common server files must match the host build. The installed artifact marker still identifies executable server bytes; template contents carry their existing independent digest manifest. The existing operator template override remains available.

The exact partial local package passes real Darwin-arm64-to-Linux-arm64 deployment onto an empty owned SSH container. The Node control host establishes a managed connection and reads the remote terminal census over encrypted RPC. Remote health identifies the expected installed artifact, pinned Node 24.21.0, writable SQLite authority and a live daemon with a healthy PTY spawn self-test. The control host exits cleanly; its owned daemon and container are cleaned up. This is one live platform path, not all-platform or corporate-fleet qualification. Active endpoint migration, legacy relay compatibility and the original crash/client/platform/packaged release gates remain required. Controlled collaborators remain separately identified.
