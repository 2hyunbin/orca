// What main does with a split pane whose terminal ended, in a layout-owner build: the rule the
// window applied to the panes it mounted, now decided where the exit is seen, window or none.

import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { TerminalRunFactsRegister } from '../../terminal-run-facts'

export type ExitedSplitPaneFacts = {
  exitCode: number
  /** This main started the process for its pane, rather than reattaching or adopting it. */
  freshSpawn: boolean
  inputSeen: boolean
  outputSeen: boolean
  /** A client's view of the pane was showing when it ended. */
  shown: boolean
}

/**
 * 'close' takes the pane out of its tab. 'keep' leaves it: an exit no host confirmed, a failed
 * process (its "Terminal exited" card stays), or a newborn split that died while shown before
 * anyone used it, so the failure stays visible.
 */
export function exitedSplitPaneOutcome(facts: ExitedSplitPaneFacts): 'close' | 'keep' {
  // A negative code is an unconfirmed stop; a positive one a failed process.
  if (facts.exitCode !== 0) {
    return 'keep'
  }
  const newbornShown = facts.freshSpawn && facts.shown && !facts.inputSeen && !facts.outputSeen
  return newbornShown ? 'keep' : 'close'
}

/** What main knows about the run that ended, read before its records are cleared. */
export function exitedSplitPaneFacts(
  runs: Pick<TerminalRunFactsRegister, 'read' | 'readLastInputAt'>,
  pty: Pick<RuntimePtyWorktreeRecord, 'incarnationId' | 'lastOutputAt'> | undefined,
  ptyId: string,
  exitCode: number,
  options: { viewShown?: boolean }
): ExitedSplitPaneFacts {
  const run = runs.read(ptyId, pty?.incarnationId)
  return {
    exitCode,
    freshSpawn: run.freshSpawn,
    inputSeen: run.firstUserInputAt !== null || runs.readLastInputAt(ptyId) !== null,
    outputSeen: pty?.lastOutputAt != null,
    shown: options.viewShown === true
  }
}
