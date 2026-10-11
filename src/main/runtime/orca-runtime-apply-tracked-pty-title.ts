import { OrcaRuntimeWithGetUnpersistedTrackedTitleForPty } from './orca-runtime-get-unpersisted-tracked-title-for-pty'
import type { TerminalTitleFactMeta } from '../../shared/terminal-output-side-effects'

import type { ClaudeTerminalEvidence } from '../../shared/claude-terminal-interrupt'

export abstract class OrcaRuntimeWithApplyTrackedPtyTitle extends OrcaRuntimeWithGetUnpersistedTrackedTitleForPty {
  observeClaudeTerminalEvidence(ptyId: string, evidence: ClaudeTerminalEvidence): void {
    return this.terminalOutput.observeClaudeTerminalEvidence(ptyId, evidence)
  }

  /** Apply one observed OSC title (raw form) to the PTY and leaf records.
   *  Returns true when what the PTY shows changed: its record, or its display-only clear. */
  protected applyTrackedPtyTitle(
    ptyId: string,
    rawTitle: string,
    normalizedTitle: string,
    meta?: TerminalTitleFactMeta
  ): boolean {
    return this.terminalOutput.applyTrackedPtyTitle(ptyId, rawTitle, normalizedTitle, meta)
  }

  /**
   * The stale-working timer's clear: it only guesses that the agent may have exited behind a
   * working title. Of what a genuine title does, it skips the title/status evidence that
   * readiness and delivery read (records, waiters, mailbox, delivery), and still re-derives the
   * process evidence that guess is about: the foreground agent and the exit/completion check.
   * Display takes the cleared title from `titleDisplayClear`; the caller publishes it.
   */

  /** Cancel the per-PTY title tracker (stale-title timer included) on PTY
   *  teardown so it cannot fire into pruned records. */
  protected disposePtyTitleTracker(ptyId: string): void {
    return this.terminalOutput.disposePtyTitleTracker(ptyId)
  }

  protected resetTrackedTerminalStateForProviderGeneration(ptyId: string): void {
    return this.terminalOutput.resetTrackedTerminalStateForProviderGeneration(ptyId)
  }

  protected setTerminalSideEffectConsumerAvailable(available: boolean): void {
    return this.terminalOutput.setTerminalSideEffectConsumerAvailable(available)
  }

  protected refreshTerminalSideEffectConsumerAvailability(): void {
    return this.terminalOutput.refreshTerminalSideEffectConsumerAvailability()
  }
}
