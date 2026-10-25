import { RelayOriginRetirement } from './relay-origin-retirement'
import type { RelayOriginPoolOptions } from './relay-origin-pool-options'
import { RelayControlOrigin } from './relay-control-origin'
import type { RelayControlClient } from './relay-control-client'
import type { RelayDrainMessage } from './relay-control-protocol'
import type { RelayHostCloseReason } from '../../../shared/relay-host-close-reason'
import { RelayRetrySchedule } from './relay-retry-schedule'
import {
  RelayHttpError,
  requestRelayAssignment,
  shouldRetryRelayConnectionError,
  type RelayAssignment
} from './relay-http-client'
import { RelayControlRotation } from './relay-control-rotation'
import { isCellRedirect } from './relay-control-closed-error'
import { RelayLastCellReattach, type RelayLastCellTarget } from './relay-last-cell-reattach'

export class RelayOriginPool {
  private activeOrigin: RelayControlOrigin | null = null
  private readonly origins = new Set<RelayControlOrigin>()
  private readonly retirement = new RelayOriginRetirement(
    () => this.activeOrigin,
    (origin) => {
      this.origins.delete(origin)
    }
  )
  private readonly drainingOrigins = this.retirement.draining
  private readonly basisOrigins = this.retirement.basis
  private assignment: RelayAssignment | null = null
  private deferredAssignment: RelayAssignment | null = null
  private relayJwt: string | null = null
  private readonly rotation: RelayControlRotation
  private rotationPromise: Promise<void> | null = null
  private readonly drainRetry: RelayRetrySchedule
  // A drain that lands while a resolution runs; that resolution's success must not erase it.
  private queuedDrain: { origin: RelayControlOrigin; message: RelayDrainMessage } | null = null
  private readonly lastCell: RelayLastCellReattach
  private closed = false

  constructor(private readonly options: RelayOriginPoolOptions) {
    this.drainRetry = new RelayRetrySchedule(options.random)
    this.lastCell = new RelayLastCellReattach({
      isCurrent: () => this.isCurrent(),
      random: options.random
    })
    this.rotation = new RelayControlRotation({
      ...options,
      current: () => this.activeOrigin,
      available: () => this.isCurrent(),
      token: () => this.relayJwt,
      assignment: () => this.assignment,
      busy: () => Boolean(this.rotationPromise)
    })
  }

  get activeAssignment(): RelayAssignment | null {
    return this.assignment
  }

  get activeControl(): RelayControlClient | null {
    return this.activeOrigin?.availableControl ?? null
  }

  controlForBasis(basisConnId: string): RelayControlClient | null {
    return this.basisOrigins.get(basisConnId)?.availableControl ?? null
  }

  hasLiveControl(): boolean {
    return this.activeOrigin?.hasLiveControl() ?? false
  }

  applyAssignmentMetadata(assignment: RelayAssignment): boolean {
    const current = this.assignment
    if (!this.isCurrent() || !current || assignment.assignmentEpoch < current.assignmentEpoch) {
      return false
    }
    if (assignment.assignmentEpoch > current.assignmentEpoch || this.rotationPromise) {
      if (
        !this.deferredAssignment ||
        assignment.assignmentEpoch >= this.deferredAssignment.assignmentEpoch
      ) {
        this.deferredAssignment = assignment
      }
      return true
    }
    if (assignment.cellUrl !== current.cellUrl) {
      return false
    }
    this.assignment = assignment
    this.activeOrigin?.updateAssignment(assignment)
    return true
  }

  async openInitial(assignment: RelayAssignment, relayJwt: string): Promise<void> {
    this.assignment = assignment
    this.relayJwt = relayJwt
    const origin = this.createOrigin(assignment, relayJwt)
    this.origins.add(origin)
    await origin.open()
    this.assertCurrent()
    this.activeOrigin = origin
    this.rotation.schedule()
  }

  refreshAuthorization(relayJwt: string): void {
    this.relayJwt = relayJwt
    for (const origin of this.origins) {
      origin.refreshAuthorization(relayJwt)
    }
  }

