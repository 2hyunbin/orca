import { TerminalWaitBlockedChecks } from './terminal/wait/terminal-wait-blocked-checks'
import { OrcaRuntimeWithOnPtyData } from './orca-runtime-on-pty-data'
import type { ProcessedAgentStatusChunk } from '../../shared/agent-status-osc'
import type { RuntimePtyTitleTrackerEntry } from './runtime-terminal-state-records'

export abstract class OrcaRuntimeWithScheduleWaitBlockedCheck extends OrcaRuntimeWithOnPtyData {
  protected abstract recordAgentPromptPermissionObservation(ptyId: string): void

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
    return this.terminalOutput.processAgentStatusOscForPty(ptyId, data)
  }

  /** Emit the facts batched while applying one chunk/frame as a single
   *  pty:sideEffect batch, preserving byte order. */
  protected flushPendingTerminalSideEffectFacts(
    ptyId: string,
    entry: RuntimePtyTitleTrackerEntry
  ): void {
    return this.terminalOutput.flushPendingTerminalSideEffectFacts(ptyId, entry)
  }

  /** Runs `run` after the chunk being applied has emitted its facts, or now between chunks. */
  protected runAfterPendingTerminalSideEffectFacts(ptyId: string, run: () => void): void {
    return this.terminalOutput.runAfterPendingTerminalSideEffectFacts(ptyId, run)
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
    return this.terminalOutput.ingestSyntheticTitleFrame(ptyId, data)
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
    return this.terminalOutput.setPtyTransientFactDelegation(
      ptyId,
      delegated,
      scanSeedAnsi,
      mode2031PendingSubscribe
    )
  }
}
