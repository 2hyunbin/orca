import { requiresParentWorktreeReference } from '../../../../../../shared/resolved-worktree-lineage'
import { WORKTREE_CROSS_MACHINE_PARENT_RUNTIME_CAPABILITY } from '../../../../../../shared/runtime-capability-constants'
import type { ParentWorktreeRef } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { getRuntimeTargetHostId } from '../../../../runtime/runtime-client-target'
import { assertRuntimeEnvironmentCapability } from '../../../../runtime/runtime-rpc-client'

export async function resolveLineageParentReference(
  target: RuntimeClientTarget,
  selector: string | undefined,
  worktrees: readonly Worktree[]
): Promise<ParentWorktreeRef | undefined> {
  const parent = selector?.startsWith('identity:')
    ? worktrees.find((row) => `identity:${row.identity?.key}` === selector)
    : undefined
  if (
    !parent?.instanceId ||
    !requiresParentWorktreeReference(getRuntimeTargetHostId(target), parent.hostId ?? 'local')
  ) {
    return undefined
  }
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      WORKTREE_CROSS_MACHINE_PARENT_RUNTIME_CAPABILITY,
      `Orca on ${target.environmentId} is too old to nest under a worktree on another machine. Update it, or pass --no-parent.`
    )
  }
  return {
    worktreeId: parent.id,
    instanceId: parent.instanceId,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' }
  }
}
