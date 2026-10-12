import { OrcaRuntimeWithControllerKnowsPtyIsLive } from '../../orca-runtime-controller-knows-pty-is-live'
import type { OrcaRuntimeWithSerializeAgentPromptSubmission } from '../../orca-runtime-serialize-agent-prompt-submission'
import type { OrcaRuntimeWithResolveExitWaiters } from '../../orca-runtime-resolve-exit-waiters'
import type { OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness } from '../../orca-runtime-refresh-floating-workspace-pty-liveness'
import type { OrcaRuntimeWithGetPtyRecordForPaneKey } from '../../orca-runtime-get-pty-record-for-pane-key'
import { recognizeAgentProcess } from '../../../../shared/agent-process-recognition'

export abstract class RuntimeTerminalAgentExitConfirmation extends OrcaRuntimeWithControllerKnowsPtyIsLive {
  protected abstract resolvePtyTuiIdleWaiters(
    ...args: Parameters<OrcaRuntimeWithResolveExitWaiters['resolvePtyTuiIdleWaiters']>
  ): ReturnType<OrcaRuntimeWithResolveExitWaiters['resolvePtyTuiIdleWaiters']>

  protected abstract getLeavesForPty(
    ...args: Parameters<OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness['getLeavesForPty']>
  ): ReturnType<OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness['getLeavesForPty']>

  protected abstract resolveTuiIdleWaiters(
    ...args: Parameters<OrcaRuntimeWithResolveExitWaiters['resolveTuiIdleWaiters']>
  ): ReturnType<OrcaRuntimeWithResolveExitWaiters['resolveTuiIdleWaiters']>

  protected abstract checkDeliverySettledAndArmRecheck(
    ...args: Parameters<OrcaRuntimeWithResolveExitWaiters['checkDeliverySettledAndArmRecheck']>
  ): ReturnType<OrcaRuntimeWithResolveExitWaiters['checkDeliverySettledAndArmRecheck']>

  protected abstract deliverPendingMessagesForLeaf(
    ...args: Parameters<OrcaRuntimeWithGetPtyRecordForPaneKey['deliverPendingMessagesForLeaf']>
  ): ReturnType<OrcaRuntimeWithGetPtyRecordForPaneKey['deliverPendingMessagesForLeaf']>
  protected abstract getFreshExplicitAgentStatusForPty(
    ...args: Parameters<
      OrcaRuntimeWithSerializeAgentPromptSubmission['getFreshExplicitAgentStatusForPty']
    >
  ): ReturnType<OrcaRuntimeWithSerializeAgentPromptSubmission['getFreshExplicitAgentStatusForPty']>

  protected abstract readPtyForegroundProcessFromController(
    ...args: Parameters<
      OrcaRuntimeWithSerializeAgentPromptSubmission['readPtyForegroundProcessFromController']
    >
  ): ReturnType<
    OrcaRuntimeWithSerializeAgentPromptSubmission['readPtyForegroundProcessFromController']
  >

  protected async recheckHookAgentPresenceForPty(
    ptyId: string
  ): Promise<'live' | 'unverifiable' | 'exited' | null> {
    if (!this.checkHookAgentPresenceFn) {
      return null
    }
    const verdicts = await Promise.all(
      Array.from(this.collectAgentStatusPaneKeysForPty(ptyId), (paneKey) =>
        // SAFETY: Preserve the original late call and its failure if the callback becomes null.
        this.checkHookAgentPresenceFn!(paneKey)
      )
    )
    if (verdicts.includes('live')) {
      return 'live'
    }
    if (verdicts.includes('unverifiable')) {
      return 'unverifiable'
    }
    return verdicts.includes('exited') ? 'exited' : null
  }

  protected confirmPtyAgentExit(ptyId: string, recoverCompletedHook = false): void {
    const current = this.ptysById.get(ptyId)
    const incarnation = current?.incarnationId
    void this.recheckHookAgentPresenceForPty(ptyId).then((verdict) => {
      if (this.ptysById.get(ptyId) !== current || current?.incarnationId !== incarnation) {
        return
      }
      // Why: without an identified owner (null) the foreground read keeps today's rules; with one
      // whose process cannot be checked right now, silence from that read is never an exit.
      if (verdict === null || verdict === 'unverifiable') {
        this.confirmLegacyPtyAgentExit(ptyId, recoverCompletedHook, verdict === 'unverifiable')
      } else if (verdict === 'exited' && !recoverCompletedHook) {
        this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited' })
      } else if (verdict === 'live') {
        this.restoreDisprovedAgentExit(ptyId)
      } else {
        this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.restoreLastAgentExit()
      }
    })
  }

