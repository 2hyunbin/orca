import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { runWorktreeBatchDelete, runWorktreeDelete } from './delete-worktree-flow'
import {
  toWorktreeDeleteIdentities,
  createWorktreeDeleteAdmission,
  getRegisteredWorktreeDeleteTarget,
  type WorktreeDeleteIdentity
} from './worktree-delete-request'
import type { Worktree } from '../../../../shared/worktree/types'

export type WorktreeContextMenuDeleteIntent =
  | { kind: 'worktree'; worktree: WorktreeDeleteIdentity }
  | { kind: 'batch'; worktrees: readonly WorktreeDeleteIdentity[] }
  | { kind: 'folder'; folderWorkspaceId: string; worktree: WorktreeDeleteIdentity }

export function createWorktreeContextMenuDeleteIntent(args: {
  worktree: Pick<Worktree, 'id' | 'instanceId' | 'hostId' | 'runtimeOwnerEnvironmentId'>
  batchDeleteWorktrees: readonly Pick<
    Worktree,
    'id' | 'instanceId' | 'hostId' | 'runtimeOwnerEnvironmentId'
  >[]
  isMultiContext: boolean
  folderWorkspaceId?: string
}): WorktreeContextMenuDeleteIntent {
  if (args.isMultiContext) {
    return {
      kind: 'batch',
      worktrees: toWorktreeDeleteIdentities(args.batchDeleteWorktrees)
    }
  }
  const [worktree] = toWorktreeDeleteIdentities([args.worktree])
  if (args.folderWorkspaceId) {
    return {
      kind: 'folder',
      folderWorkspaceId: args.folderWorkspaceId,
      worktree
    }
  }
  return { kind: 'worktree', worktree }
}

export function runWorktreeContextMenuDeleteIntent(intent: WorktreeContextMenuDeleteIntent): void {
  if (intent.kind === 'batch') {
    runWorktreeBatchDelete(intent.worktrees)
    return
  }
  if (intent.kind === 'worktree') {
    runWorktreeDelete(intent.worktree.id, {
      expectedIdentity: intent.worktree,
      expectedInstanceId: intent.worktree.instanceId,
      ...(intent.worktree.hostId ? { expectedHostId: intent.worktree.hostId } : {})
    })
    return
  }
  const state = useAppStore.getState()
  const target = getRegisteredWorktreeDeleteTarget(
    state,
    intent.worktree.id,
    intent.worktree.hostId,
    intent.worktree
  )
  if (!target) {
    return
  }
  try {
    createWorktreeDeleteAdmission(target)()
  } catch {
    return
  }
  void state
    .deleteFolderWorkspace(
      intent.folderWorkspaceId,
      target.hostId ? { executionHostId: target.hostId } : undefined
    )
    .then((deleted) => {
      const current = useAppStore.getState()
      if (
        deleted &&
        current.activeWorktreeId === folderWorkspaceKey(intent.folderWorkspaceId) &&
        (!target.hostId || current.activeWorkspaceExecutionHostId === target.hostId)
      ) {
        current.setActiveWorktree(null)
      }
    })
}

export function deferWorktreeContextMenuDeleteIntent(
  intent: WorktreeContextMenuDeleteIntent,
  onDispatched?: () => void,
  defer: (callback: () => void) => void = (callback) => window.setTimeout(callback, 0)
): void {
  defer(() => {
    runWorktreeContextMenuDeleteIntent(intent)
    onDispatched?.()
  })
}
