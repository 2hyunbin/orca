import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { SidebarTemporalSnapshotSchema } from '../../../../shared/sidebar-list/sidebar-temporal-snapshot'
import { defineSidebarShadowDomain } from './sidebar-shadow-comparison'
import { toLocallyOwnedRows } from './workspace-activity-shadow'
import { readWindowSidebarTemporal } from './window-sidebar-temporal-readout'

type TemporalValue = { mode?: string; ids: string[] }

// Ids only this host's runtime answers for, each with one row, so it maps to one identity.
function readComparableIdentities(): Map<string, string> {
  const state = useAppStore.getState()
  const rowsById = new Map<string, Worktree[]>()
  for (const worktree of getAllWorktreesFromState(state)) {
    rowsById.set(worktree.id, [...(rowsById.get(worktree.id) ?? []), worktree])
  }
  const identities = new Map<string, string>()
  for (const [id, rows] of toLocallyOwnedRows(state, rowsById)) {
    if (rows.length === 1) {
      identities.set(id, getWorktreeHostIdentity(rows[0]))
    }
  }
  return identities
}

/**
 * Main's frozen order and sweep retention against the window's own, for the list session the
 * window began. Rows a paired server answers for, and rows the window does not list, are left out.
 */
export const sidebarTemporalShadow = defineSidebarShadowDomain<TemporalValue>({
  name: 'sidebar-temporal',
  readWindow: () => {
    const window = readWindowSidebarTemporal()
    const values = new Map<string, TemporalValue>()
    if (!window) {
      return values
    }
    const identities = readComparableIdentities()
    const toIdentities = (ids: Iterable<string>): string[] =>
      [...ids].flatMap((id) => identities.get(id) ?? [])
    values.set('sort', { mode: window.sortBy, ids: toIdentities(window.sortedIds) })
    if (window.retainedIds) {
      values.set('retention', { ids: toIdentities(window.retainedIds).sort() })
    }
    return values
  },
  readMain: async () => {
    const response = await window.api.runtime.call({ method: 'sidebarInputs.temporal' })
    const parsed = response.ok ? SidebarTemporalSnapshotSchema.safeParse(response.result) : null
    if (!parsed?.success) {
      return null
    }
    const main = parsed.data
    const values = new Map<string, TemporalValue>()
    // Another session's state, or one main has not sampled yet, has nothing to agree with.
    if (main.sessionId !== readWindowSidebarTemporal()?.sessionId || !main.sortSnapshot) {
      return { revision: main.revision, values }
    }
    const comparable = new Set(readComparableIdentities().values())
    const scoped = (ids: readonly string[]): string[] => ids.filter((id) => comparable.has(id))
    values.set('sort', { mode: main.sortSnapshot.mode, ids: scoped(main.sortSnapshot.rankedIds) })
    if (main.retention) {
      values.set('retention', { ids: scoped(main.retention.retainedIds) })
    }
    return { revision: main.revision, values }
  },
  equals: (window, main) => JSON.stringify(window ?? null) === JSON.stringify(main ?? null)
})
