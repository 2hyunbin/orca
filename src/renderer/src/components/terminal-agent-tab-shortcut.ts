import type { KeybindingActionId, KeybindingOverrides } from '../../../shared/keybindings'
import type { TuiAgent } from '../../../shared/tui-agent'
import { useAppStore } from '../store'
import { readDetectedAgentsForWorktree } from '@/lib/agent-detection-target-inventory'
import {
  listBoundAgentTabActions,
  newTabWorkspace,
  resolveDefaultAgentForNewTab,
  resolveDefaultAgentForWorktreeNewTab
} from '@/lib/agent-tab-shortcuts'
import { chosenAgentChatUnlearned } from '@/lib/host-chat-program'

export type TerminalAgentTabShortcut = {
  actionId: KeybindingActionId | null
  agent: TuiAgent | null
  /** Set when the cached list has no usable agent; settles once the workspace's host answers. */
  pendingAgent?: Promise<TuiAgent | null>
}

export function resolveTerminalAgentTabShortcut({
  activeWorktreeId,
  keybindings,
  matchShortcut
}: {
  activeWorktreeId: string
  keybindings: KeybindingOverrides
  matchShortcut: (actionId: KeybindingActionId) => boolean
}): TerminalAgentTabShortcut {
  const state = useAppStore.getState()
  if (matchShortcut('tab.newAgent')) {
    const detectedAgentIds = readDetectedAgentsForWorktree(state, activeWorktreeId)
    const chosen = state.settings?.defaultTuiAgent
    const agent = resolveDefaultAgentForNewTab({
      defaultTuiAgent: chosen,
      detectedAgentIds,
      disabledTuiAgents: state.settings?.disabledTuiAgents,
      chatIn: { store: state, worktreeId: activeWorktreeId }
    })
    const workspace = newTabWorkspace(activeWorktreeId)
    // Why: the cached list is empty until the host's probe lands (e.g. a paired server's
    // workspace right after it opens), and a default that opens as a chat without its CLI may not
    // be known yet; ask that host instead of reporting no agent or passing the default over.
    return agent && !chosenAgentChatUnlearned(state, chosen, detectedAgentIds, workspace)
      ? { actionId: 'tab.newAgent', agent }
      : {
          actionId: 'tab.newAgent',
          agent: null,
          pendingAgent: resolveDefaultAgentForWorktreeNewTab(useAppStore.getState, activeWorktreeId)
        }
  }
  for (const bound of listBoundAgentTabActions(keybindings, state.settings?.disabledTuiAgents)) {
    if (matchShortcut(bound.actionId)) {
      return { actionId: bound.actionId, agent: bound.agent }
    }
  }
  return { actionId: null, agent: null }
}
