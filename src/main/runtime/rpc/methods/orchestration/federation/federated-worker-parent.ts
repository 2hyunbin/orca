import type { ParentWorktreeRef } from '../../../../../../shared/worktree/lineage-types'
import { WORKTREE_CROSS_MACHINE_PARENT_RUNTIME_CAPABILITY } from '../../../../../../shared/runtime-capability-constants'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import { resolveDispatchCallerWorktreeId } from '../../orchestration-caller-workspace'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from '../worker/worker-start-schema'

export async function resolveFederatedWorkerParent(args: {
  runtime: OrcaRuntimeService
  params: WorkerStartInput
  status: RuntimeStatus
  serverName: string
  callerSession?: OrchestrationSessionCaller
}): Promise<ParentWorktreeRef | undefined> {
  if (args.params.worktree !== 'new-child') {
    return undefined
  }
  if (!args.status.capabilities?.includes(WORKTREE_CROSS_MACHINE_PARENT_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Orca on ${args.serverName} is too old to nest under a worktree on another machine. Update it, or pass --no-parent.`
    )
  }
  const parentId = await resolveDispatchCallerWorktreeId(
    args.runtime,
    args.params.from,
    args.callerSession
  )
  const parent = await args.runtime.showManagedWorktree(`id:${parentId}`)
  if (!parent.instanceId) {
    throw new OrchestrationError(
      'invalid_argument',
      'Coordinator worktree instance identity is unavailable.'
    )
  }
  return {
    worktreeId: parent.id,
    instanceId: parent.instanceId,
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' }
  }
}
