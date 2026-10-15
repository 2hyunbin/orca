import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { readWorkspaceOriginDetails, type WorkspaceOriginDetails } from './workspace-details-model'

// The long-press details' read of who made the workspace. A skip when refused: a host that will
// not answer leaves the section at what the row's flags already say.

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
