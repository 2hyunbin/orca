import { agentHookServer } from '../agent-hooks/server'
import { forgetFailedAgentLaunches } from '../agent-launch/agent-launch-pane-attachment'
import type { Store } from '../persistence/loading-store/store'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { TerminalLeafMoveRequest } from '../../shared/terminal-leaf-move'
import type { OrcaRuntimeService } from './orca-runtime'

type PaneOwnerRuntime = Pick<OrcaRuntimeService, 'getExistingOrchestrationDb'> | undefined
type PaneAddress = { tabId: string; leafId: string }

/** After a committed pane-key change: agent-status and orchestration keys follow the pane. */
function rekeyPaneOwners(
  runtime: PaneOwnerRuntime,
  worktreeId: string,
  from: PaneAddress,
  to: PaneAddress,
  ptyId: string | null
): void {
  const fromPaneKey = makePaneKey(from.tabId, from.leafId)
  const toPaneKey = makePaneKey(to.tabId, to.leafId)
  forgetFailedAgentLaunches(worktreeId, { kind: 'pane', ...from })
  try {
    // The process keeps the pane key baked into its env, so status must alias old to new.
    agentHookServer.transferPaneAuthority(fromPaneKey, toPaneKey, ptyId ?? undefined, Date.now(), {
      authorityVerified: true
    })
  } catch (error) {
    console.warn('[pty] moved pane kept its old agent-status key:', error)
  }
  try {
    runtime?.getExistingOrchestrationDb()?.rekeyWorkerTerminalResourcePaneKey({
      fromPaneKey,
      toPaneKey
    })
  } catch (error) {
    console.warn('[pty] moved pane kept its old orchestration resource key:', error)
  }
}

/** After a committed move of a pane into a new tab: agent-status and orchestration keys follow. */
export function rekeyMovedPaneOwners(
  runtime: PaneOwnerRuntime,
  /** `ptyId` is the terminal the committed move bound the pane to. */
  request: TerminalLeafMoveRequest
): void {
  rekeyPaneOwners(
    runtime,
    request.worktreeId,
    { tabId: request.sourceTabId, leafId: request.leafId },
    { tabId: request.targetTabId, leafId: request.leafId },
    request.ptyId
  )
}

/** Layout-owner builds: main's one load-time repair, once this runtime can move pane owners. */
export async function repairDuplicatePtyPanesOnStart(
  store: Pick<Store, 'repairDuplicatePtyPanes'>,
  runtime: PaneOwnerRuntime
): Promise<void> {
  try {
    await store.repairDuplicatePtyPanes((move) =>
      rekeyPaneOwners(
        runtime,
        move.worktreeId,
        { tabId: move.tabId, leafId: move.removedLeafId },
        { tabId: move.tabId, leafId: move.retainedLeafId },
        move.ptyId
      )
    )
  } catch (error) {
    console.warn('[persistence] duplicate-terminal pane repair was not written:', error)
  }
}
