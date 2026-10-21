import { z } from 'zod'
import { WorktreeSelector } from '../../../../shared/rpc-contract/worktree-params'
import { defineMethod } from '../core'

// Why optional: an older host strips the unknown field and marks its chats asleep as before.
const WorktreeSleepParams = WorktreeSelector.extend({ markChatsAsleep: z.boolean().optional() })

export const WORKTREE_SLEEP_METHOD = defineMethod({
  name: 'worktree.sleep',
  permission: 'workspace',
  params: WorktreeSleepParams,
  // Each workspace's sleep queues itself, so this call must not queue again. A phone never reads
  // the reply, and the sleep can outlast its request timeout, so it is answered on acceptance.
  handler: async (params, { runtime, clientKind }) =>
    runtime.sleepManagedWorktree(params.worktree, {
      replyOnAcceptance: clientKind === 'mobile',
      markChatsAsleep: params.markChatsAsleep !== false
    })
})
