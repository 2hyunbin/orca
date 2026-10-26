/**
 * The general migration's orchestrator (D3a). Per distro it decides when the move driver runs:
 * on a trigger that already woke the distro (never a background boot, A1), previewing first,
 * deferring while terminals are busy, backing off on transient failures and parking what needs
 * the user. A finished move's distro is checked for R38 (unregistered or replaced). It never moves
 * anything itself; the driver and its journal own every move.
 */
import type { WslMovePreview, WslMoveResult } from '../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveUseLocallyResult } from '../../../shared/wsl-move/wsl-moved-project'
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'
import type {
  WslMoveOrchestratorRecord,
  WslMoveOrchestratorTrigger,
  WslMoveOrchestratorUserAction
} from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import {
  applyWslMoveOutcome,
  applyWslMovedDistroVerdict,
  applyWslMoveUserAction,
  classifyWslMoveOutcome,
  mayStartWslMove,
  newWslMoveOrchestratorRecord,
  settleWslMoveOrchestratorRecord,
  WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS,
  type WslMovedDistroVerdict,
  type WslMoveOutcome
} from './wsl-move-orchestrator-transitions'

/** The newest finished move of a distro, as R38's check needs it. */
export type WslMoveFinishedMove = { migrationId: string; distroGuid?: string }

export type WslMoveOrchestratorPorts = {
  now: () => number
  appVersion: string
  /** Kill switches for automatic starts (env, rollout); explicit user actions still run. */
  autoMoveEnabled: () => boolean
  /** Whether the distro's host connection is ready now. Must never connect or boot. */
  isHostReady: (distro: string) => boolean
  preview: (distro: string) => Promise<WslMovePreview>
  start: (distro: string) => Promise<WslMoveResult>
  finishedMove: (distro: string) => WslMoveFinishedMove | null
  /** R38: reads the registry and, when ready, the host's catalog; never boots the distro. */
  checkMovedDistro: (distro: string, move: WslMoveFinishedMove) => Promise<WslMovedDistroVerdict>
  /**
   * R38 restore, step one: drop the finished move so its retained rows can move again. The window
   * reloads after a release, so the move itself waits for the next trigger.
   */
  releaseFinishedMove: (
    distro: string,
    unsavedWorkspaceIds: readonly string[]
  ) => Promise<WslMoveUseLocallyResult>
  load: () => Map<string, WslMoveOrchestratorRecord>
  save: (records: ReadonlyMap<string, WslMoveOrchestratorRecord>) => void
  /** Returns the cancel. */
  schedule: (delayMs: number, run: () => void) => () => void
  /** One row per state change; `cause` is the preview or result behind it. */
  track: (
    trigger: WslMoveOrchestratorTrigger,
    record: WslMoveOrchestratorRecord,
    cause?: WslMovePreview | WslMoveResult
  ) => void
  publish: (records: WslMoveOrchestratorRecord[]) => void
}

export class WslMoveOrchestrator {
  private readonly records: Map<string, WslMoveOrchestratorRecord>
  private readonly busy = new Set<string>()
  private readonly timers = new Map<string, () => void>()
  private disposed = false

  constructor(private readonly ports: WslMoveOrchestratorPorts) {
    const now = ports.now()
    this.records = new Map(
      [...ports.load()].map(([key, record]) => [key, settleWslMoveOrchestratorRecord(record, now)])
    )
    for (const [key, record] of this.records) {
      this.scheduleFor(key, record)
    }
  }

  list(): WslMoveOrchestratorRecord[] {
    return [...this.records.values()]
  }

  /** Runs the distro's next step for a trigger; a run already under way absorbs it. */
  async trigger(distro: string, trigger: WslMoveOrchestratorTrigger): Promise<void> {
    const key = wslMoveJournalKey(distro)
    if (this.disposed || this.busy.has(key)) {
      return
    }
    // A1: only an explicit user action may wake a distro; everything else needs it awake already.
    if (trigger !== 'user' && (!this.ports.autoMoveEnabled() || !this.ports.isHostReady(distro))) {
      return
    }
    this.busy.add(key)
    try {
      await this.step(key, distro, trigger)
    } finally {
      this.busy.delete(key)
    }
  }

