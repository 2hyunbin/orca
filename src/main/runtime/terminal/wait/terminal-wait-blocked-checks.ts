import {
  WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS,
  WAIT_BLOCKED_KEYWORD_CARRY_CHARS,
  WAIT_BLOCKED_KEYWORD_PATTERN
} from '../../orca-runtime-postlude'
import {
  appendWaitBlockedCarry,
  createWaitBlockedCheckState,
  readWaitBlockedCarry,
  resetWaitBlockedCarry,
  type WaitBlockedCheckState
} from '../../wait-blocked-check-state'
import {
  computeTerminalTailWaitState,
  tailGainedNewerBlockedReason
} from '../../terminal-wait-tail-state'
import { ownRetainedString } from '../../../../shared/own-retained-string'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

type TerminalWaitBlockedCheckHost = {
  getPty(ptyId: string): RuntimePtyWorktreeRecord | undefined
  recordAgentPromptPermissionObservation(ptyId: string): void
}

export class TerminalWaitBlockedChecks {
  private readonly waitBlockedCheckStateByPtyId = new Map<string, WaitBlockedCheckState>()

  constructor(private readonly host: TerminalWaitBlockedCheckHost) {}

  scheduleWaitBlockedCheck(ptyId: string, appendedText: string, at: number): void {
    let state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (!state) {
      state = createWaitBlockedCheckState()
      this.waitBlockedCheckStateByPtyId.set(ptyId, state)
    }
    // Why lowercase the joined window and not the chunk: the carry is already
    // lowercase, so this is one folded copy instead of a discarded per-chunk copy
    // plus the concatenation the pattern flattens anyway.
    const keywordWindow = `${state.keywordCarry}${appendedText}`.toLowerCase()
    const keywordHit = WAIT_BLOCKED_KEYWORD_PATTERN.test(keywordWindow)
    // Why own: this 31-char carry lives per PTY until the next chunk, and un-owned it pins the
    // whole lowercased window — a full copy of the chunk.
    state.keywordCarry = ownRetainedString(keywordWindow.slice(-WAIT_BLOCKED_KEYWORD_CARRY_CHARS))
    appendWaitBlockedCarry(state.appended, appendedText)
    const elapsed = at - state.lastAt
    if (keywordHit || elapsed >= WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS || elapsed < 0) {
      this.runWaitBlockedCheck(ptyId, state, at)
      return
    }
    if (!state.timer) {
      // Why trailing edge: the final chunks of a burst must still be
      // evaluated or a prompt arriving right after a flood would go
      // unstamped until the next output.
      state.timer = setTimeout(() => {
        state.timer = null
        this.runWaitBlockedCheck(ptyId, state, Date.now())
      }, WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS - elapsed)
    }
  }

  private runWaitBlockedCheck(ptyId: string, state: WaitBlockedCheckState, at: number): void {
    const pty = this.host.getPty(ptyId)
    if (!pty) {
      resetWaitBlockedCarry(state.appended)
      return
    }
    const nextWaitState = computeTerminalTailWaitState(
      pty.tailBuffer,
      pty.tailPartialLine,
      pty.preview
    )
    const previousWaitState = state.lastWaitState ?? {
      waitText: '',
      signal: null,
      fromTail: false
    }
    if (
      tailGainedNewerBlockedReason(
        previousWaitState,
        nextWaitState,
        readWaitBlockedCarry(state.appended)
      )
    ) {
      pty.waitBlockedAt = at
      this.host.recordAgentPromptPermissionObservation(ptyId)
    }
    state.lastAt = at
    state.lastWaitState = nextWaitState
    resetWaitBlockedCarry(state.appended)
  }

  // Why: the scanner's first run after a restore seed compares against a null
  // baseline, so a permission prompt visible only in seeded HISTORY would read
  // as newly gained and stamp waitBlockedAt "now" on the next benign chunk.
  // Store the seeded tail's wait state as the baseline WITHOUT stamping; only
  // a signal that appears in genuinely new output counts as gained.
  primeWaitBlockedBaselineFromSeededTail(ptyId: string): void {
    const pty = this.host.getPty(ptyId)
    if (!pty) {
      return
    }
    let state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (!state) {
      state = createWaitBlockedCheckState()
      this.waitBlockedCheckStateByPtyId.set(ptyId, state)
    }
    if (state.lastWaitState === null) {
      state.lastWaitState = computeTerminalTailWaitState(
        pty.tailBuffer,
        pty.tailPartialLine,
        pty.preview
      )
    }
  }

  clearWaitBlockedCheckState(ptyId: string): void {
    const state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (state?.timer) {
      clearTimeout(state.timer)
    }
    this.waitBlockedCheckStateByPtyId.delete(ptyId)
  }
}
