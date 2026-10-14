import type { AppState } from '../../../types'

export function appendOpenFileTabBarOrder(
  s: Pick<
    AppState,
    'tabBarOrderByWorktree' | 'tabsByWorktree' | 'openFiles' | 'browserTabsByWorktree'
  >,
  worktreeId: string,
  id: string
): Partial<Pick<AppState, 'tabBarOrderByWorktree'>> {
  const tabBarUpdate: Partial<Pick<AppState, 'tabBarOrderByWorktree'>> = {}
  if (s.tabBarOrderByWorktree) {
    const currentOrder = s.tabBarOrderByWorktree[worktreeId] ?? []
    const terminalIds = (s.tabsByWorktree?.[worktreeId] ?? []).map((t) => t.id)
    const editorFileIds = s.openFiles.filter((f) => f.worktreeId === worktreeId).map((f) => f.id)
    const browserIds = (s.browserTabsByWorktree?.[worktreeId] ?? []).map((t) => t.id)
    const allExisting = new Set([...terminalIds, ...editorFileIds, ...browserIds])
    const base = currentOrder.filter((eid) => allExisting.has(eid))
    const inBase = new Set(base)
    for (const eid of [...terminalIds, ...editorFileIds, ...browserIds]) {
      if (!inBase.has(eid)) {
        base.push(eid)
        inBase.add(eid)
      }
    }
    base.push(id)
    tabBarUpdate.tabBarOrderByWorktree = { ...s.tabBarOrderByWorktree, [worktreeId]: base }
  }

  return tabBarUpdate
}
