import type { RuntimeLeafRecord } from '../../runtime-terminal-state-records'
import { buildTerminalWaitText } from '../../terminal-wait-tail-state'
import { evaluateTuiIdle, isTuiIdleReadyVerdict } from '../../tui-idle-evidence'
import { leafTuiIdleEvidence, type TuiIdleEvidenceSource } from '../../tui-idle-evidence-source'
import { TUI_IDLE_QUIESCENCE_MS } from '../../orca-runtime-postlude'

type TerminalDeliveryReadinessHost = {
  getLeafKey(tabId: string, leafId: string): string
  getLeaf(leafKey: string): RuntimeLeafRecord | undefined
  deliverPendingMessagesForLeaf(leaf: RuntimeLeafRecord): void
}

export class TerminalDeliveryReadiness {
  private readonly deliveryRecheckTimersByLeafKey = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly host: TerminalDeliveryReadinessHost,
    private readonly tuiIdleEvidenceSource: TuiIdleEvidenceSource
  ) {}

  // Delivery has no poll, so a refusal needs a retry after the stream can settle.
  checkDeliverySettledAndArmRecheck(leaf: { tabId: string; leafId: string }): boolean {
    const leafKey = this.host.getLeafKey(leaf.tabId, leaf.leafId)
    if (this.isAgentSettledForDelivery(leaf)) {
      this.clearDeliveryRecheck(leafKey)
      return true
    }
    this.armDeliveryRecheck(leafKey)
    return false
  }

  clearDeliveryRecheck(leafKey: string): void {
    const timer = this.deliveryRecheckTimersByLeafKey.get(leafKey)
    if (timer) {
      clearTimeout(timer)
      this.deliveryRecheckTimersByLeafKey.delete(leafKey)
    }
  }

  private armDeliveryRecheck(leafKey: string): void {
    if (this.deliveryRecheckTimersByLeafKey.has(leafKey)) {
      return
    }
    const live = this.host.getLeaf(leafKey)
    // Why this delay: the only refusal that time alone can lift is tier 3 waiting on the
    // stream to go quiet, so wake just after the window could have elapsed. A pane that is
    // still producing output re-arms from its own fresher timestamp rather than spinning.
    const elapsed = live?.lastOutputAt ? Date.now() - live.lastOutputAt : 0
    const delay = Math.max(TUI_IDLE_QUIESCENCE_MS - elapsed, 0) + 50
    const timer = setTimeout(() => {
      this.deliveryRecheckTimersByLeafKey.delete(leafKey)
      const current = this.host.getLeaf(leafKey)
      if (!current) {
        return
      }
      // Why the gate again here: delivery sites gate at the CALL, not inside
      // deliverPendingMessagesForLeaf, so firing straight into it would hand the retry the
      // very injection the gate exists to prevent. A pane that went busy again re-arms.
      if (this.checkDeliverySettledAndArmRecheck(current)) {
        this.host.deliverPendingMessagesForLeaf(current)
      }
    }, delay)
    timer.unref?.()
    this.deliveryRecheckTimersByLeafKey.set(leafKey, timer)
  }

  // The wait ranking guards input readiness; callers separately prove that the agent is live.
  isAgentSettledForDelivery(leaf: { tabId: string; leafId: string }): boolean {
    const live = this.host.getLeaf(this.host.getLeafKey(leaf.tabId, leaf.leafId))
    if (!live) {
      return false
    }
    const evidence = leafTuiIdleEvidence(this.tuiIdleEvidenceSource, live, () =>
      buildTerminalWaitText(live.tailBuffer, live.tailPartialLine, live.preview)
    )
    // Why no blocked reader: a refusal here re-arms a recheck that a lingering tail prompt
    // would spin, so delivery keeps its own, blocked-blind, reading of the same ranking.
    return isTuiIdleReadyVerdict(
      evaluateTuiIdle({ ...evidence, readTailBlockedReason: () => null })
    )
  }
}
