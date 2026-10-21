import { chooseWorkspaceTab } from '@/lib/workspace-tab-commands'
import { useAppStore } from '@/store'
import {
  launchAgentInNewTabInternal,
  type LaunchAgentInNewTabArgs,
  type LaunchAgentInNewTabResult
} from './launch-agent-in-new-tab'

export function launchAgentInNewTab(args: LaunchAgentInNewTabArgs): LaunchAgentInNewTabResult {
  const raw = useAppStore.getState().desktopLayoutView
  const workspace = useAppStore.getState().activeWorktreeId
  const result = launchAgentInNewTabInternal(args)
  if (result && args.activate !== false && !args.pendingActivationSpawn) {
    if (result.surface.kind !== 'host-published') {
      chooseWorkspaceTab(args.worktreeId, result.surface.tabId)
    } else {
      void result.structuredSettlement?.then((settled) => {
        const state = useAppStore.getState()
        const tab =
          settled.kind === 'structured' &&
          state.unifiedTabsByWorktree[args.worktreeId]?.find(
            (tab) => tab.contentType === 'agent-session' && tab.entityId === settled.sessionId
          )
        if (tab && state.desktopLayoutView === raw && state.activeWorktreeId === workspace) {
          chooseWorkspaceTab(args.worktreeId, tab.id)
        }
      })
    }
  }
  return result
}

export function shouldQueueTerminalFocusAfterMenuClose(
  result: NonNullable<LaunchAgentInNewTabResult>
): boolean {
  return result.surface.kind === 'host-published'
}

/** `host-published`: the surface opens once its host answers; `local-chat` opened before it did. */
export type AgentLaunchSurface =
  | { kind: 'local-terminal'; tabId: string }
  | { kind: 'local-chat'; tabId: string }
  | { kind: 'host-published' }
