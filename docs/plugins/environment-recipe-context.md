# Provider account and tenant context

A development machine ID is meaningful only within its provider account, tenant and region. Two accounts can return the same resource ID and revision. Changing the corporate CLI's default account between list and delete can therefore target another machine even though Orca's cached revision matches.

The real CLI fixture in `plugin-environment-recipe-context.integration.test.ts` reproduces this ambiguity with protocol 1: listing `pod` in account A, switching the default to B, then deleting `pod` deletes B's machine. The context-aware fixture refuses that mutation before writing its deletion marker. This is local fixture evidence, not a claim about a particular corporate provider.

## Protocol 2

An artifact opts in with `protocolVersion: 2`. Its requests and responses use protocol 2 and require a bounded, non-secret `contextId`. The host selects and reviews that context explicitly; callers cannot silently take whatever account the CLI currently defaults to. A context identifies the backend namespace, including account, tenant and region where those distinguish resources. Use provider-native immutable IDs rather than display names or credentials.

The provider must resolve the requested context explicitly when accessing its backend. If its CLI can only use a mutable default, it must verify that default against the requested context and refuse a mismatch **before mutation**. Backend authorization and revision comparison must apply atomically to that same namespace. Echoing a request's context without actually selecting it does not provide this guarantee; Orca cannot enforce the internal behavior of trusted provider code.

Responses must echo the protocol version and context in addition to the operation, provider and action. Missing or changed context, a protocol downgrade, or a recipe/request protocol mismatch fails closed. Create, list and every mutation use this binding. Resource connection details still require the ordinary SSH destination and host-key review.

## Durable ownership

The journal stores its context together with execution host, provider, source and recipe digests. Its filename remains keyed by host and provider, so switching context encounters the existing inventory and pending operations instead of receiving an empty parallel journal. Old rows cannot be reused under another account. Request digests also include the context; an operation ID cannot be replayed across contexts.

Context/source/recipe migration and authoritative recovery are separate application work. Refusing a mismatch must preserve the old journal and machines. An interrupted provider operation is never retried automatically. Cached rows and absence from an inventory page are not proof of deletion.

## Compatibility and release scope

Existing protocol-1 artifacts and requests keep their strict original shape and behavior. Protocol 1 rejects a context field, and protocol 2 requires one. The application host adapter requires context-aware protocol 2; it must never silently downgrade a new provider action to protocol 1. A paired client must negotiate the new lifecycle methods before using them; an unavailable execution host must not fall back to the desktop.

This foundation adds opt-in protocol validation and durable context binding. It does not expose a new RPC method, configure account contexts, or complete the Environments screen. Provider registration, current approval, context selection, connection handoff, recovery, lifecycle UI and platform qualification remain separate stack layers.
