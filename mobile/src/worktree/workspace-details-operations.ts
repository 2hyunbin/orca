import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { readWorkspaceOriginDetails, type WorkspaceOriginDetails } from './workspace-details-model'

// The long-press details' two reads beyond the row. Both are skips when refused: a host that
// predates them, or will not answer, just leaves its section at what the row already says.

const originSchema: z.ZodType<WorkspaceOriginDetails | null, unknown> = z
  .object({ worktree: z.unknown() })
  .transform((value) => readWorkspaceOriginDetails(value.worktree))
  .catch(null)

/** Who made the workspace: the automation and run, or whether an agent ran `orca worktree create`. */
export const workspaceOriginRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.origin-or-skip',
    method: 'worktree.show',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-origin', originSchema)
  })
)

/** The workspace's host scanned for listeners; the reader filters to this workspace's own. */
export const workspacePortsScanRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'workspacePorts.scan-host-or-skip',
    method: 'workspacePorts.scanHost',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-ports-scan', z.unknown())
  })
)
