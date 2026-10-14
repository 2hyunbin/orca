# Provider machines: workspace access through a control host

## The user journey

A company plugin provisions or discovers a devbox on the selected host. The user reviews the account, machine and SSH endpoint, then connects. Orca keeps progress visible until the managed server is ready. The next action must be **Open workspace**: choose a folder or repository on that machine, browse its files and open a terminal there. Long-lived and temporary machines use the same workspace flow. Credentials and provider commands stay on the selected control host.

## Current gap

The packaged Node control host now deploys, pairs, reconnects and maintains a server through SSH. Real migration and abrupt-restart checks prove the child server's encrypted terminal census. They do not prove desktop workspace usability through the controller.

The controller's `repo.addRemote` refuses SSH-backed projects, and the Add Project selector excludes raw SSH targets. This is intentional: a managed server owns its own workspaces. The desktop currently knows the controller's pairing, not its child server. Silently sending workspace requests to the controller would open the wrong machine.

## Connection design

Reuse the existing managed-server registration, saved target generations, runtime environments and encrypted WebSocket session machinery. The desktop should add the child as a distinct managed runtime, routed through the already-paired controller. Its project, file, terminal and agent state remains owned by the child. Do not copy SSH keys or the controller's private child pairing token to the desktop.

A public descriptor carries version, controller runtime identity, environment identity, child runtime identity, SSH target identity and target generation. It contains no credentials. Route `/_orca/managed/<encoded-environment-id>/<generation>` is reserved for this connection. The descriptor is not an authorization grant.

The desktop requires `managedServer.workspace-discovery.v1` before requesting a verified descriptor or constructing an endpoint. The earlier `managedServer.workspace-gateway.v1` foundation capability remains unadvertised. Transport rejects this namespace unless a gateway is composed; malformed and noncanonical variants always refuse before root RPC. Rejected connections retain the existing capacity limit and bounded close timeout. Other legacy transport paths retain their behavior.

Root-path direct WS/WSS endpoints are the initial route-construction contract. Custom paths and relay endpoints refuse construction. Their support needs a separately negotiated transport path; do not silently downgrade to the controller or claim those endpoints are qualified.

## Admission and lifetime

Before exposing or opening a child connection, resolve the controller-owned saved environment and target again. Require a completed managed deployment, matching target fence and generation, no pending reconciliation, a current provider source/account approval, and a confirmed child runtime identity. Check those bindings again after asynchronous connection setup. An endpoint change, removal, lost provider authority, pairing revision change, sleep or archive retires existing child contact. Loss of contact remains unverifiable; it never proves exit.

Authenticate the incoming socket with the controller's existing encrypted device-key/token handshake. Authorize every forwarded method against the current paired principal. Never promote a paired desktop to the child's owner or inherit child pairing administration. Caller identity and terminal client IDs must refer to this paired principal, not to a shared private owner credential. A dedicated child delegation contract must cover revocation and credential revisions before this gateway is enabled. Mobile delegation cannot be reused as a full desktop grant.

Each incoming connection owns its outgoing child session. Reuse the authenticated passthrough machinery and bounded queues; extend it for binary terminal frames rather than building a second terminal protocol. Closing or revoking either side closes its counterpart, cancels pending requests and retires stream ownership. Slow consumers, failed setup and controller shutdown must release sockets, timers, queues and child grants. Avoid per-request SSH subprocesses.

Persist an inert `kind: managed-gateway` reference in the existing environment store. Older builds retain unknown record kinds without opening them. The existing sidecar strips unknown fields, so it cannot safely hold this connection identity. Derive the controller credential in memory and always scrub it when writing the child record. Generation changes require refreshed descriptors; stale URLs refuse access.

## Qualification before enabling

Use the production hidden desktop, packaged Node controller and an owned real Linux SSH server. Through normal UI, install/review the provider, create or list a machine, connect, open a non-Git folder and a Git repository, browse a file, edit it and execute a terminal command whose hostname identifies the child. Verify both desktop and controller files remain unchanged.

Exercise binary terminal input/output, multiple sessions, cancellation during setup, controller crash/restart, sleep/wake, reviewed endpoint migration, credential revocation and a conflicting generation update. Old controller/child builds must refuse unsupported access with an actionable update message. Test relay/custom-path behavior separately, alongside Windows/WSL and the release matrix. A terminal census is retained evidence for deployment, not acceptance of this workspace journey.

Current foundation checks cover route identity, descriptor validation, negotiation, reserved-path refusal and root transport compatibility. Controller-to-child forwarding, persistence and rendered workspace selection remain implementation work.

## Implemented child-session boundary · 14 October 2026

