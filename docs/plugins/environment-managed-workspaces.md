# Provider machines: workspace access through a control host

## The user journey

A company plugin provisions or discovers a devbox on the selected host. The user reviews the account, machine and SSH endpoint, then connects. Orca keeps progress visible until the managed server is ready. The next action must be **Open workspace**: choose a folder or repository on that machine, browse its files and open a terminal there. Long-lived and temporary machines use the same workspace flow. Credentials and provider commands stay on the selected control host.

## Current gap

The packaged Node control host now deploys, pairs, reconnects and maintains a server through SSH. Real migration and abrupt-restart checks prove the child server's encrypted terminal census. They do not prove desktop workspace usability through the controller.

The controller's `repo.addRemote` refuses SSH-backed projects, and the Add Project selector excludes raw SSH targets. This is intentional: a managed server owns its own workspaces. The desktop currently knows the controller's pairing, not its child server. Silently sending workspace requests to the controller would open the wrong machine.

## Connection design

Reuse the existing managed-server registration, saved target generations, runtime environments and encrypted WebSocket session machinery. The desktop should add the child as a distinct managed runtime, routed through the already-paired controller. Its project, file, terminal and agent state remains owned by the child. Do not copy SSH keys or the controller's private child pairing token to the desktop.

A public descriptor carries version, controller runtime identity, environment identity, child runtime identity, SSH target identity and target generation. It contains no credentials. Route `/_orca/managed/<encoded-environment-id>/<generation>` is reserved for this connection. The descriptor is not an authorization grant.

The capability `managedServer.workspace-gateway.v1` must be negotiated before constructing a gateway endpoint. It is deliberately not advertised yet. Current transport rejects this namespace, including malformed and noncanonical variants, before handing messages to root RPC. Rejected connections retain the existing capacity limit and bounded close timeout. Other legacy transport paths retain their behavior.

Root-path direct WS/WSS endpoints are the initial route-construction contract. Custom paths and relay endpoints refuse construction. Their support needs a separately negotiated transport path; do not silently downgrade to the controller or claim those endpoints are qualified.

## Admission and lifetime

Before exposing or opening a child connection, resolve the controller-owned saved environment and target again. Require a completed managed deployment, matching target fence and generation, no pending reconciliation, a current provider source/account approval, and a confirmed child runtime identity. Check those bindings again after asynchronous connection setup. An endpoint change, removal, lost provider authority, pairing revision change, sleep or archive retires existing child contact. Loss of contact remains unverifiable; it never proves exit.

Authenticate the incoming socket with the controller's existing encrypted device-key/token handshake. Authorize every forwarded method against the current paired principal. Never promote a paired desktop to the child's owner or inherit child pairing administration. Caller identity and terminal client IDs must refer to this paired principal, not to a shared private owner credential. A dedicated child delegation contract must cover revocation and credential revisions before this gateway is enabled. Mobile delegation cannot be reused as a full desktop grant.

Each incoming connection owns its outgoing child session. Reuse the authenticated passthrough machinery and bounded queues; extend it for binary terminal frames rather than building a second terminal protocol. Closing or revoking either side closes its counterpart, cancels pending requests and retires stream ownership. Slow consumers, failed setup and controller shutdown must release sockets, timers, queues and child grants. Avoid per-request SSH subprocesses.

Persist only an additive gateway link in the existing runtime sidecar. Older peers may ignore the link but must never interpret the child's URL as the controller root. Do not store the controller's pairing credential in the child's independent pairing record. Generation changes require refreshed descriptors; stale URLs refuse access.

## Qualification before enabling

Use the production hidden desktop, packaged Node controller and an owned real Linux SSH server. Through normal UI, install/review the provider, create or list a machine, connect, open a non-Git folder and a Git repository, browse a file, edit it and execute a terminal command whose hostname identifies the child. Verify both desktop and controller files remain unchanged.

Exercise binary terminal input/output, multiple sessions, cancellation during setup, controller crash/restart, sleep/wake, reviewed endpoint migration, credential revocation and a conflicting generation update. Old controller/child builds must refuse unsupported access with an actionable update message. Test relay/custom-path behavior separately, alongside Windows/WSL and the release matrix. A terminal census is retained evidence for deployment, not acceptance of this workspace journey.

Current foundation checks cover route identity, descriptor validation, negotiation, reserved-path refusal and root transport compatibility. Gateway forwarding, delegation, persistence and rendered workspace selection remain implementation work.
