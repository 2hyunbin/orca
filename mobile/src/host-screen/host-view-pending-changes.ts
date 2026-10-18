import type {
  MobileViewPatch,
  MobileViewState,
  WorkspaceViewSettings
} from '../worktree/workspace-view-settings'

/**
 * A Workspace options change this phone sent that the desktop has not answered yet. The list shows
 * its desired value meanwhile; a slow answer is never a refusal.
 */
export type PendingViewChange = { opId: number; sentAt: number } & (
  | { kind: 'view'; patch: MobileViewPatch; payload: WorkspaceViewSettings }
  | { kind: 'collapse'; key: string; collapsed: boolean }
)

/** After this long without an answer the control says it is still waiting, and keeps the value. */
export const PENDING_VIEW_CHANGE_STALE_MS = 10_000

export function applyViewPatch(view: MobileViewState, patch: MobileViewPatch): MobileViewState {
  return { ...view, ...patch, filters: { ...view.filters, ...patch.filters } }
}

export function applyCollapse(
  view: MobileViewState,
  key: string,
  collapsed: boolean
): MobileViewState {
  const rest = view.collapsedGroups.filter((candidate) => candidate !== key)
  return { ...view, collapsedGroups: collapsed ? [...rest, key] : rest }
}

/** The view with every unanswered change laid over it, oldest first. */
export function withPendingViewChanges(
  view: MobileViewState,
  pending: readonly PendingViewChange[]
): MobileViewState {
  return pending.reduce(
    (current, change) =>
      change.kind === 'view'
        ? applyViewPatch(current, change.patch)
        : applyCollapse(current, change.key, change.collapsed),
    view
  )
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Whether the desktop's saved values already hold what the change asked for. */
export function isSettledByDesktop(change: PendingViewChange, ui: WorkspaceViewSettings): boolean {
  if (change.kind === 'collapse') {
    return (ui.collapsedGroups?.includes(change.key) ?? false) === change.collapsed
  }
  return Object.entries(change.payload).every(([field, value]) =>
    sameValue(value, Object.entries(ui).find(([key]) => key === field)?.[1])
  )
}
