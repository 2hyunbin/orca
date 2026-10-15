import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { readWorkspaceOriginDetails, type WorkspaceOriginDetails } from './workspace-details-model'

// A skip when refused: a host that will not answer leaves the heading at what the row's flags say.

const originSchema: z.ZodType<WorkspaceOriginDetails | null, unknown> = z
  .object({ worktree: z.unknown() })
  .transform((value) => readWorkspaceOriginDetails(value.worktree))
  .catch(null)

/** The name of the automation that created the workspace. */
export const workspaceOriginRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.origin-or-skip',
    method: 'worktree.show',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-origin', originSchema)
  })
)
