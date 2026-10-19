import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { UNVERIFIED_PROCESS_EXIT_CODE } from '../../../../shared/terminal-exit-cause'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { clearProviderPtyState } from '../provider/state-cleanup'
import { retireReplacedPaneBinding } from './pane-owner-replacement'

/**
 * The owning host answered that the pane's process is gone. The pane outlives it: a fresh spawn
 * replaces the process, so only the dead id's binding is cleared. False when another owner took
 * the pane meanwhile.
 */
export async function releaseAbsentPaneOwner(
  context: {
    runtime: OrcaRuntimeService | undefined
    store?: Store
    worktreeId?: string
    connectionId?: string | null
  },
  owner: {
    tabId: string
    leafId: string
    ptyId: string
    incarnationId?: string
    runtimeIncarnationId?: string
    persistedIncarnationId?: string
  }
): Promise<boolean> {
  const { runtime, store, worktreeId, connectionId } = context
  // A newer incarnation of this id committed after the host's answer; it is not the absent process.
  const liveIncarnationId = ptyIncarnationById.get(owner.ptyId)
  if (liveIncarnationId !== undefined && liveIncarnationId !== owner.runtimeIncarnationId) {
    return false
  }
  const settleStop = runtime?.intentionalPtyStops?.mark(
    owner.ptyId,
    'replaced',
    owner.incarnationId ?? null
  )
  runtime?.onPtyExit(owner.ptyId, UNVERIFIED_PROCESS_EXIT_CODE, owner.incarnationId, {
    hostExitConfirmed: true
  })
  settleStop?.(true)
  clearProviderPtyState(owner.ptyId)
  ptyOwnership.delete(owner.ptyId)
  if (!worktreeId) {
    return true
  }
  // Without the Store the binding cannot be cleared, so the pane is not free for a fresh spawn.
  if (!store) {
    return false
  }
  return retireReplacedPaneBinding(store, {
    ptyId: owner.ptyId,
    absenceFence: { incarnationId: owner.persistedIncarnationId },
    pane: {
      worktreeId,
      tabId: owner.tabId,
      leafId: owner.leafId,
      hostId: connectionId ? toSshExecutionHostId(connectionId) : undefined
    }
  })
}
