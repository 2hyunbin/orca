// Layout-owner builds: every pane a command drops whose terminal no pane holds any more is
// recorded, so the terminal's later exit still finds the pane it retires (closed-terminal-panes.ts).
import { recordClosedTerminalPanes, type ClosedTerminalPane } from '../closed-terminal-panes'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../layout-owner-switch'
import { leafIdsOf } from './workspace-layout-command-steps'
import {
  paneKeyOf,
  type WorkspaceLayout,
  type WorkspaceLayoutModel
} from './workspace-layout-model'

type HeldTerminal = { ptyId: string; incarnationId: string }

function* heldPanes(
  workspace: WorkspaceLayout
): Generator<HeldTerminal & { paneKey: string; leafId: string }> {
  for (const tab of workspace.tabs) {
    if (tab.kind !== 'terminal') {
      continue
    }
    for (const leafId of leafIdsOf(tab)) {
      const leaf = workspace.leaves?.[leafId]
      if (leaf?.ptyId && leaf.incarnationId) {
        const held = { ptyId: leaf.ptyId, incarnationId: leaf.incarnationId }
        yield { ...held, leafId, paneKey: paneKeyOf(tab.entityId, leafId) }
      }
    }
  }
}

export function recordDroppedPanes(
  before: WorkspaceLayoutModel,
  after: WorkspaceLayoutModel,
  now: number
): WorkspaceLayoutModel {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || before.workspaces === after.workspaces) {
    return after
  }
  const stillHeld = new Set<string>()
  for (const workspace of Object.values(after.workspaces)) {
    for (const pane of heldPanes(workspace)) {
      stillHeld.add(`${pane.ptyId}\0${pane.incarnationId}`)
    }
  }
  const dropped: Record<string, Omit<ClosedTerminalPane, 'closedAt'>> = {}
  for (const [key, workspace] of Object.entries(before.workspaces)) {
    if (after.workspaces[key] === workspace) {
      continue
    }
    for (const pane of heldPanes(workspace)) {
      // A pane whose leaf stays, or whose terminal another pane now holds, was not dropped.
      if (
        !after.workspaces[key]?.leaves?.[pane.leafId] &&
        !stillHeld.has(`${pane.ptyId}\0${pane.incarnationId}`)
      ) {
        dropped[pane.paneKey] = {
          ptyId: pane.ptyId,
          incarnationId: pane.incarnationId,
          worktreeId: workspace.worktreeId
        }
      }
    }
  }
  if (Object.keys(dropped).length === 0) {
    return after
  }
  return {
    ...after,
    records: {
      ...after.records,
      closedTerminalPanesByPaneKey: recordClosedTerminalPanes(
        after.records.closedTerminalPanesByPaneKey,
        dropped,
        now
      )
    }
  }
}
