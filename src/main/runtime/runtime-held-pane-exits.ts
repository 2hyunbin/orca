// Exits the IPC spawn path learns of before or after the runtime does, applied to the holder.

import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { UNVERIFIED_PROCESS_EXIT_CODE } from '../../shared/terminal-exit-cause'
import {
  locateExitedSurface,
  type ExitedSurface
} from '../../shared/workspace-layout/workspace-layout-removal'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'

export type HeldPane = {
  worktreeId: string
  connectionId?: string | null
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
}

const exitedSurfaceOf = (pane: Omit<HeldPane, 'connectionId'>): ExitedSurface => ({
  worktreeId: pane.worktreeId,
  terminalTabId: pane.tabId,
  leafId: pane.leafId,
  ptyId: pane.ptyId,
  ...(pane.incarnationId ? { incarnationId: pane.incarnationId } : {})
})

export const hostIdOfPane = (pane: Pick<HeldPane, 'connectionId'>): ExecutionHostId =>
  pane.connectionId ? toSshExecutionHostId(pane.connectionId) : 'local'

/**
 * Retires an exited terminal's pane, as main does today for a pane the window still owns and for
 * a process that exited while its binding was written. False when the pane shows another terminal.
 * The caller awaits the durable flush; the process is gone, so nothing is stopped.
 */
export function retireExitedPane(
  holder: RuntimeWorkspaceLayouts,
  hostId: ExecutionHostId,
  pane: Omit<HeldPane, 'connectionId'>
): boolean {
  const model = holder.model(hostId)
  const surface = exitedSurfaceOf(pane)
  const location = model ? locateExitedSurface(model, surface) : 'gone'
  if (location === 'replaced') {
    return false
  }
  if (location !== 'gone') {
    holder.transition(hostId, { type: 'surfaceRetired', surface }, { durable: false })
  }
  return true
}

/** Attach found no process for this pane: never proof that it exited, so the pane stays, unbound. */
export function unbindAbsentPane(
  holder: RuntimeWorkspaceLayouts,
  pane: HeldPane
): 'gone' | 'kept' | 'replaced' {
  return holder.processExited(hostIdOfPane(pane), exitedSurfaceOf(pane), {
    exitCode: UNVERIFIED_PROCESS_EXIT_CODE,
    attachAbsent: true,
    local: !pane.connectionId,
    spawnedFresh: false,
    restored: true,
    inputWritten: false,
    outputReceived: false
  })
}
