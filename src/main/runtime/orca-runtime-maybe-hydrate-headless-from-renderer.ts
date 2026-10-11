import { OrcaRuntimeWithSerializeMainTerminalBuffer } from './orca-runtime-serialize-main-terminal-buffer'

export class OrcaRuntimeWithMaybeHydrateHeadlessFromRenderer extends OrcaRuntimeWithSerializeMainTerminalBuffer {
  // Why: hydrate the runtime headless emulator from the desktop renderer's
  // xterm buffer on the first onPtyData byte after a PTY is taken over by a
  // pane. Eager-state pattern matches seedHeadlessTerminal: headlessTerminals
  // is populated synchronously so concurrent live writes from
  // trackHeadlessTerminalData chain after the seed via the same writeChain.
  // See docs/mobile-prefer-renderer-scrollback.md.
  // Public: a phone subscribe calls it after the fit; the promise resolves true once seeded.
  maybeHydrateHeadlessFromRenderer(ptyId: string): Promise<boolean> | null {
    return this.terminalOutput.maybeHydrateHeadlessFromRenderer(ptyId)
  }

  // Why: seed-derived agent status reflects historical state. Orchestration
  // waiters (resolveTuiIdleWaiters, deliverPendingMessages) must only react
  // to LIVE transitions, so this helper writes leaf.lastAgentStatus only,
  // leaves lastAgentStatusObservedLive untouched, and never resolves waiters.
  // detectAgentStatusFromTitle wrap mirrors the live path so seeded and live
  // values are the same union member, keeping downstream `=== 'idle'` checks
  // correct.
  protected applySeededAgentStatus(ptyId: string, title: string): void {
    return this.terminalOutput.applySeededAgentStatus(ptyId, title)
  }

  /** Per-chunk reply-ownership capture (Phase 5). Evaluated synchronously at
   *  ingestion only — never re-read at reply time. */
  protected shouldAnswerQueriesForLiveChunk(ptyId: string): boolean {
    return this.terminalOutput.shouldAnswerQueriesForLiveChunk(ptyId)
  }

  protected trackHeadlessTerminalData(
    ptyId: string,
    data: string,
    outputSequence: number,
    forwardQueryReplies = false
  ): void {
    return this.terminalOutput.trackHeadlessTerminalData(
      ptyId,
      data,
      outputSequence,
      forwardQueryReplies
    )
  }
}