  async userAction(
    distro: string,
    action: WslMoveOrchestratorUserAction,
    options: { unsavedWorkspaceIds?: readonly string[] } = {}
  ): Promise<{ record: WslMoveOrchestratorRecord; release?: WslMoveUseLocallyResult }> {
    const key = wslMoveJournalKey(distro)
    const current = this.recordFor(key, distro)
    if (this.busy.has(key)) {
      return { record: current }
    }
    if (action !== 'restore') {
      this.commit(key, 'user', this.userActionRecord(current, action))
      if (action !== 'not-now') {
        await this.trigger(distro, 'user')
      }
      return { record: this.recordFor(key, distro) }
    }
    if (current.state.kind !== 'restore-offered') {
      return { record: current }
    }
    this.busy.add(key)
    let release: WslMoveUseLocallyResult
    try {
      release = await this.ports.releaseFinishedMove(distro, options.unsavedWorkspaceIds ?? [])
    } catch (error) {
      release = {
        released: false,
        reason: 'failed',
        detail: error instanceof Error ? error.message : 'restore_failed'
      }
    } finally {
      this.busy.delete(key)
    }
    if (release.released) {
      this.commit(key, 'user', this.userActionRecord(current, action))
    }
    return { record: this.recordFor(key, distro), release }
  }

  private userActionRecord(
    record: WslMoveOrchestratorRecord,
    action: WslMoveOrchestratorUserAction
  ): WslMoveOrchestratorRecord {
    return applyWslMoveUserAction(record, action, this.ports.now(), this.ports.appVersion)
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.timers.values()) {
      cancel()
    }
    this.timers.clear()
  }

  private recordFor(key: string, distro: string): WslMoveOrchestratorRecord {
    return (
      this.records.get(key) ??
      newWslMoveOrchestratorRecord(distro, this.ports.appVersion, this.ports.now())
    )
  }

  private async step(
    key: string,
    distro: string,
    trigger: WslMoveOrchestratorTrigger
  ): Promise<void> {
    let record = this.recordFor(key, distro)
    // A timer re-check leaves R38 to the triggers, so a deferred move never polls the registry.
    const finished = trigger === 'timer' ? null : this.ports.finishedMove(distro)
    if (finished) {
      const verdict = await this.ports
        .checkMovedDistro(distro, finished)
        .catch((): WslMovedDistroVerdict => 'unknown')
      record = this.commit(
        key,
        trigger,
        applyWslMovedDistroVerdict(record, verdict, this.ports.now())
      )
    }
    if (!mayStartWslMove(record, trigger, this.ports.now(), this.ports.appVersion)) {
      return
    }
    const preview = await this.settle(() => this.ports.preview(distro))
    record = this.commit(key, trigger, this.apply(record, preview), preview)
    if (record.state.kind !== 'moving') {
      return
    }
    const result = await this.settle(() => this.ports.start(distro))
    this.commit(key, trigger, this.apply(record, result), result)
  }

  /** A port that throws is a transient failure, never a lost record. */
  private async settle<T extends WslMovePreview | WslMoveResult>(
    run: () => Promise<T>
  ): Promise<T | { outcome: 'reset'; migrationId: string; detail: string }> {
    try {
      return await run()
    } catch (error) {
      return {
        outcome: 'reset',
        migrationId: '',
        detail: error instanceof Error ? error.message : 'orchestrator_error'
      }
    }
  }

  private apply(
    record: WslMoveOrchestratorRecord,
    cause: WslMovePreview | WslMoveResult
  ): WslMoveOrchestratorRecord {
    const outcome: WslMoveOutcome = classifyWslMoveOutcome(cause)
    return applyWslMoveOutcome(record, outcome, {
      now: this.ports.now(),
      appVersion: this.ports.appVersion
    })
  }

  /** Stores, reports and schedules a record; unchanged records cost nothing. */
  private commit(
    key: string,
    trigger: WslMoveOrchestratorTrigger,
    next: WslMoveOrchestratorRecord,
    cause?: WslMovePreview | WslMoveResult
  ): WslMoveOrchestratorRecord {
    const previous = this.records.get(key)
    if (previous === next) {
      return next
    }
    this.records.set(key, next)
    this.ports.save(this.records)
    if (previous?.state.kind !== next.state.kind) {
      this.ports.track(trigger, next, cause)
    }
    this.ports.publish(this.list())
    this.scheduleFor(key, next)
    return next
  }

  private scheduleFor(key: string, record: WslMoveOrchestratorRecord): void {
    this.timers.get(key)?.()
    this.timers.delete(key)
    const delay =
      record.state.kind === 'backoff'
        ? Math.max(0, record.state.nextAttemptAt - this.ports.now())
        : record.state.kind === 'deferred'
          ? WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS
          : null
    if (delay === null || this.disposed) {
      return
    }
    this.timers.set(
      key,
      this.ports.schedule(delay, () => {
        this.timers.delete(key)
        void this.trigger(record.distro, 'timer')
      })
    )
  }
}
