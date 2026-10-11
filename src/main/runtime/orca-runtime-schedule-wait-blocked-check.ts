// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { TerminalWaitBlockedChecks } from './terminal/wait/terminal-wait-blocked-checks'
import { OrcaRuntimeWithOnPtyData } from './orca-runtime-on-pty-data'
import {
  type ProcessedAgentStatusChunk,
  createAgentStatusOscProcessor
} from '../../shared/agent-status-osc'
import type { RuntimePtyTitleTrackerEntry } from './runtime-terminal-state-records'

export class OrcaRuntimeWithScheduleWaitBlockedCheck extends OrcaRuntimeWithOnPtyData {
  private readonly waitBlockedChecks = new TerminalWaitBlockedChecks({
    getPty: (id) => this.ptysById.get(id),
    recordAgentPromptPermissionObservation: (id) => this.recordAgentPromptPermissionObservation(id)
  })

  protected scheduleWaitBlockedCheck(
    ...args: Parameters<TerminalWaitBlockedChecks['scheduleWaitBlockedCheck']>
  ) {
    return this.waitBlockedChecks.scheduleWaitBlockedCheck(...args)
  }

  protected primeWaitBlockedBaselineFromSeededTail(
    ...args: Parameters<TerminalWaitBlockedChecks['primeWaitBlockedBaselineFromSeededTail']>
  ) {
    return this.waitBlockedChecks.primeWaitBlockedBaselineFromSeededTail(...args)
  }

  protected clearWaitBlockedCheckState(
    ...args: Parameters<TerminalWaitBlockedChecks['clearWaitBlockedCheckState']>
  ) {
    return this.waitBlockedChecks.clearWaitBlockedCheckState(...args)
  }

  protected processAgentStatusOscForPty(ptyId: string, data: string): ProcessedAgentStatusChunk {
    let processor = this.agentStatusOscProcessorsByPtyId.get(ptyId)
    if (!processor) {
      processor = createAgentStatusOscProcessor()
      this.agentStatusOscProcessorsByPtyId.set(ptyId, processor)
    }
    return processor(data)
  }

  /** Emit the facts batched while applying one chunk/frame as a single
   *  pty:sideEffect batch, preserving byte order. */
  protected flushPendingTerminalSideEffectFacts(
    ptyId: string,
    entry: RuntimePtyTitleTrackerEntry
  ): void {
    if (entry.pendingFacts.length > 0) {
      const facts = entry.pendingFacts
      entry.pendingFacts = []
      this.emitTerminalSideEffectBatch(ptyId, facts)
    }
    const afterFacts = entry.afterFacts
    entry.afterFacts = []
    for (const run of afterFacts) {
      run()
    }
  }

  /** Runs `run` after the chunk being applied has emitted its facts, or now between chunks. */
  protected runAfterPendingTerminalSideEffectFacts(ptyId: string, run: () => void): void {
    const entry = this.ptyTitleTrackersByPtyId.get(ptyId)
    if (entry?.applyingChunk) {
      entry.afterFacts.push(run)
      return
    }
    run()
  }

  /** Feed a main-fabricated OSC title/BEL frame (agent hook spinners) through
   *  the per-PTY tracker — NOT onPtyData, so emulator state, tails,
   *  transcripts, and stats never see synthetic bytes. Parsed via the
   *  tracker's stateless synthetic path: the shared chunk bell detector must
   *  never observe fabricated bytes, or a tick interleaved with a split real
   *  OSC corrupts its escape state (phantom/swallowed bells). While the
   *  side-effect kill switch is off the legacy pty:data copy still drives
   *  renderer parsers; this ingest keeps main's facts and records
   *  authoritative. */
  ingestSyntheticTitleFrame(ptyId: string, data: string): void {
    const entry = this.getOrCreatePtyTitleTrackerEntry(ptyId)
    entry.applyingChunk = true
    entry.chunkTouchedSessionTabs = false
    try {
      entry.tracker.applySyntheticTitleFrame(data)
    } finally {
      entry.applyingChunk = false
      this.flushPendingTerminalSideEffectFacts(ptyId, entry)
    }
    if (entry.chunkTouchedSessionTabs) {
      this.touchMobileSessionSnapshotsForPty(ptyId)
    }
  }

  /** Scan-authority handoff for a backgrounded PTY (daemon keep-tail
   *  thinning): while delegated, the daemon relays bell/133/pr-link/2031
   *  facts itself and the delivered bytes may be gapped — feeding them to
   *  main's transient scanners would mint phantom or duplicate facts. Title
   *  processing stays main-side either way. */
  setPtyTransientFactDelegation(
    ptyId: string,
    delegated: boolean,
    scanSeedAnsi?: string,
    mode2031PendingSubscribe?: true
  ): void {
    const entry = this.getOrCreatePtyTitleTrackerEntry(ptyId)
    entry.tracker.setTransientFactScanningSuppressed(delegated)
    if (!delegated && scanSeedAnsi) {
      // Prime the freshly reset scanner carry with the emulator's dangling
      // incomplete escape at the handoff position — a sequence split across
      // the un-background toggle must not mint a phantom bell or lose its
      // fact. titleScanData:'' keeps titles out (they were never suppressed).
      entry.tracker.handleChunk(scanSeedAnsi, {
        titleScanData: '',
        mode2031PendingSubscribe
      })
    }
  }
}
