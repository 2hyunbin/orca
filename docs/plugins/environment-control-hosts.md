# Environment providers on paired control hosts

Provider CLI processes, credentials, source approval, backend accounts and durable operation history belong to the host that executes them. The desktop IPC and paired runtime RPC now share one provider controller and one eight-operation budget per plugin service. A renderer or socket cannot cancel another transport's operation. Review tickets remain tied to the original window generation or authenticated socket.

## Negotiation and instance binding

The server advertises `plugins.environments.v1` only while a provider service is installed in its composition root. The Node-only runtime initializes that service from its own profile settings and cached safety list before RPC startup. Its ordinary consent and enablement RPCs use the same reviewed-source write path as the desktop. Plugin engine compatibility uses the compiled Orca app version, separately from the deployed orcad artifact version; a supervisor cannot override the compiled value.

New `plugins.environments.*` methods require an authenticated runtime client, live socket signal, server-owned connection identity and negotiated client support. Every method is host-admin; mobile callers are denied by the existing dispatcher. Strict payloads wrap the existing domain request in `{ runtimeId, input }`; list methods only need `{ runtimeId }`. The expected instance must equal the execution host's current runtime ID before any provider state is read or changed. Restarted or replaced servers cannot consume an old configuration intent even when plugin bytes, account strings and machine IDs match.

Methods cover active/saved provider lists, account configuration, current/previous/saved journal reads, six lifecycle actions, cancellation, authoritative receipt inspection, migration preparation/commit and existing SSH review/save/discard. Existing desktop requests retain their schemas and synchronous admission behavior. No new stream opcode is introduced. Older clients do not invoke these new methods; callers without the capability are refused. A missing, old or disconnected selected host must never fall back to desktop execution.

## Disconnect and shutdown

Socket closure aborts only that socket's active operations and retires its unconsumed migration/SSH tickets. The execution host owns process retirement and the durable outcome. A creation applied before its response was lost remains pending or unverifiable until a matching provider receipt confirms it; contact loss never proves backend exit, deletion or rollback. Another authenticated connection may inspect the saved operation and request a separately correlated receipt. Reusing its original UUID returns the recorded operation without repeating the mutation.

Node shutdown withdraws RPC service availability, removes settings/safety listeners, revokes provider authority and awaits service disposal before profile persistence is released. Safety-list shutdown aborts network fetching, rejects queued/late refreshes and waits for its writer; a late result cannot publish new authority after shutdown. Contributor credentials are read only from the chosen host's launch environment.

## Client review connection

`PluginEnvironmentProviderRuntimeClient` keeps one authenticated connection open for the review. Its preflight checks the exact server instance, protocol compatibility and provider capability before any domain call. Each request reuses the strict instance-bound input schema; each response must name the same instance. Concurrent reads share admission. Closing the client, transport loss or a failed admitted call retires the client, drops late answers and requires a fresh review; no mutation or ticket is automatically replayed on another socket.

The client exposes only the fourteen provider methods. Ordinary reads have a fifteen-second response deadline; execution and receipt inspection allow the declared command maximum plus retirement margin. Migration allows the existing sixteen-page bound. Caller cancellation uses the owned operation ID; closing the entire review closes its socket and lets the execution host retire that owner's pending work. This client is a transport foundation for the renderer bridge, not a claim that the selected-host settings surface is connected yet.

## Current qualification and remaining client work

Actual installed-adapter handler checks cover all six lifecycle actions, distinct sockets of one device, source/account admission and receipt recovery. Real encrypted pairing/RPC checks use the Node composition with its own profile store and the default verified Node 24.21.0 runtime: source consent and account configuration execute no code, six explicit operations preserve a long-lived machine beside an ephemeral sandbox, old instance/client and mobile requests refuse, and a disconnected applied creation is recovered without another mutation. The desktop provider IPC, ordinary RPC result handling and existing viewer transport regressions retain coverage.

This backend contract does not yet expose selected-host provider management in the rendered settings UI. That client must pin host/instance identity throughout its review, subscribe to the chosen host, surface unavailable/old-host states and use that host for every operation and SSH credential decision. Node-only SSH target/connection administration remains constrained by the runtime's existing SSH registration support; method registration alone is not proof of that support. Full Node startup/deployment, Linux/Windows/WSL, remote endpoint migration and the original release gates still need qualification. Existing captures retain their earlier desktop scope.

## Trusted desktop review sessions

The native renderer opens an opaque, window-owned provider session with the saved environment ID, pairing revision and expected server instance. The bridge reuses the managed remote connection lease shared with file viewers. Preparation is fenced before and after awaits; window destruction, navigation, host transport retirement or explicit closure releases the client. Startup cancellation cannot publish a late session or retire a replacement that reused its ID. The bridge accepts only strict provider methods and applies per-window/global review limits.

Provider changes reuse the existing runtime client-event stream and canonical plugin service. Only negotiated runtime clients receive the new event; older and mobile peers retain their existing stream. The session waits for readiness after any retained terminal-state frames, validates plugin events, checks the response instance, and forwards them only to the owning renderer/session. No polling, mutation replay or desktop fallback is introduced.

The rendered provider section now follows the Settings host picker. Its account, lifecycle, recovery, migration and history dialogs use that session and display the chosen host. Host changes remove the old review tree and fence late replies. Remote source installation/catalog and SSH connection administration remain subsequent work; the remote section cannot enter the desktop SSH save/connect path.
