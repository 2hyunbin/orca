# SSH connections from provider reviews

The control host owns the provider account, saved SSH target, credentials, SSH configuration, agent and connection. A paired desktop review must never save that target or dial its endpoint through desktop SSH APIs.

The new `plugins.environments.connectSsh` method requires a live host-admin runtime socket, the captured runtime instance and negotiated `plugins.environments.ssh.v1` support. The host publishes support only when its provider service, SSH registry, connection manager, mutation handlers and provider admission hook are composed. This does not claim that every endpoint is reachable or that Node host composition is finished.

A connection can use only a target saved by the same review. The saved target's durable generation, provider binding and connection fingerprint are checked before and after provider admission and after dialing. The fingerprint includes identity-file, agent, proxy and other authentication routing fields because an identity-file edit can preserve the target generation. Another socket, changed registration, withdrawn approval, retired review or foreign result is refused. Connector errors use the existing public SSH error boundary.

Saved registrations remain host-owned when a review closes. Accepted connection work can finish on its original host, but a retired reviewer receives no late success and cannot reconnect or replay it. Provider shutdown closes admission and drains accepted connections before profile release. Revocation retires contact while preserving machine and workspace history.

The renderer exposes remote SSH actions only when the captured native review advertises support. It uses that same session to prepare, save and connect, labels the credential host, and mirrors status into the selected environment's SSH bucket. Metadata resynchronization uses the existing read-only SSH hydration path. Desktop SSH maps and APIs stay separate.

Current checks use real provider CLI inventory and encrypted paired transport with a controlled connector, plus renderer routing and cancellation checks. Successful remote SSH deployment and connection still require native integration qualification. The owned container's Docker daemon probe timed out; no daemon or user process was changed. Node composition, full deployment, active endpoint migration and original release gates remain open.
