import { WorktreeSelector } from '../../../../shared/rpc-contract/worktree-params'
import { defineMethod } from '../core'

export const WORKTREE_SLEEP_METHOD = defineMethod({
  name: 'worktree.sleep',
  permission: 'workspace',
  params: WorktreeSelector,
  // Each workspace's sleep queues itself, so this call must not queue again.
  handler: async (params, { runtime }) => runtime.sleepManagedWorktree(params.worktree)
})
