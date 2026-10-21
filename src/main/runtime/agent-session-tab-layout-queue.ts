// A layout-owner build's chat tab changes from this host (a chat it publishes, retires or
// restores): main's own layout commands, with or without a window.

import type { ExecutionHostId } from '../../shared/execution-host'
import type { LayoutApplyReply } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  chatTabLayoutCommand,
  loadChatTabLayout,
  type ChatTabChange,
  type ChatTabLayoutCommand
} from './agent-session-tab-layout'

export type QueuedChatTabChange = { worktreeId: string; change: ChatTabChange }

/**
 * Runs each batch in order, every change read against the layout as it stands when the queue
 * reaches it, so a close follows the open it undoes. A refusal is logged, never thrown.
 */
export function createChatTabLayoutQueue(deps: {
  partitionOf: (worktreeId: string) => {
    hostId: ExecutionHostId
    session: WorkspaceSessionState | null
  }
  apply: (command: ChatTabLayoutCommand) => Promise<LayoutApplyReply>
}): (changesNow: () => readonly QueuedChatTabChange[]) => void {
  let queue: Promise<void> = Promise.resolve()
  const commandNow = ({ worktreeId, change }: QueuedChatTabChange) => {
    const { hostId, session } = deps.partitionOf(worktreeId)
    if (!session) {
      return chatTabLayoutCommand(undefined, undefined, worktreeId, change)
    }
    const { loaded, activeGroupId } = loadChatTabLayout(hostId, session, worktreeId)
    return chatTabLayoutCommand(
      loaded.layout.workspaces[worktreeId],
      activeGroupId,
      worktreeId,
      change
    )
  }
  return (changesNow) => {
    queue = queue.then(async () => {
      for (const queued of changesNow()) {
        const command = commandNow(queued)
        if (!command) {
          continue
        }
        try {
          const reply = await deps.apply(command)
          if (!reply.ok) {
            console.warn(`[agent-session-tabs] ${command.type} refused:`, reply.code)
          }
        } catch (error) {
          console.warn(`[agent-session-tabs] ${command.type} failed:`, error)
        }
      }
    })
  }
}
