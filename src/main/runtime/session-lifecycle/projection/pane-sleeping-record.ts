import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { findLegacyNumericSleepingRecord } from '../../../../shared/sleeping-record-legacy-pane-key'
import { makePaneKey, parseLegacyNumericPaneKey } from '../../../../shared/stable-pane-id'
import { resolveRuntimePaneTitleLeafIdFromRoot } from '../../../../shared/runtime-pane-title-leaf-id'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { collectPersistedTerminalLeafIds } from '../../mobile-session-layout-projection'

/** The pane's record and, for a numbered one, its tab's numbered keys: aliases, not other panes. */
export function findPaneSleepingRecord(
  session: WorkspaceSessionState | null | undefined,
  worktreeId: string,
  pane: { parentTabId: string; leafId: string }
): { record: SleepingAgentSessionRecord; aliases: readonly string[] } | null {
  const records = session?.sleepingAgentSessionsByPaneKey
  const record = records?.[makePaneKey(pane.parentTabId, pane.leafId)]
  if (record) {
    return worktreeIdsEqual(record.worktreeId, worktreeId) ? { record, aliases: [] } : null
  }
  // Switch point: main starts every pane, so it reads the numbered records the window read.
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || !records) {
    return null
  }
  // The pane's number as the window numbers a restored tab's panes, from main's layout.
  const root = layoutOf(session, pane)?.root
  const numericPaneId = Object.keys(records)
    .map((paneKey) => parseLegacyNumericPaneKey(paneKey))
    .find(
      (legacy) =>
        legacy?.tabId === pane.parentTabId &&
        resolveRuntimePaneTitleLeafIdFromRoot(root, legacy.numericPaneId) === pane.leafId
    )?.numericPaneId
  const found = findLegacyNumericSleepingRecord(
    records,
    { tabId: pane.parentTabId, numericPaneId },
    (candidate) => worktreeIdsEqual(candidate.worktreeId, worktreeId)
  )
  // Why: in a split only the pane's own number counts, or every pane would take one record.
  const exact = parseLegacyNumericPaneKey(found?.paneKey)?.numericPaneId === numericPaneId
  return found && (exact || collectPersistedTerminalLeafIds(layoutOf(session, pane)).length <= 1)
    ? found
    : null
}

function layoutOf(
  session: WorkspaceSessionState | null | undefined,
  pane: { parentTabId: string }
) {
  return session?.terminalLayoutsByTabId?.[pane.parentTabId]
}
