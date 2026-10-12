// Exits the IPC spawn path learns of before or after the runtime does, applied to the holder.

import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { UNVERIFIED_PROCESS_EXIT_CODE } from '../../shared/terminal-exit-cause'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'

export type HeldPane = {
  worktreeId: string
  connectionId?: string | null
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
}

const hostIdOf = (pane: HeldPane): ExecutionHostId =>
  pane.connectionId ? toSshExecutionHostId(pane.connectionId) : 'local'

/** A process that exited while its binding was written: its pane retires, as on main. */
export function retireExitedDuringRegistration(
  holder: RuntimeWorkspaceLayouts,
  pane: HeldPane
): void {
  const hostId = hostIdOf(pane)
  const leaf = holder.model(hostId)?.workspaces[pane.worktreeId]?.leaves?.[pane.leafId]
  if (
    leaf?.ptyId === pane.ptyId &&
    (!pane.incarnationId || leaf.incarnationId === pane.incarnationId)
  ) {
    const { worktreeId: workspace, tabId, leafId } = pane
    holder.apply({ type: 'closePane', workspace, tabId, leafId }, hostId)
  }
}

/** Attach found no process for this pane: never proof that it exited, so the pane stays, unbound. */
export function unbindAbsentPane(
  holder: RuntimeWorkspaceLayouts,
  pane: HeldPane
): 'gone' | 'kept' | 'replaced' {
  return holder.processExited(
    hostIdOf(pane),
    {
      worktreeId: pane.worktreeId,
      terminalTabId: pane.tabId,
      leafId: pane.leafId,
      ptyId: pane.ptyId,
      ...(pane.incarnationId ? { incarnationId: pane.incarnationId } : {})
    },
    {
      exitCode: UNVERIFIED_PROCESS_EXIT_CODE,
      attachAbsent: true,
      local: !pane.connectionId,
      spawnedFresh: false,
      restored: true,
      inputWritten: false,
      outputReceived: false
    }
  )
}
