import type { ExecutionHostId } from '../../shared/execution-host'
import type { OrchestrationDb } from './orchestration/db'
import {
  planLegacyWorkerTerminalRecovery,
  type LegacyWorkerTerminalRecoveryPlan
} from './orchestration/orchestration-legacy-worker-terminal-recovery'
import type {
  LegacyWorkerRecoveryCandidate,
  LegacyWorkerRecoveryResolution
} from './runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'

export class RuntimeLegacyWorkerTerminalRecoveryPersistence {
  constructor(
    private readonly getHolder: () => RuntimeWorkspaceLayouts,
    private readonly getDb: () => OrchestrationDb,
    private readonly getHostId: (worktreeId: string) => ExecutionHostId | null
  ) {}

  prepare(dispatchIds?: readonly string[]): LegacyWorkerTerminalRecoveryPlan {
    return this.getPlan(dispatchIds) ?? { candidates: [], ambiguousDispatchIds: [] }
  }

  /**
   * The holder applies each resolution; the database hears once its write has ended. Q4: a failed
   * write is logged, not rolled back, and the next save writes it.
   */
  async persist(
    resolutions: readonly LegacyWorkerRecoveryResolution[]
  ): Promise<ReadonlySet<string>> {
    const holder = this.getHolder()
    const dispatchIds = new Set<string>()
    for (const { candidate, resolution, hostId: observedHostId } of resolutions) {
      const hostId = observedHostId ?? this.getHostId(candidate.worktreeId)
      if (!hostId || !holder.holds(hostId)) {
        continue
      }
      holder.transition(hostId, {
        type: 'legacyWorkerRecovered',
        surface: {
          worktreeId: candidate.worktreeId,
          terminalTabId: candidate.tabId,
          leafId: candidate.leafId,
          ptyId: candidate.ptyId,
          ...(candidate.incarnationId ? { incarnationId: candidate.incarnationId } : {})
        },
        resolution
      })
      dropUnplacedSleepingRecord(holder, hostId, candidate)
      dispatchIds.add(candidate.dispatchId)
    }
    await holder.whenDurable()
    return dispatchIds
  }

  reconcileMissing(candidate: LegacyWorkerRecoveryCandidate): boolean {
    try {
      this.getDb().reconcileMissingWorkerTerminal(
        candidate.dispatchId,
        'The assigned worker terminal is no longer live after orchestration recovery.'
      )
      return true
    } catch (error) {
      console.warn('[orchestration] failed to reconcile missing worker terminal', {
        dispatchId: candidate.dispatchId,
        error
      })
      return false
    }
  }

  private getPlan(dispatchIds?: readonly string[]): LegacyWorkerTerminalRecoveryPlan | null {
    try {
      return planLegacyWorkerTerminalRecovery(
        dispatchIds
          ? this.getDb().listLegacyWorkerTerminalRecoveryRows(dispatchIds)
          : this.getDb().listLegacyWorkerTerminalRecoveryRows()
      )
    } catch (error) {
      console.warn('[orchestration] failed to plan legacy worker terminal recovery', error)
      if (dispatchIds) {
        throw error
      }
      return null
    }
  }
}

/** A worker's sleeping record whose pane the layout does not hold is dropped too, as for a placed one. */
function dropUnplacedSleepingRecord(
  holder: RuntimeWorkspaceLayouts,
  hostId: ExecutionHostId,
  candidate: LegacyWorkerRecoveryCandidate
): void {
  const carried = holder.beside(hostId)?.carried
  const record = carried?.unplacedSleepingRecords[candidate.paneKey]
  if (!carried || !record || !runtimeWorktreeIdsEqual(record.worktreeId, candidate.worktreeId)) {
    return
  }
  const { [candidate.paneKey]: _dropped, ...unplacedSleepingRecords } =
    carried.unplacedSleepingRecords
  holder.updateBeside(hostId, { carried: { ...carried, unplacedSleepingRecords } })
}
