// Which of a workspace's groups the session-tabs list shows first and selects.

import type { TabGroupLayoutNode } from '../../tab-types'
import type { WorkspaceLayout } from '../workspace-layout-model'

/** As a window restores it: the saved group while the workspace has it, else the first group. */
export function resolveActiveGroupId(
  workspace: WorkspaceLayout,
  saved: string | undefined
): string | null {
  if (saved && workspace.groups.some((group) => group.id === saved)) {
    return saved
  }
  return groupsInLayoutOrder(workspace)[0]?.id ?? null
}

export function groupsInLayoutOrder(workspace: WorkspaceLayout): WorkspaceLayout['groups'] {
  const ids: string[] = []
  const visit = (node: TabGroupLayoutNode | undefined): void => {
    if (node?.type === 'leaf') {
      ids.push(node.groupId)
    } else if (node) {
      visit(node.first)
      visit(node.second)
    }
  }
  visit(workspace.groupLayout)
  const placed = ids.flatMap((id) => workspace.groups.filter((group) => group.id === id))
  return [...placed, ...workspace.groups.filter((group) => !placed.includes(group))]
}
