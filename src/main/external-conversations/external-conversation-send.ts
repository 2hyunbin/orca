import type { ConnectorAgent } from '../../shared/external-conversation-link'
import {
  createLaunchedAgentWriteGuard,
  type LaunchedAgentWriteGuardRuntime
} from '../runtime/launched-agent-write-guard'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { sendAgentTurn } from '../runtime/orchestration/send-agent-turn'
import { refusalOf } from './external-conversation-chain'
import { refused, type Delivery } from './external-conversation-types'

export type FollowUpTerminal = Pick<
  OrcaRuntimeService,
  'getTerminalHandleForPaneKey' | 'getTerminalPromptRequestBinding' | 'sendTerminalAgentPrompt'
> &
  LaunchedAgentWriteGuardRuntime

const UNREACHABLE = new Set([
  'terminal_not_writable',
  'terminal_handle_stale',
  'agent_not_in_foreground'
])

/**
 * One follow-up into the linked pane through the shared writer: it waits out an approval on its
 * own predicate, refuses a process other than the one bound here, and stops on `signal`. A throw
 * before any guarded write passed wrote nothing; after that it may have, so it is `unknown`.
 */
export async function deliverFollowUp(
  terminal: FollowUpTerminal,
  followUp: {
    paneKey: string
    agent: ConnectorAgent
    text: string
    requestId: string
    signal: AbortSignal
  }
): Promise<Delivery> {
  const { signal } = followUp
  const handle = terminal.getTerminalHandleForPaneKey(followUp.paneKey)
  let expectedBinding: { ptyId: string; processIncarnation: string }
  try {
    if (!handle) {
      return refused('agent_not_reachable')
    }
    const { ptyId, processIncarnation } = terminal.getTerminalPromptRequestBinding(handle)
    expectedBinding = { ptyId, processIncarnation }
  } catch {
    return refused('agent_not_reachable')
  }
  const guard = createLaunchedAgentWriteGuard(terminal, followUp.agent, {
    unprovableHost: 'write-unless-shell'
  })
  let passes = 0
  try {
    await sendAgentTurn({
      kind: 'terminal',
      runtime: terminal,
      handle,
      turn: { purpose: 'external-message', body: followUp.text, operationId: followUp.requestId },
      beforeWrite: async (ptyId) => {
        await guard.beforeWrite(ptyId)
        // The writer's own checks after this are synchronous, so an abort cannot land between.
        if (!signal.aborted) {
          passes++
        }
      },
      onPermission: 'wait',
      expectedBinding,
      signal
    })
    return { outcome: 'accepted' }
  } catch (error) {
    if (passes === 0) {
      if (signal.aborted) {
        return refused(refusalOf(signal))
      }
      if (error instanceof Error && UNREACHABLE.has(error.message)) {
        return refused('agent_not_reachable')
      }
    }
    return { outcome: 'unknown', reason: 'writer_failed' }
  } finally {
    guard.dispose()
  }
}