  closeNow(hostCloseReason?: RelayHostCloseReason): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.rotation.cancel()
    this.drainRetry.reset()
    this.queuedDrain = null
    this.lastCell.forget()
    this.retirement.clear()
    for (const origin of this.origins) {
      origin.closeNow(hostCloseReason)
    }
    this.origins.clear()
    this.activeOrigin = null
  }

  private createOrigin(assignment: RelayAssignment, relayJwt: string): RelayControlOrigin {
    return new RelayControlOrigin({
      ...this.options,
      assignment,
      relayJwt,
      onConnectionOwned: (connectionId, origin) => {
        if (this.isCurrent() && this.origins.has(origin)) {
          this.basisOrigins.set(connectionId, origin)
        }
      },
      onConnectionReleased: (connectionId, origin) => {
        if (this.basisOrigins.get(connectionId) === origin) {
          this.basisOrigins.delete(connectionId)
        }
        this.retirement.maybeClose(origin)
      },
      onDrain: (origin, message) => {
        this.lastCell.forget(origin)
        this.handleDrain(origin, message)
      },
      onPendingChanged: (origin) => this.retirement.maybeClose(origin),
      onClose: (origin, code) => {
        if (origin === this.activeOrigin && this.isCurrent()) {
          // A pending rotation would race recovery with its own resume of this origin.
          this.rotation.cancel()
          this.lastCell.noteLoss(origin, code, this.drainingOrigins.has(origin))
          this.options.onStatus('offline')
          this.handleDrain(origin, {
            type: 'drain',
            graceMs: 0,
            recovery: 'resolve-director'
          })
        }
      }
    })
  }

  private handleDrain(origin: RelayControlOrigin, message: RelayDrainMessage): void {
    if (!this.isCurrent() || !this.origins.has(origin)) {
      return
    }
    if (this.rotationPromise) {
      // The running resolution may activate this origin; adopt the drain once it settles.
      if (this.queuedDrain?.origin !== this.activeOrigin || origin === this.activeOrigin) {
        this.queuedDrain = { origin, message }
      }
      return
    }
    if (!this.retirement.adopt(origin, message)) {
      return
    }
    this.options.onStatus('draining')
    if (!this.drainRetry.pending) {
      this.rotationPromise = this.resolveDrainTarget(origin, message).finally(() => {
        this.rotationPromise = null
        const queued = this.isCurrent() ? this.queuedDrain : null
        this.queuedDrain = null
        if (queued && !queued.origin.hasLiveControl()) {
          this.handleDrain(queued.origin, queued.message)
        } else if (queued && this.retirement.adopt(queued.origin, queued.message)) {
          // Backed off: a cell that re-sends its drain to a director-kept origin must not loop.
          this.options.onStatus('draining')
          this.drainRetry.schedule(0, () => this.handleDrain(queued.origin, queued.message))
        }
      })
    }
  }

  private async resolveDrainTarget(
    origin: RelayControlOrigin,
    message: RelayDrainMessage
  ): Promise<void> {
    try {
      if (!this.relayJwt) {
        throw new Error('relay_authorization_unavailable')
      }
      const preferredRegion = await this.options.resolvePreferredRegion?.().catch(() => undefined)
      this.assertCurrent()
      let assignment: RelayAssignment
      try {
        // Migration targets must come from the configured director.
        assignment = await requestRelayAssignment({
          directorUrl: this.options.directorUrl,
          relayToken: this.relayJwt,
          relayHostId: this.options.relayHostId,
          reconnect: true,
          preferredRegion,
          isCurrent: () => this.isCurrent(),
          fetch: this.options.fetch
        })
      } catch (error) {
        if (!shouldRetryRelayConnectionError(error)) {
          throw error
        }
        await this.lastCell.attempt(
          origin,
          error,
          () => this.heldAssignmentTarget(),
          (target) =>
            this.reattachSameCell(origin, target.assignment, target.relayJwt, message.graceMs)
        )
        // The backoff resets only on a director answer, so repeated losses keep backing off.
        this.options.onStatus('registered')
        this.rotation.schedule()
        return
      }
      this.assertCurrent()
      this.lastCell.forget()
      if (
        this.deferredAssignment &&
        this.deferredAssignment.assignmentEpoch > assignment.assignmentEpoch
      ) {
        assignment = this.deferredAssignment
      }
      this.deferredAssignment = null
      await (assignment.cellUrl === origin.cellUrl
        ? this.reattachSameCell(origin, assignment, this.relayJwt, message.graceMs)
        : this.activateTarget(origin, assignment, this.relayJwt, message.graceMs))
      this.options.onStatus('registered')
      if (!this.queuedDrain?.origin.hasLiveControl()) {
        this.drainRetry.reset()
      }
      this.rotation.schedule()
    } catch (error) {
      if (this.isCurrent() && origin === this.activeOrigin) {
        // Silent retries hid minutes of Director-503 recovery delays in the 2026-08 incident.
        console.warn(
          '[relay] control recovery attempt failed:',
          error instanceof Error ? error.message : String(error)
        )
        const retryAfterMs = error instanceof RelayHttpError ? (error.retryAfterMs ?? 0) : 0
        this.drainRetry.schedule(retryAfterMs, () => this.handleDrain(origin, message))
      }
    }
  }

  private heldAssignmentTarget(): RelayLastCellTarget | null {
    const { assignment, relayJwt } = this
    const usable = this.isCurrent() && !this.deferredAssignment && assignment && relayJwt
    return usable ? { assignment, relayJwt } : null
  }

  private async reattachSameCell(
    origin: RelayControlOrigin,
    assignment: RelayAssignment,
    relayJwt: string,
    graceMs: number
  ): Promise<void> {
    try {
      await origin.rebind(relayJwt, assignment)
    } catch (error) {
      if (isCellRedirect(error)) {
        throw error
      }
      // A restarted cell lost the resume secret; failed rebind must recover with a fresh generation.
      await this.activateTarget(origin, assignment, relayJwt, graceMs)
      return
    }
    this.assertCurrent()
    this.activeOrigin = origin
    this.assignment = assignment
    this.drainingOrigins.delete(origin)
  }

  private async activateTarget(
    origin: RelayControlOrigin,
    assignment: RelayAssignment,
    relayJwt: string,
    graceMs: number
  ): Promise<void> {
    const target = this.createOrigin(assignment, relayJwt)
    this.origins.add(target)
    try {
      await target.open()
      this.assertCurrent()
    } catch (error) {
      this.origins.delete(target)
      target.closeNow()
      throw error
    }
    this.activeOrigin = target
    this.assignment = assignment
    this.retirement.schedule(origin, graceMs)
    this.retirement.maybeClose(origin)
  }
  private assertCurrent(): void {
    if (!this.isCurrent()) {
      throw new Error('stale_relay_origin_pool')
    }
  }

  private isCurrent(): boolean {
    return !this.closed && this.options.isCurrent()
  }
}