  private restoreDisprovedAgentExit(ptyId: string, confirmedStatus?: 'idle'): void {
    const current = this.ptysById.get(ptyId)
    const restoredStatus = this.ptyTitleTrackersByPtyId
      .get(ptyId)
      ?.tracker.restoreLastAgentExit(confirmedStatus)
    if (!current || restoredStatus === null || restoredStatus === undefined) {
      return
    }
    current.lastAgentStatus = restoredStatus
    if (restoredStatus === 'idle') {
      this.resolvePtyTuiIdleWaiters(current, ptyId)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      // Why the clear too: a stale-working clear leaves the native status, not the neutral one.
      if (leaf.lastAgentStatus !== null && !current.titleDisplayClear) {
        continue
      }
      // Why: the live agent disproved the neutral title's exit signal; keep runtime delivery state aligned with the restored tracker.
      leaf.lastAgentStatus = restoredStatus
      if (restoredStatus === 'idle') {
        this.resolveTuiIdleWaiters(leaf)
        // Why gated like every other delivery edge: a neutral-title restoration can
        // reinstate `idle` from a name-only title, which is not evidence a turn ended.
        if (this.checkDeliverySettledAndArmRecheck(leaf)) {
          this.deliverPendingMessagesForLeaf(leaf)
        }
      }
    }
  }

  private confirmLegacyPtyAgentExit(
    ptyId: string,
    recoverCompletedHook: boolean,
    keepOnSilence: boolean
  ): void {
    const pty = this.ptysById.get(ptyId)
    const handle = this.handleByPtyId.get(ptyId)
    if (
      recoverCompletedHook &&
      (!handle || this.getFreshExplicitAgentStatusForPty(handle, ptyId)?.status !== 'idle')
    ) {
      return
    }
    const incarnationId = pty?.incarnationId
    const generation = recoverCompletedHook ? this.getPtyLifecycleGeneration(ptyId) : null
    const titleObservedAt = pty?.lastOscTitleAt ?? null
    const foregroundRead = this.readPtyForegroundProcessFromController(ptyId, titleObservedAt ?? 0)
    if (!pty?.connected || !foregroundRead) {
      if (keepOnSilence) {
        this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.restoreLastAgentExit()
      } else if (!recoverCompletedHook) {
        this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited' })
      }
      return
    }
    void foregroundRead.then((result) => {
      const current = this.ptysById.get(ptyId)
      if (
        current !== pty ||
        !current.connected ||
        current.incarnationId !== incarnationId ||
        (recoverCompletedHook && this.getPtyLifecycleGeneration(ptyId) !== generation)
      ) {
        return
      }
      if (current.lastOscTitleAt !== titleObservedAt && current.lastAgentStatus !== null) {
        return
      }
      // SAFETY: The original recovery guard proved this immutable handle exists.
      if (
        recoverCompletedHook &&
        (!current.lastAgentStatusObservedLive ||
          this.getFreshExplicitAgentStatusForPty(handle!, ptyId)?.status !== 'idle')
      ) {
        return
      }
      if (recoverCompletedHook && current.lastOscTitleAt !== titleObservedAt) {
        this.confirmPtyAgentExit(ptyId, true)
        return
      }
      if (
        result.controller === this.ptyController &&
        result.available &&
        recognizeAgentProcess(result.process) !== null
      ) {
        // Codex's final native spinner can arrive after its done hook, then clear to the cwd.
        const confirmedStatus =
          recoverCompletedHook && recognizeAgentProcess(result.process)?.agent === 'codex'
            ? 'idle'
            : undefined
        this.restoreDisprovedAgentExit(ptyId, confirmedStatus)
        return
      }
      const answered =
        result.controller === this.ptyController &&
        result.available &&
        typeof result.process === 'string'
      if (!keepOnSilence || answered) {
        if (!recoverCompletedHook) {
          this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited' })
        }
      } else {
        this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.restoreLastAgentExit()
      }
    })
  }
}
