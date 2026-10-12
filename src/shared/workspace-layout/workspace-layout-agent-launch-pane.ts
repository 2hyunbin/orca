// A terminal tab's agent-launch pane (design 2.3 transition "agent launch verdict"): which launch
// laid the pane out before its agent existed and, once nothing can change it, how that launch ended.

import { omitStoredFields } from './stored-record-fields'
import { applied, findTerminal, updateTab, type Applied } from './workspace-layout-command-steps'
import type { LayoutTerminalCreation, WorkspaceLayoutModel } from './workspace-layout-model'

export type AgentLaunchPaneOnTab = NonNullable<LayoutTerminalCreation['agentLaunchPane']>

/** Sets or clears a terminal tab's launch pane; a tab the layout no longer has is left alone. */
export function setAgentLaunchPane(
  model: WorkspaceLayoutModel,
  workspace: string,
  tabId: string,
  agentLaunchPane: AgentLaunchPaneOnTab | null
): Applied {
  const layout = model.workspaces[workspace]
  const tab = layout && findTerminal(layout, tabId)
  if (!tab) {
    return applied(model)
  }
  const terminal = agentLaunchPane
    ? { ...tab.terminal, agentLaunchPane }
    : omitStoredFields(tab.terminal, ['agentLaunchPane'])
  return updateTab(model, workspace, { ...tab, terminal })
}
