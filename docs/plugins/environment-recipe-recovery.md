# Environment operation receipts

A stopped or interrupted lifecycle command may already have changed the provider's backend. A list response cannot prove what happened to a particular operation. Recovery asks the provider for its durable operation receipt and never sends the original mutation again.

## Opt-in command

Context-aware lifecycle recipes (`protocolVersion: 2`) may declare:

```json
"recovery": {
  "protocolVersion": 1,
  "command": {
    "program": "company-dev",
    "args": ["orca", "inspect-operation"],
    "timeoutSeconds": 120
  }
}
```

This version belongs to the separate receipt-query protocol, not legacy lifecycle protocol 1. A recipe without context support cannot declare it. The literal command appears in source review alongside lifecycle commands; changing it changes the reviewed recipe digest and requires current approval. Older providers remain usable and cannot be assumed to support lookup.

## Request

The execution host builds the request from its own journal. Clients supply the original operation ID and a new query UUID, never the old parameters, digest, launch environment or receipt.

```json
{
  "protocolVersion": 1,
  "queryId": "11111111-1111-4111-8111-111111111111",
  "providerId": "company.platform/devpods",
  "contextId": "company/account/region",
  "operation": {
    "operationId": "22222222-2222-4222-8222-222222222222",
    "requestDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "action": "sleep",
    "resourceId": "devbox-17",
    "expectedRevision": "r1"
  }
}
```

Create has only `operationId`, `requestDigest` and `action`; it has no resource ID yet. Other machine transitions require their original resource ID and expected revision. List is not a recoverable mutation.

The request digest is SHA-256 of the exact UTF-8 lifecycle JSON sent to the provider, including its final newline. Providers should hash the received bytes before parsing, or use a UTF-8 stream decoder when accumulating text. Persist that digest and operation outcome in the selected backend namespace before acknowledging success. Select or verify the requested account/tenant/region before lookup, exactly as before mutation. A receipt from another account with the same resource ID is invalid.

## Response

Echo the complete query identity and original operation. A terminal receipt contains:

```json
{
  "kind": "receipt",
  "outcome": {
    "kind": "completed",
    "resource": {
      "id": "devbox-17",
      "name": "Development machine",
      "revision": "r2",
      "lifetime": "long-lived",
      "state": "sleeping"
    }
  },
  "currentResource": {
    "id": "devbox-17",
    "name": "Development machine",
    "revision": "r3",
    "lifetime": "long-lived",
    "state": "running"
  }
}
```

The snippet omits the echoed identity only for readability. `outcome.resource` confirms the original transition: create/wake running, sleep sleeping, archive archived, delete deleted. Optional `currentResource` is a separately verified current observation of that same machine. It may have changed since the original operation. Orca merges that current observation, never substitutes the historical outcome for newer inventory. Without current details, that machine remains blocked until an explicit list confirms it.

A terminal `outcome: {"kind":"refused","code":"conflict"}` is a provider guarantee that the original operation made no change. Other refusal codes are `not-found`, `authentication-required` and `unsupported`. Missing receipt data must return `kind: "unknown"`, not a fabricated refusal. A still-running operation returns `kind: "pending"`. Query errors have `kind: "error"` with `authentication-required`, `unsupported` or `unavailable`. None of these non-terminal responses clear the mutation fence.

Requests and responses retain the existing 32 KiB input, 512 KiB output and structural limits. Raw diagnostics and creation parameters are not saved in Orca's journal. Cancellation, source withdrawal, malformed replies or contradictory receipts leave the original operation unresolved. Receipt recording rechecks source/account authority under the journal transaction lock.

## History and contact

The journal keeps its original pending/unverifiable observation and records the verified receipt alongside it. A recovered intent is no longer a pending mutation reservation; replaying its original UUID still returns its recorded entry without executing. A late response cannot overwrite inventory observed by the receipt query. Source/account/host bindings continue to own the journal.

An interrupted list is different: an explicit new inventory read may supersede the old read as unverifiable. This does not claim the old process exited, expire a machine mutation, or infer deletion. A late old list result is refused. The active host service refuses overlapping work while it still owns the live operation.

Desktop UI shows unresolved changes, a source/account/operation-bound check dialog and retained history. Receipt inspection uses the requesting window's cancellation owner; another window cannot stop it or submit a forged receipt. Recovery never reconnects automatically. Existing SSH registration, current inventory, host trust and fresh connection review remain responsible for contact.
