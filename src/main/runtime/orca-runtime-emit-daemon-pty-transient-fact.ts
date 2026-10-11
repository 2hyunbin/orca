import { OrcaRuntimeWithScheduleWaitBlockedCheck } from './orca-runtime-schedule-wait-blocked-check'
import type { PtyTransientFact } from '../providers/types'
import type {
  TerminalSideEffectBatch,
  TerminalSideEffectFact
} from '../../shared/terminal-side-effect-facts'

import type { TitleDisplayClear } from './runtime-worktree-status-projection'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalTitleFactMeta } from '../../shared/terminal-output-side-effects'

export abstract class OrcaRuntimeWithEmitDaemonPtyTransientFact extends OrcaRuntimeWithScheduleWaitBlockedCheck {
  /** A transient fact the daemon detected while it held scan authority —
   *  emitted through the same fact channel as byte-scanned facts. Arrives
   *  between chunks, so recordTerminalSideEffectFact emits it immediately. */
  emitDaemonPtyTransientFact(ptyId: string, fact: PtyTransientFact): void {
    return this.terminalOutput.emitDaemonPtyTransientFact(ptyId, fact)
  }

  /** The daemon keep-tail dropped this PTY's oldest undelivered output; the
   *  next delivered chunk is discontinuous. Reset every cross-chunk parse
   *  carry so a half-open escape from before the gap cannot corrupt what
   *  follows, and drop the mobile headless mirror — it rebuilds from the
   *  delivered tail / snapshot seeds instead of parsing a gapped stream. */
  notePtyDataGap(ptyId: string, droppedChars = 0): void {
    return this.terminalOutput.notePtyDataGap(ptyId, droppedChars)
  }

  /** Record one derived side-effect fact: batched per chunk while applying
   *  bytes, emitted immediately for between-chunk facts (stale-title timer). */
  protected recordTerminalSideEffectFact(ptyId: string, fact: TerminalSideEffectFact): void {
    return this.terminalOutput.recordTerminalSideEffectFact(ptyId, fact)
  }

  protected emitTerminalSideEffectBatch(
    ptyId: string,
    facts: TerminalSideEffectFact[],
    options: { replay?: boolean } = {}
  ): void {
    return this.terminalOutput.emitTerminalSideEffectBatch(ptyId, facts, options)
  }

  /** Same attribution resolution as emitTerminalAgentStatusEvents: prefer the
   *  first mounted leaf, fall back to the spawn-time PTY record binding. */
  protected resolveTerminalSideEffectAttribution(ptyId: string): {
    worktreeId?: string
    tabId?: string
    paneKey?: string
    connectionId?: string | null
  } {
    return this.terminalOutput.resolveTerminalSideEffectAttribution(ptyId)
  }

  /** Title-only replay batch for renderer (re)attach — the no-attention-replay
   *  rule: snapshots restore title state, never historical bells/completions. */
  getTerminalSideEffectSnapshot(ptyId: string): TerminalSideEffectBatch | null {
    return this.terminalOutput.getTerminalSideEffectSnapshot(ptyId)
  }

  /** Raw last title from main's tracked PTY/leaf records — the title surface
   *  the tracker (live bytes + synthetic frames) keeps current. */
  protected getTrackedRawTitleForPty(ptyId: string): string | null {
    return this.terminalOutput.getTrackedRawTitleForPty(ptyId)
  }

  protected isLiveCursorNativeTitle(rawTitle: string, meta?: TerminalTitleFactMeta): boolean {
    return this.terminalOutput.isLiveCursorNativeTitle(rawTitle, meta)
  }

  /** Display fallback for identities intentionally omitted from liveness records. */
  protected getTrackedDisplayTitleForPty(ptyId: string): string | null {
    return this.terminalOutput.getTrackedDisplayTitleForPty(ptyId)
  }

  /** The stale-working timer's display-only clear of this PTY's native title, while it stands. */
  protected getPtyTitleDisplayClear(ptyId: string | null | undefined): TitleDisplayClear | null {
    return this.terminalOutput.getPtyTitleDisplayClear(ptyId)
  }

  protected getPtyDisplayRecord(pty: RuntimePtyWorktreeRecord): RuntimePtyWorktreeRecord {
    return this.terminalOutput.getPtyDisplayRecord(pty)
  }

  protected getLeafDisplayRecord(leaf: RuntimeLeafRecord): RuntimeLeafRecord {
    return this.terminalOutput.getLeafDisplayRecord(leaf)
  }
}
