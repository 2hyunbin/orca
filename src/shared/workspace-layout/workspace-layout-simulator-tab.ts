// A simulator (mobile emulator) tab a window drew: main records it under the window's ids. The
// emulator itself is the window's; the layout holds only the tab.

import { applied, refuse, workspaceOrEmpty, type Applied } from './workspace-layout-command-steps'
import type { CommandOf, LayoutContext } from './workspace-layout-command-types'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'
import { placeContentTab } from './workspace-layout-tab-commands'

/** The same open again changes nothing; an id another tab holds, or a group main lacks, refuses. */
export function openSimulatorTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openSimulatorTab'>,
  context: LayoutContext
): Applied {
  const key = command.workspace
  const workspace = model.workspaces[key]
  const drawn = workspace?.tabs.find((tab) => tab.id === command.tabId)
  if (drawn?.kind === 'simulator') {
    return applied(model, { tabId: drawn.id })
  }
  if (
    Object.values(model.workspaces).some((entry) =>
      entry.tabs.some((tab) => tab.id === command.tabId)
    )
  ) {
    return refuse('tab_exists')
  }
  let target = model
  if (command.groupId && !workspace?.groups.some((entry) => entry.id === command.groupId)) {
    if (workspace?.groups.length) {
      // Another group would put the tab where the window did not.
      return refuse('group_not_found')
    }
    // A workspace with no group takes the window's, as the window keeps its emptied root group.
    target = withWorkspace(model, key, {
      ...workspaceOrEmpty(model, key),
      groups: [{ id: command.groupId, tabOrder: [] }]
    })
  }
  const tab = {
    id: command.tabId,
    entityId: command.tabId,
    kind: 'simulator' as const,
    createdAt: command.createdAt ?? context.now(),
    customTitle: null,
    color: null
  }
  return applied(placeContentTab(target, key, tab, command, context).model, { tabId: tab.id })
}
