// #18202: an older build saved some local worktrees' terminal tabs only in a `runtime:<env>`
// partition. The Loader folds each into the partition being loaded; a tab that partition already
// lists, or closed, wins, as the contention rule does.

import type { WorkspaceSessionState } from '../workspace-session-state-types'

export type SpilledTerminalTabs = {
  /** `runtime:<env>` partitions, in a fixed order: the first copy of a tab is the one folded. */
  sessions: readonly WorkspaceSessionState[]
  /** Whether a workspace key routes to the partition being loaded. */
  ownsKey: (key: string) => boolean
}

const PANE_KEYED_FIELDS = [
  'terminalPtyIncarnationsByPaneKey',
  'sleepingAgentSessionsByPaneKey',
  'terminalSurfaceTombstonesByPaneKey'
] as const

/** Adds each spilled tab's row, pane layout and pane records to `session`, which the Loader owns. */
export function foldSpilledTerminalTabs(
  session: WorkspaceSessionState,
  spilled: SpilledTerminalTabs
): void {
  const known = new Set([
    ...Object.values(session.tabsByWorktree ?? {}).flatMap((rows) => rows.map((row) => row.id)),
    ...Object.keys(session.closedTerminalTabTombstonesByTabId ?? {})
  ])
  for (const spill of spilled.sessions) {
    for (const [key, rows] of Object.entries(spill.tabsByWorktree ?? {})) {
      if (!spilled.ownsKey(key)) {
        continue
      }
      for (const row of rows) {
        if (known.has(row.id)) {
          continue
        }
        known.add(row.id)
        session.tabsByWorktree = {
          ...session.tabsByWorktree,
          [key]: [...(session.tabsByWorktree?.[key] ?? []), structuredClone(row)]
        }
        const layout = spill.terminalLayoutsByTabId?.[row.id]
        if (layout) {
          session.terminalLayoutsByTabId = {
            ...session.terminalLayoutsByTabId,
            [row.id]: structuredClone(layout)
          }
        }
        foldPaneRecords(session, spill, row.id)
      }
    }
  }
}

function foldPaneRecords(
  session: WorkspaceSessionState,
  spill: WorkspaceSessionState,
  tabId: string
): void {
  for (const field of PANE_KEYED_FIELDS) {
    const records = Object.entries(spill[field] ?? {}).filter(([paneKey]) =>
      paneKey.startsWith(`${tabId}:`)
    )
    if (records.length > 0) {
      session[field] = { ...session[field], ...structuredClone(Object.fromEntries(records)) }
    }
  }
}
