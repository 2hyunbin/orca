import { BoundedMap } from './bounded-map'
import {
  OBJECT_MAINTENANCE_COOLDOWN_MS,
  OBJECT_MAINTENANCE_FAILURE_COOLDOWN_MS,
  type ObjectMaintenanceOutcome
} from './repo-object-maintenance-policy'
import {
  PACK_INDEX_MAINTENANCE_COOLDOWN_MS,
  PACK_INDEX_MAINTENANCE_FAILURE_COOLDOWN_MS,
  type PackIndexMaintenanceOutcome
} from './repo-pack-index-maintenance-policy'
import {
  REF_MAINTENANCE_CLEAN_COOLDOWN_MS,
  type RefMaintenanceOutcome,
  type RefMaintenanceSpan,
  type RepoRefMaintenanceTarget
} from './repo-ref-maintenance-policy'

export class RepoMaintenanceSchedule {
  private readonly refCooldownUntil = new BoundedMap<string, number>({ maxEntries: 256 })
  private readonly indexCooldownUntil = new BoundedMap<string, number>({ maxEntries: 256 })
  private readonly objectCooldownUntil = new BoundedMap<string, number>({ maxEntries: 256 })

  constructor(private readonly now: () => number) {}

  refDueAt(key: string): number {
    return this.refCooldownUntil.peek(key) ?? 0
  }

  indexDueAt(key: string): number {
    return this.indexCooldownUntil.get(key) ?? 0
  }

  /** Earliest time any phase this target supports is off cooldown. */
  nextDueAt(target: RepoRefMaintenanceTarget): number {
    const refDueAt = this.refDueAt(target.key)
    return Math.min(
      refDueAt,
      target.maintainPackIndex ? this.indexDueAt(target.key) : refDueAt,
      target.maintainObjects ? (this.objectCooldownUntil.get(target.key) ?? 0) : refDueAt
    )
  }

  postponeIndex(key: string, cooldownMs: number): void {
    this.indexCooldownUntil.set(key, this.now() + cooldownMs)
  }

  clear(): void {
    this.refCooldownUntil.clear()
    this.indexCooldownUntil.clear()
    this.objectCooldownUntil.clear()
  }

  settleRefs(
    key: string,
    span: RefMaintenanceSpan,
    outcome: RefMaintenanceOutcome,
    cooldownMs: number
  ): void {
    span.setAttribute('repo.maintenance_outcome', outcome)
    this.refCooldownUntil.set(key, this.now() + cooldownMs)
  }

  async probeOptOut(
    target: RepoRefMaintenanceTarget,
    signal: AbortSignal,
    span: RefMaintenanceSpan,
    canWrite: () => boolean
  ): Promise<boolean | { error: unknown }> {
    try {
      if (!(await target.isOptedOut?.(signal)) || signal.aborted || !canWrite()) {
        return false
      }
      this.postponeIndex(target.key, REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
      this.objectCooldownUntil.set(target.key, this.now() + REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
      this.settleRefs(target.key, span, 'opted_out', REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
      return true
    } catch (error) {
      span.setAttribute('repo.maintenance_error', String(error))
      span.setAttribute('repo.maintenance_outcome', 'failed' satisfies RefMaintenanceOutcome)
      return { error }
    }
  }

  async maintain(
    target: RepoRefMaintenanceTarget,
    signal: AbortSignal,
    span: RefMaintenanceSpan,
    canWrite: () => boolean
  ): Promise<PackIndexMaintenanceOutcome | void> {
    if (!target.maintainPackIndex || this.now() < this.indexDueAt(target.key)) {
      return
    }
    const outcome = await target.maintainPackIndex(signal, span, canWrite)
    if (signal.aborted || outcome === 'deferred') {
      return outcome
    }
    if (outcome !== 'written' && !canWrite()) {
      return 'deferred'
    }
    const cooldown =
      outcome === 'failed'
        ? PACK_INDEX_MAINTENANCE_FAILURE_COOLDOWN_MS
        : outcome === 'opted_out' || outcome === 'protected'
          ? REF_MAINTENANCE_CLEAN_COOLDOWN_MS
          : PACK_INDEX_MAINTENANCE_COOLDOWN_MS
    this.postponeIndex(target.key, cooldown)
    return outcome
  }

  /** A started repack settles even if admission closed meanwhile; it was never killed. */
  async maintainObjects(
    target: RepoRefMaintenanceTarget,
    signal: AbortSignal,
    span: RefMaintenanceSpan,
    canWrite: () => boolean
  ): Promise<ObjectMaintenanceOutcome | void> {
    if (!target.maintainObjects || this.now() < (this.objectCooldownUntil.get(target.key) ?? 0)) {
      return
    }
    const outcome = await target.maintainObjects(signal, span, canWrite)
    span.setAttribute('git.object_maintenance_outcome', outcome)
    if (
      outcome === 'deferred' ||
      (outcome !== 'ran' && outcome !== 'failed' && (signal.aborted || !canWrite()))
    ) {
      return 'deferred'
    }
    const cooldown =
      outcome === 'failed' || outcome === 'unsupported'
        ? OBJECT_MAINTENANCE_FAILURE_COOLDOWN_MS
        : OBJECT_MAINTENANCE_COOLDOWN_MS
    this.objectCooldownUntil.set(target.key, this.now() + cooldown)
    return outcome
  }
}