`pairing.managedRuntimeSession.open/renew/revoke` now creates an in-memory runtime device bound to the authenticated controller. Its capability is separate from the still-unadvertised workspace gateway. A session inherits the controller's existing runtime permissions. Optional desktop-control is absent by default; an explicit request must be within the controller's grants, allowing the gateway to narrow it to the incoming desktop's authority. It receives its own bearer and device identity, plus a stable caller fingerprint scoped to the controller and desktop subject. It cannot mint further sessions or phones, register a permanent key, or acquire pairing administration.

The controller renews within a 30-second lease; it never receives an immortal delegated pairing. Parent removal, credential-revision/token changes and grant changes retire the session. Expiry and explicit revocation close authenticated sockets without waiting for incoming traffic. Shutdown drains these memory-only credentials; ordinary registry saves omit them. Per-controller and total session caps bound retained state.

Binary input revalidates the authenticated principal before entering runtime stream handlers. The existing encrypted passthrough now sends binary input through its existing bounded outbound queue, preserving one session for text and binary traffic. Real localhost encrypted-session checks cover input/output, revoked socket closure and refused binary delivery. The test stream is a controlled RPC fixture, not a native terminal or a complete controller gateway.

This makes child delegation and its transport usable by the gateway below. It does not make provider workspace access available in the desktop yet. The production normal-UI journey above remains required.

## Implemented encrypted forwarding · 14 October 2026

Both runtime compositions install a gateway backed by saved managed-server ownership. It resolves the current target fence and generation, requires a confirmed child runtime identity, admits the current provider approval and reuses the existing managed connection lease. Caller-supplied endpoints are ignored. Provider withdrawal and transport retirement close contact. Registration, credentials and reconciliation are checked again after connection preparation.

Each incoming encrypted socket owns one private child session. Method permissions come from the controller's existing RPC registry and current authenticated principal. Pairing administration, credential promotion, nested delegation and unknown methods refuse access. Child sessions start with no optional desktop-control grant. Grant changes invalidate the incoming link. Text and binary requests travel through the existing encrypted passthrough; controller workspace dispatch never handles them.

Terminal identity fields are remapped separately from commands and file contents. Multiplex subscribe frames preserve stream identity and sequence; input bytes stay intact. Temporary sessions use public device IDs as runtime client IDs so presence cannot expose a bearer. Pending setup has byte, frame and global-opening bounds. Cancellation discards queued work; shutdown drains private-session revocation before host teardown. A stale or unavailable connection returns an actionable reconnect/update error.

Qualification uses two real localhost encrypted RPC servers with controlled store and binary-stream fixtures. Separate resolver checks hold connection preparation while changing credentials, and verify ownership, generation, confirmed identity and provider withdrawal. This is backend integration proof, not a native terminal, real SSH gateway, or normal-UI workspace journey.

The gateway capability remains unadvertised. Custom-path/relay, mixed-peer, native interruption and full platform/release gates remain open.

## Discovery and desktop workspace selection

`managedServer.workspace-discovery.v1` is advertised only by a controller with a discovery implementation. `managedServer.workspace.describe` accepts a saved SSH target ID and reviewed generation, verifies the child through its existing private pairing, and learns its current process identity. Runtime IDs identify process incarnations; host keys remain the durable pairing identity. The descriptor exposes no child credential.

The desktop stores a controller-bound reference and derives an audience-bound credential for its canonical child route. Root-path or wrong-generation authentication refuses that credential. An older controller cannot accept the wrapped value as its ordinary paired bearer, even if its transport accepts unrelated paths. Removing or re-pairing the controller blocks dependent references. Child status retains the child runtime identity and reports the authenticated controller device to the desktop; temporary child session credentials remain private.

After reviewing and connecting a provider resource, **Open workspace** uses the existing Add Project dialog with the child selected. It supports Git projects and non-Git folders without changing the default settings host. While the requested host is absent or unavailable, project creation waits instead of falling back to Local. Rendered native qualification remains required before claiming this journey is complete.

## Native workspace qualification

The hidden production desktop, packaged Darwin Node controller and owned Linux SSH server now qualify both project types through normal UI. The folder journey creates a workspace, runs a terminal command, reads a file and verifies its saved edit in the child filesystem. The Git journey imports the child repository, creates a real worktree/branch, runs a terminal command and opens its actual README in the rich editor. Neither journey uses a renderer debug store.

The same run sleeps/wakes the provider machine, reviews its changed SSH endpoint, compares the authoritative terminal census before and after migration, cold-restarts the controller and verifies the census remains unchanged. After reconnecting and refreshing the reviewed child descriptor, the user reopens the existing named folder workspace and reads the earlier saved edit. The controller restart does not replay provider mutations. Native windows stay hidden.

This is real SSH, deployment, encrypted terminal/file traffic and workspace persistence. The fleet lifecycle CLI is an owned fixture, not a corporate provider. A child-server restart, competing clients, publication interruption, custom-path/relay, Windows/WSL, the full release matrix and remaining phase acceptance gates still require evidence.
