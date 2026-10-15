import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { LayoutApplyReply } from '../../../../shared/workspace-layout/workspace-layout-command-types'

/**
 * A split in a layout-owner build: main writes it and mints the new pane's id, then `mount` shows
 * that pane. False when a paired server owns the workspace's layout; the caller splits as today.
 */
export function splitThroughLayoutOwner(
  split: {
    worktreeId: string
    tabId: string
    leafId: string
    direction: 'vertical' | 'horizontal'
  },
  mount: (leafId: string) => void
): boolean {
  const hostId = getExecutionHostIdForWorktree(useAppStore.getState(), split.worktreeId)
  if (parseExecutionHostId(hostId)?.kind === 'runtime') {
    return false
  }
  const { worktreeId: workspace, ...pane } = split
  void callRuntimeRpc<LayoutApplyReply>({ kind: 'local' }, 'layout.apply', {
    command: { type: 'splitPane', workspace, ...pane }
  })
    .then((reply) => {
      if (reply.ok && reply.result.leafId) {
        mount(reply.result.leafId)
      } else {
        console.warn('[layout-owner] split refused:', reply.ok ? 'no_leaf' : reply.code)
      }
    })
    .catch((error: unknown) => {
      console.warn('[layout-owner] split failed:', error instanceof Error ? error.message : error)
    })
  return true
}
