import { buildAgentTuiClearInputForText } from '../../shared/agent-tui-input-clear'
import type { ConnectorAgent } from '../../shared/external-conversation-link'
import type { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import {
  createLaunchedAgentWriteGuard,
  type LaunchedAgentWriteGuardRuntime
} from '../runtime/launched-agent-write-guard'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { sendAgentTurn } from '../runtime/orchestration/send-agent-turn'
import { refused, type ConnectorRefusal, type Delivery } from './external-conversation-types'

const HOLD_RECHECK_MS = 1000

export type FollowUpTerminal = Pick<
  OrcaRuntimeService,
  | 'getTerminalHandleForPaneKey'
  | 'getTerminalPtyIdForHandle'
  | 'isAgentPromptBlocked'
  | 'subscribeToPtyExit'
  | 'sendTerminal'
  | 'sendTerminalAgentPrompt'
> &
  LaunchedAgentWriteGuardRuntime & { agentTransitions: Pick<AgentTransitionDetector, 'subscribe'> }

/** A linked pane as bound now; a later PTY in the same pane is a different binding. */
export type BoundPane = { paneKey: string; handle: string; ptyId: string }

/** Per-pane input state the seam keeps: the in-flight claim and the stale-line mark. */
export type PaneInputState = {
  claims: Set<string>
  stale: Map<string, { ptyId: string; text: string }>
}

export function bindPane(terminal: FollowUpTerminal, paneKey: string): BoundPane | null {
  const handle = terminal.getTerminalHandleForPaneKey(paneKey)
  const ptyId = handle ? terminal.getTerminalPtyIdForHandle(handle) : null
  return handle && ptyId ? { paneKey, handle, ptyId } : null
}

/**
 * Holds while the agent asks for permission, on the writer's own refusal predicate, and resolves
 * once it does not. No timeout: only exit, a new binding or the seam's signal end a hold. A lost
 * SSH relay is none of those, so the hold survives it.
 */
export function waitWhileAgentAsks(
  terminal: FollowUpTerminal,
  pane: BoundPane,
  signal: AbortSignal
): Promise<'ready' | ConnectorRefusal> {
  return new Promise((resolve) => {
    const releases: (() => void)[] = []
    let done = false
    const finish = (result: 'ready' | ConnectorRefusal): void => {
      if (!done) {
        done = true
        releases.forEach((release) => release())
        resolve(result)
      }
    }
    const own = (release: () => void): void => {
      if (done) {
        release()
      } else {
        releases.push(release)
      }
    }
    const check = (): void => {
      if (signal.aborted) {
        finish('connectors_disabled')
      } else if (terminal.getTerminalPtyIdForHandle(pane.handle) !== pane.ptyId) {
        finish('agent_not_reachable')
      } else if (!terminal.isAgentPromptBlocked(pane.handle)) {
        finish('ready')
      }
    }
    // Subscribed before the first check, so an answer landing between them is not missed.
    own(
      terminal.agentTransitions.subscribe((change) => {
        if (change.paneKey === pane.paneKey) {
          check()
        }
      })
    )
    own(terminal.subscribeToPtyExit(pane.ptyId, () => finish('agent_not_reachable')))
    const onAbort = (): void => finish('connectors_disabled')
    signal.addEventListener('abort', onAbort)
    own(() => signal.removeEventListener('abort', onAbort))
    check()
    if (!done) {
      // A native permission prompt reports no hook row, so the detector alone may never wake us.
      const timer = setInterval(check, HOLD_RECHECK_MS)
      own(() => clearInterval(timer))
    }
  })
}

/**
 * One follow-up into a bound pane, under its claim. The writer's boolean writes cannot prove a
 * failure happened before the paste, so any throw is `unknown` and marks the line stale; the next
 * follow-up clears it first and pastes only after that clear is accepted.
 */
export async function deliverFollowUp(
  terminal: FollowUpTerminal,
  state: PaneInputState,
  followUp: {
    pane: BoundPane
    agent: ConnectorAgent
    text: string
    requestId: string
    signal: AbortSignal
  }
): Promise<Delivery> {
  const { pane, signal } = followUp
  if (state.claims.has(pane.paneKey)) {
    return refused('busy')
  }
  state.claims.add(pane.paneKey)
  const guard = createLaunchedAgentWriteGuard(terminal, followUp.agent, {
    unprovableHost: 'write-unless-shell'
  })
  // Counts checks that let a write proceed; zero means an abort stopped it before any byte.
  let passes = 0
  const beforeWrite = async (ptyId: string): Promise<void> => {
    await guard.beforeWrite(ptyId)
    if (!signal.aborted) {
      passes++
    }
  }
  try {
    const clear = await clearStaleInput(terminal, state, pane, beforeWrite, signal)
    if (clear) {
      return clear
    }
    passes = 0
    await sendAgentTurn({
      kind: 'terminal',
      runtime: terminal,
      handle: pane.handle,
      turn: { purpose: 'external-message', body: followUp.text, operationId: followUp.requestId },
      beforeWrite,
      signal
    })
    return { outcome: 'accepted' }
  } catch {
    if (signal.aborted && passes === 0) {
      return refused('connectors_disabled')
    }
    state.stale.set(pane.paneKey, { ptyId: pane.ptyId, text: followUp.text })
    return { outcome: 'unknown', reason: 'writer_failed' }
  } finally {
    guard.dispose()
    state.claims.delete(pane.paneKey)
  }
}

/** Null when the line is safe to paste into; otherwise the answer the follow-up carries. */
async function clearStaleInput(
  terminal: FollowUpTerminal,
  state: PaneInputState,
  pane: BoundPane,
  beforeWrite: (ptyId: string) => Promise<void>,
  signal: AbortSignal
): Promise<Delivery | null> {
  const mark = state.stale.get(pane.paneKey)
  if (!mark) {
    return null
  }
  if (mark.ptyId !== pane.ptyId) {
    // A new process never saw the old line.
    state.stale.delete(pane.paneKey)
    return null
  }
  let write
  try {
    const sent = await terminal.sendTerminal(
      pane.handle,
      { text: buildAgentTuiClearInputForText(mark.text) },
      { inputKind: 'driving', requireWriteSettlement: true, beforeWrite, signal }
    )
    write = sent.writeSettlement
  } catch {
    // A settled write never throws after handoff, so a throw is a refusal before any byte.
    return refused(signal.aborted ? 'connectors_disabled' : 'write_refused')
  }
  if (!write || write.outcome === 'accepted') {
    state.stale.delete(pane.paneKey)
    return null
  }
  return write.outcome === 'refused'
    ? { outcome: 'refused', reason: 'write_refused', write }
    : { outcome: 'unknown', reason: 'write_unverifiable', write }
}
