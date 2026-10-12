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

export class RuntimeLegacyWorkerTerminalRecoveryPersistence {
  constructor(
    private readonly getHolder: () => RuntimeWorkspaceLayouts,
    private readonly getDb: () => OrchestrationDb,
    private readonly getHostId: (worktreeId: string) => ExecutionHostId | null
  ) {}

  prepare(dispatchIds?: readonly string[]): LegacyWorkerTerminalRecoveryPlan {
    return this.getPlan(dispatchIds) ?? { candidates: [], ambiguousDispatchIds: [] }
  }

  /** The holder applies each resolution; the database hears only once the layout is on disk. */
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
