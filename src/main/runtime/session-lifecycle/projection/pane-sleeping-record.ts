import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { findLegacyNumericSleepingRecord } from '../../../../shared/sleeping-record-legacy-pane-key'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'

/** The pane's record and, for a numbered one, its tab's numbered keys: aliases, not other panes. */
export function findPaneSleepingRecord(
  records: Readonly<Record<string, SleepingAgentSessionRecord>> | undefined,
  worktreeId: string,
  pane: { parentTabId: string; leafId: string }
): { record: SleepingAgentSessionRecord; aliases: readonly string[] } | null {
  const record = records?.[makePaneKey(pane.parentTabId, pane.leafId)]
  if (record) {
    return worktreeIdsEqual(record.worktreeId, worktreeId) ? { record, aliases: [] } : null
  }
  // Switch point: main starts every pane, so it reads the numbered records the window read.
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || !records) {
    return null
  }
  return findLegacyNumericSleepingRecord(records, { tabId: pane.parentTabId }, (candidate) =>
    worktreeIdsEqual(candidate.worktreeId, worktreeId)
  )
}
