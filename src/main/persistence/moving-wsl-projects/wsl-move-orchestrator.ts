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
  applyWslMoveHostRemovalPending,
  applyWslMoveReleasedByUser,
  applyWslMoveUserAction,
  classifyWslMoveOutcome,
  mayStartWslMove,
  newWslMoveOrchestratorRecord,
  sameWslMoveOrchestratorRecord,
  settleWslMoveOrchestratorRecord,
  wslMoveOrchestratorTimerDelay,
  type WslMovedDistroVerdict,
  type WslMoveOutcome
} from './wsl-move-orchestrator-transitions'

export type WslMoveHostReadiness = 'ready' | 'not-running' | 'unverifiable' | 'failed'

/** A project opened again within this window does not read the running distros again. */
export const WSL_MOVE_ORCHESTRATOR_PROJECT_OPENED_THROTTLE_MS = 60_000

/** The newest finished move of a distro, as R38's check needs it. */
export type WslMoveFinishedMove = { migrationId: string; distroGuid?: string }

export type WslMoveOrchestratorPorts = {
  now: () => number
  appVersion: string
  /** Kill switches for automatic starts (env, rollout); explicit user actions still run. */
  autoMoveEnabled: () => boolean
  /**
   * Readies the distro's host for an automatic step, only if the distro is confirmed running:
   * connects or adds its host then, and never boots it (A1). A failed running-distro read is
   * `unverifiable`, never `not-running`: losing contact is no evidence either way.
   */
  prepareHost: (distro: string) => Promise<WslMoveHostReadiness>
  /** E11: the user's Remove of the distro's host has not proven its server stopped. */
  hostRemovalPending: (distro: string) => boolean
  /** Whether the distro's host connection is ready now; never connects. Gates timer steps. */
  isHostReady: (distro: string) => boolean
  preview: (distro: string) => Promise<WslMovePreview>
  start: (distro: string) => Promise<WslMoveResult>
  finishedMove: (distro: string) => WslMoveFinishedMove | null
  /** R38: reads the registry and, when ready, the host's catalog; never boots the distro. */
  checkMovedDistro: (distro: string, move: WslMoveFinishedMove) => Promise<WslMovedDistroVerdict>
  /**
   * R38 restore, step one: drop every finished move of the distro, newest first, so its retained
   * rows can move again. The window reloads after a release; the move waits for the next trigger.
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
  private readonly projectOpenedAt = new Map<string, number>()
  /** A wake that arrived while the distro was busy, run once the current step ends. */
  private readonly queued = new Map<
    string,
    { distro: string; trigger: WslMoveOrchestratorTrigger }
  >()
  private disposed = false

  constructor(private readonly ports: WslMoveOrchestratorPorts) {
    const now = ports.now()
    this.records = new Map(
      [...ports.load()].map(([key, record]) => [
        key,
        // An unreadable journal says nothing about whether a move is finished: keep the record.
        settleWslMoveOrchestratorRecord(record, now, this.readFinishedMove(record.distro) !== null)
      ])
    )
    for (const [key, record] of this.records) {
      this.scheduleFor(key, record)
    }
  }

  list(): WslMoveOrchestratorRecord[] {
    return [...this.records.values()]
  }

  /**
   * Runs the distro's next step for a trigger. A wake that arrives mid-step runs once after it;
   * a timer or user trigger then is absorbed (the step it would repeat is under way).
   */
  async trigger(distro: string, trigger: WslMoveOrchestratorTrigger): Promise<void> {
    const key = wslMoveJournalKey(distro)
    if (this.disposed || (trigger !== 'user' && !this.ports.autoMoveEnabled())) {
      return
    }
    if (this.busy.has(key)) {
      if (trigger === 'project-opened' || trigger === 'connect') {
        this.queued.set(key, { distro, trigger })
      }
      return
    }
    if (trigger === 'project-opened') {
      const now = this.ports.now()
      const last = this.projectOpenedAt.get(key)
      if (last !== undefined && now - last < WSL_MOVE_ORCHESTRATOR_PROJECT_OPENED_THROTTLE_MS) {
        return
      }
      this.projectOpenedAt.set(key, now)
    }
    await this.run(key, distro, trigger)
  }

  private async run(
    key: string,
    distro: string,
    trigger: WslMoveOrchestratorTrigger
  ): Promise<void> {
    this.busy.add(key)
    try {
      await this.step(key, distro, trigger)
    } finally {
      this.busy.delete(key)
    }
    await this.replayQueued(key)
  }

  /** Runs the wake that arrived while the distro was busy, once it no longer is. */
  private async replayQueued(key: string): Promise<void> {
    const queued = this.queued.get(key)
    if (queued && !this.disposed && !this.busy.has(key)) {
      this.queued.delete(key)
      await this.run(key, queued.distro, queued.trigger)
    }
  }

  /** "Use on this computer again" ran for the distro: park it until the user asks again. */
  releasedByUser(distro: string): void {
    const key = wslMoveJournalKey(distro)
    this.commit(
      key,
      'user',
      applyWslMoveReleasedByUser(this.recordFor(key, distro), this.ports.now())
    )
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
    const result = { record: this.recordFor(key, distro), release }
    // A wake that came in during the release runs now, as it would after any step.
    await this.replayQueued(key)
    return result
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

  /** The newest finished move; `unknown` when the journal cannot be read. */
  private readFinishedMove(distro: string): WslMoveFinishedMove | null | 'unknown' {
    try {
      return this.ports.finishedMove(distro)
    } catch {
      return 'unknown'
    }
  }

  /**
   * True when the record changed under an await (the user released the move, or chose Not now):
   * the step's view is stale and must not overwrite the user's choice.
   */
  private changedUnder(key: string, seen: WslMoveOrchestratorRecord): boolean {
    const current = this.records.get(key)
    return current !== undefined && current !== seen
  }

  private async step(
    key: string,
    distro: string,
    trigger: WslMoveOrchestratorTrigger
  ): Promise<void> {
    let record = this.recordFor(key, distro)
    // Before anything that could connect, add or move: even the user's Retry waits for the Remove.
    let removalPending: boolean
    try {
      removalPending = this.ports.hostRemovalPending(distro)
    } catch {
      // An unreadable host record proves nothing either way; touch nothing this time.
      return
    }
    if (removalPending) {
      this.commit(key, trigger, applyWslMoveHostRemovalPending(record, this.ports.now()))
      return
    }
    // A timer re-check leaves R38 to the triggers, so a deferred move never polls the registry.
    const finished = trigger === 'timer' ? null : this.readFinishedMove(distro)
    if (finished === 'unknown') {
      return
    }
    if (finished) {
      const verdict = await this.ports
        .checkMovedDistro(distro, finished)
        .catch((): WslMovedDistroVerdict => 'unknown')
      if (this.changedUnder(key, record)) {
        return
      }
      record = this.commit(
        key,
        trigger,
        applyWslMovedDistroVerdict(record, verdict, this.ports.now())
      )
    }
    if (!mayStartWslMove(record, trigger, this.ports.now(), this.ports.appVersion)) {
      return
    }
    // A1: only an explicit user action may wake a distro; every other step needs it running.
    // A timer step never connects either: connecting can hold a running distro up.
    if (trigger === 'timer') {
      if (!this.ports.isHostReady(distro)) {
        return
      }
    } else if (trigger !== 'user') {
      const readiness = await this.ports
        .prepareHost(distro)
        .catch((): WslMoveHostReadiness => 'unverifiable')
      if (readiness !== 'ready' || this.changedUnder(key, record)) {
        return
      }
    }
    const preview = await this.settle(() => this.ports.preview(distro))
    if (this.changedUnder(key, record)) {
      return
    }
    record = this.commit(key, trigger, this.apply(record, preview, trigger), preview)
    if (record.state.kind !== 'moving') {
      return
    }
    const result = await this.settle(() => this.ports.start(distro))
    if (!this.changedUnder(key, record)) {
      this.commit(key, trigger, this.apply(record, result, trigger), result)
    }
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
    cause: WslMovePreview | WslMoveResult,
    trigger: WslMoveOrchestratorTrigger
  ): WslMoveOrchestratorRecord {
    const outcome: WslMoveOutcome = classifyWslMoveOutcome(cause)
    return applyWslMoveOutcome(record, outcome, {
      now: this.ports.now(),
      appVersion: this.ports.appVersion,
      trigger
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
    if (previous === next || sameWslMoveOrchestratorRecord(previous, next)) {
      return previous ?? next
    }
    this.records.set(key, next)
    this.ports.save(this.records)
    // Every new attempt is reported too, so a backoff series shows each failure.
    if (previous?.state.kind !== next.state.kind || previous.attempts !== next.attempts) {
      this.ports.track(trigger, next, cause)
    }
    this.ports.publish(this.list())
    this.scheduleFor(key, next)
    return next
  }

  private scheduleFor(key: string, record: WslMoveOrchestratorRecord): void {
    this.timers.get(key)?.()
    this.timers.delete(key)
    const delay = wslMoveOrchestratorTimerDelay(record, this.ports.now())
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
