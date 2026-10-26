import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import {
  hasUnfilteredOrchestrationWaiter,
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxTerminal } from './mailbox-owner'
import {
  OrchestrationMailboxPointerState,
  type OrchestrationMailboxDeliveryFlight
} from './mailbox-pointer-state'
import {
  MAILBOX_POINTER_RESERVED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './db/messages/mailbox-pointer-enter-state'
import { resumePendingOrchestrationMailboxPointer } from './mailbox-pointer-resume'
import { stageOrchestrationMailboxPointer } from './mailbox-pointer-stage'

export type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'

const DEFAULT_POINTER_ENTER_DELAY_MS = 500

function pointerEnterDelayMs(): number {
  const configured = Number(process.env.ORCA_E2E_ORCHESTRATION_POINTER_ENTER_DELAY_MS)
  return Number.isFinite(configured) && configured >= 1 && configured <= 60_000
    ? configured
    : DEFAULT_POINTER_ENTER_DELAY_MS
}

export class OrchestrationMailboxPointerDelivery<TWaiter extends OrchestrationMessageWaiter> {
  private readonly state = new OrchestrationMailboxPointerState()
  private readonly coldParkedPtys = new Set<string>()
  constructor(private readonly deps: PointerDeliveryDependencies<TWaiter>) {}

  deliverForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    const terminalHandle = this.deps.deliveryTarget.resolveTerminalHandle(handle)
    if (!terminalHandle) {
      return
    }
    const terminal = this.deps.getTerminalForHandle(terminalHandle)
    // Persisted mail stays available to an explicit check or the terminal's next idle edge.
    if (terminal?.lastAgentStatus !== 'idle' || !terminal.lastAgentStatusObservedLive) {
      return
    }
    const mailboxHandle = this.deps.mailboxOwner.resolve(terminal, handle)
    if (mailboxHandle) {
      this.deliver(terminal, { mailboxHandle, reservedTypes })
    }
  }

  deliver(
    terminal: OrchestrationMailboxTerminal,
    options: {
      mailboxHandle: string
      reservedTypes?: ReadonlySet<string>
      skipAbsenceProbe?: boolean
    }
  ): void {
    const db = this.deps.getDb()
    const mailboxHandle = options.mailboxHandle
    if (!db || (!mailboxHandle.startsWith('run:') && !mailboxHandle.startsWith('dispatch:'))) {
      return
    }
    const { ptyId } = terminal
    // Gate settled-agent input at this shared commit point; refusal parks for recheck instead of dropping mail.
    if (!this.deps.isAgentSettledForDelivery(ptyId)) {
      this.parkRedelivery(mailboxHandle, options.reservedTypes)
      return
    }
    const deferredEnter = this.state.takeDeferredEnter(ptyId)
    if (deferredEnter) {
      this.state.parkDelivery(ptyId, mailboxHandle, options.reservedTypes)
      deferredEnter()
      return
    }
    if (this.state.hasFlight(ptyId)) {
      this.state.parkDelivery(ptyId, mailboxHandle, options.reservedTypes)
      return
    }
    if (this.state.hasActiveWatermark(mailboxHandle)) {
      this.parkRedelivery(mailboxHandle, options.reservedTypes)
      return
    }

    const waiters = this.deps.getMessageWaiters(mailboxHandle)
    if (hasUnfilteredOrchestrationWaiter(waiters)) {
      return
    }
    const pending = db.getPendingMailboxPointerMessages(mailboxHandle)
    if (
      pending.length > 0 &&
      resumePendingOrchestrationMailboxPointer({
        deps: this.deps,
        state: this.state,
        terminal,
        mailboxHandle,
        messages: pending,
        settle: (ptyId, flight) => this.settle(ptyId, flight),
        redrive: (redriveMailbox, force) => this.redrive(redriveMailbox, force)
      })
    ) {
      return
    }
    const { messages: unread, heldDeliveryId } = selectOrchestrationPointerBatch({
      db,
      mailboxHandle,
      waiters,
      reservedTypes: options.reservedTypes
    })
    if (unread.length === 0) {
      return
    }
    const newestSequence = unread.at(-1)?.sequence
    if (newestSequence === undefined) {
      return
    }
    if (!this.state.releaseSupersededWatermark(mailboxHandle, newestSequence, ptyId)) {
      return
    }
    if (
      this.deps.deliveryTarget.deferForAbsenceProbe(ptyId, options.skipAbsenceProbe, () =>
        this.redeliverAfterProbe(ptyId, mailboxHandle)
      )
    ) {
      return
    }
    stageOrchestrationMailboxPointer({
      deps: this.deps,
      state: this.state,
      terminal,
      mailboxHandle,
      messages: unread,
      heldDeliveryId,
      newestSequence,
      enterDelayMs: pointerEnterDelayMs(),
      settle: (ptyId, flight) => this.settle(ptyId, flight),
      redrive: (redriveMailbox, force) => this.redrive(redriveMailbox, force)
    })
  }

  parkRedelivery(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): void {
    this.state.parkRedelivery(mailboxHandle, reservedTypes)
  }

  retirePty(ptyId: string): void {
    this.coldParkedPtys.delete(ptyId)
    const { flight, releasedMailboxes } = this.state.retirePty(ptyId)
    if (flight?.enterTimer != null) {
      clearTimeout(flight.enterTimer)
    }
    if (flight?.stagedMessageIds.length) {
      const db = this.deps.getDb()
      if (db && flight.processIncarnation) {
        // Release only phases that provably never sent Enter; an attempted Enter may already have landed.
        db.releaseMailboxPointerEnter(
          flight.stagedMessageIds,
          { ptyId, processIncarnation: flight.processIncarnation },
          [MAILBOX_POINTER_RESERVED, MAILBOX_POINTER_WRITE_ATTEMPTED]
        )
      } else {
        db?.markAsUndelivered(flight.stagedMessageIds)
      }
    }
    for (const mailboxHandle of releasedMailboxes) {
      this.redrive(mailboxHandle, true)
    }
  }

  observeAgentWorking(ptyId: string): void {
    try {
      // Staged pointer text is already queued in the composer; working is queue-safe.
      if (this.state.hasFlight(ptyId)) {
        if (this.coldParkedPtys.has(ptyId)) {
          this.state.deferFlightUntilIdle(ptyId)
        }
        return
      }
      this.retirePty(ptyId)
      this.deps.getDb()?.releasePendingMailboxPointerForPty(ptyId)
    } catch {
      // Runtime teardown can close the DB before the final PTY frame is drained.
    }
  }

  observeAgentIdle(ptyId: string): void {
    if (this.coldParkedPtys.has(ptyId)) {
      this.state.deferFlightUntilIdle(ptyId)
    }
    this.state.takeDeferredEnter(ptyId)?.()
  }

  markPtyColdParked(ptyId: string): void {
    this.coldParkedPtys.add(ptyId)
  }

  clearPtyColdParked(ptyId: string): void {
    this.coldParkedPtys.delete(ptyId)
  }

  private redeliverAfterProbe(ptyId: string, mailboxHandle: string): void {
    const current = this.deps.getTerminal(ptyId)
    if (current?.lastAgentStatus === 'idle' && current.lastAgentStatusObservedLive) {
      this.deliver(current, { mailboxHandle, skipAbsenceProbe: true })
    }
  }

  private settle(ptyId: string, flight: OrchestrationMailboxDeliveryFlight): void {
    const parked = this.state.settleFlight(ptyId, flight)
    if (!parked) {
      return
    }
    const current = this.deps.getTerminal(ptyId)
    for (const [mailboxHandle, reservedTypes] of parked) {
      if (!current || this.deps.mailboxOwner.resolve(current, mailboxHandle) !== mailboxHandle) {
        this.parkRedelivery(mailboxHandle, reservedTypes)
        this.redrive(mailboxHandle)
      } else {
        this.deliver(current, { mailboxHandle, reservedTypes })
      }
    }
  }

  private redrive(mailboxHandle: string, force = false): void {
    const parkedTypes = this.state.takeRedelivery(mailboxHandle, force)
    if (parkedTypes === undefined) {
      return
    }
    queueMicrotask(() => {
      try {
        this.deps.redriveMailbox(mailboxHandle, parkedTypes ?? undefined)
      } catch {
        // Durable mail remains available to explicit check or a later idle edge.
      }
    })
  }
}
