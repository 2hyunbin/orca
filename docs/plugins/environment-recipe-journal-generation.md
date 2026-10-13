# Environment recipe journal generations

The execution host keeps machine inventory and operation history. A dropped response is not proof that a machine change stopped. A correlated provider receipt can settle the original intent while the journal keeps its original observation. Receipt lookup never resubmits the mutation.

A completed historical receipt and current machine inventory are distinct. Until a fresh provider observation confirms the affected machine, mutations and SSH admission for that machine stay fenced. A fresh inventory query can supersede an interrupted inventory query; it cannot settle an interrupted mutation.

## Safe selection and history

Legacy journals keep their existing host/provider filename. An optional host-owned UUID selects a new journal file under `plugin-environment-recipes/generations/`. A missing selected generation is corruption and fails closed; it cannot create an empty inventory.

Migration writes a complete new journal durably before atomically selecting it in the host's provider account record. Previous journals remain unchanged and can be read as historical records. An interrupted selection leaves either the old valid selection or the new valid selection; an unselected file grants no authority.

A same-account source update preserves unresolved machine operations and their original source binding. An account switch keeps old operations in the old account rather than copying identical machine IDs into a different namespace. Previous bindings may refer only to the same provider and execution host. Operation origins must also match the current account.

The generation ID is not a renderer parameter. The application creates it during explicit source/account review after fresh inventory inspection. Prior history, copied receipts, and saved SSH registrations alone cannot grant execution or redirect an endpoint.

## Draft boundary

The storage foundation adds generation-aware journal files and receipt reconciliation. It does not execute provider commands, select a new account, expose IPC or remote RPC, or approve an update. Those actions require the separate application layer and its current source/account/window authority checks. Existing journals and context-aware lifecycle requests remain compatible.
