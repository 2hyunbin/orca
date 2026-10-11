// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { TerminalWaitSettlements } from './terminal/wait/terminal-wait-settlements'
import { TerminalDeliveryReadiness } from './terminal/input/terminal-delivery-readiness'
import { OrcaRuntimeWithBindPtyIncarnationHandle } from './orca-runtime-bind-pty-incarnation-handle'

export class OrcaRuntimeWithResolveExitWaiters extends OrcaRuntimeWithBindPtyIncarnationHandle {
  private readonly waitSettlements = new TerminalWaitSettlements(
    {
      issueHandle: (leaf) => this.issueHandle(leaf),
      getLeafKey: (tabId, leafId) => this.getLeafKey(tabId, leafId),
      getLeafHandle: (key) => this.handleByLeafKey.get(key),
      getPtyHandle: (id) => this.handleByPtyId.get(id),
      getPtyIncarnationHandle: (id) => this.handleByPtyIncarnation.get(id)?.handle,
      getLeaves: () => this.leaves.values(),
      getTabTitle: (id) => this.tabs.get(id)?.title
    },
    this.terminalWaiters,
    this.tuiIdleEvidenceSource
  )

  protected resolveExitWaiters(...args: Parameters<TerminalWaitSettlements['resolveExitWaiters']>) {
    return this.waitSettlements.resolveExitWaiters(...args)
  }

  protected resolveTuiIdleWaiters(
    ...args: Parameters<TerminalWaitSettlements['resolveTuiIdleWaiters']>
  ) {
    return this.waitSettlements.resolveTuiIdleWaiters(...args)
  }

  protected resolvePtyExitWaiters(
    ...args: Parameters<TerminalWaitSettlements['resolvePtyExitWaiters']>
  ) {
    return this.waitSettlements.resolvePtyExitWaiters(...args)
  }

  protected resolvePtyTuiIdleWaiters(
    ...args: Parameters<TerminalWaitSettlements['resolvePtyTuiIdleWaiters']>
  ) {
    return this.waitSettlements.resolvePtyTuiIdleWaiters(...args)
  }

  protected evaluateTuiIdleForLeaf(
    ...args: Parameters<TerminalWaitSettlements['evaluateTuiIdleForLeaf']>
  ) {
    return this.waitSettlements.evaluateTuiIdleForLeaf(...args)
  }

  protected evaluateTuiIdleForPty(
    ...args: Parameters<TerminalWaitSettlements['evaluateTuiIdleForPty']>
  ) {
    return this.waitSettlements.evaluateTuiIdleForPty(...args)
  }

  protected getAdoptedPtyExplicitIdleStatus(
    ...args: Parameters<TerminalWaitSettlements['getAdoptedPtyExplicitIdleStatus']>
  ) {
    return this.waitSettlements.getAdoptedPtyExplicitIdleStatus(...args)
  }

  protected getAdoptedPtyTitle(...args: Parameters<TerminalWaitSettlements['getAdoptedPtyTitle']>) {
    return this.waitSettlements.getAdoptedPtyTitle(...args)
  }

  private readonly deliveryReadiness = new TerminalDeliveryReadiness(
    {
      getLeafKey: (tabId, leafId) => this.getLeafKey(tabId, leafId),
      getLeaf: (key) => this.leaves.get(key),
      deliverPendingMessagesForLeaf: (leaf) => this.deliverPendingMessagesForLeaf(leaf)
    },
    this.tuiIdleEvidenceSource
  )

  protected checkDeliverySettledAndArmRecheck(
    ...args: Parameters<TerminalDeliveryReadiness['checkDeliverySettledAndArmRecheck']>
  ) {
    return this.deliveryReadiness.checkDeliverySettledAndArmRecheck(...args)
  }

  protected clearDeliveryRecheck(
    ...args: Parameters<TerminalDeliveryReadiness['clearDeliveryRecheck']>
  ) {
    return this.deliveryReadiness.clearDeliveryRecheck(...args)
  }

  protected isAgentSettledForDelivery(
    ...args: Parameters<TerminalDeliveryReadiness['isAgentSettledForDelivery']>
  ) {
    return this.deliveryReadiness.isAgentSettledForDelivery(...args)
  }

  protected settlePendingMessageDelivery(
    ptyId: string,
    flight: { enterTimer: ReturnType<typeof setTimeout> | null }
  ): void {
    if (this.messageDeliveryFlightsByPtyId.get(ptyId) !== flight) {
      return
    }
    this.messageDeliveryFlightsByPtyId.delete(ptyId)
    const parked = this.parkedMessageRedeliveriesByPtyId.get(ptyId)
    if (!parked) {
      return
    }
    this.parkedMessageRedeliveriesByPtyId.delete(ptyId)
    for (const [mailboxHandle, delivery] of parked) {
      this.deliverPendingMessages(delivery.leaf, {
        mailboxHandle,
        reservedTypes: delivery.reservedTypes
      })
    }
  }
}
