# Executing an operation receipt query

The provider can declare a separate receipt lookup command for context-aware recipes. The execution host sends a new query ID plus its saved original operation ID, request digest, action, machine revision and backend account. It sends no creation parameters and never substitutes the original lifecycle command when lookup is unsupported.

The recovery executor reuses the lifecycle command transport: literal argv, trusted execution-host environment and working directory, bounded newline JSON, checked approval before and after execution, cancellation, deadline, bounded output and child-process retirement. The command and request are snapshotted before awaiting authority. A malformed, stale or unavailable result remains unverifiable. A valid unknown result remains unknown; it is not a terminal receipt.

The journaled lifecycle pipeline can receive a host-owned journal generation, preserving legacy selection when absent. Clients do not supply this value. Storage and actual command execution are separate foundations; the later host adapter derives recovery requests from the journal and checks current source/account ownership.

This draft adds no automatic lookup, receipt acceptance from renderer input, IPC, remote RPC or account selection. It preserves existing lifecycle request and result shapes while sharing their existing process implementation with receipt lookup.
