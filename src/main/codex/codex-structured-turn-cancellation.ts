import { isCodexAppServerRequestError } from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import { providerDiagnosticOf } from '../../shared/agent-session-failure'
import type { AgentSessionCancelOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CodexSession } from './codex-structured-session-state'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-contracts'
import { CODEX_STOP_GRACE_MS } from './codex-request-end-wait'

/**
 * Codex's interrupt handler answers -32600 when the named turn is not its running one (no turn,
 * another turn, thread not loaded) and -32603 when it could not submit the interrupt. A request it
 * could not parse, or one before initialize, also answers -32600: read as not running, it keeps the
 * child, as before.
 */
function isCodexTurnNotRunningRefusal(error: unknown): boolean {
  return isCodexAppServerRequestError(error) && error.code === -32600
}

/**
 * Codex answers a turn's interrupt only as that turn ends, so the answer is what confirms the
 * Stop. It does not end the turn's commands: one still running becomes a background terminal, kept
 * until the app-server exits, which is why the chat's Stop then ends the session. One Codex could
 * not carry out, or never answered, leaves the host to end the child (`performCancel`).
 */
export async function interruptCodexTurn(input: {
  session: CodexSession
  threadId: string
  turnId: string
  requestTimeoutMs?: number
  stoppedAt?: number
  onConfirmed?: () => CodexJournalTranslationAdmission
}): Promise<AgentSessionCancelOutcome> {
  const { session, threadId, turnId } = input
  const remaining =
    input.stoppedAt === undefined ? Infinity : input.stoppedAt + CODEX_STOP_GRACE_MS - Date.now()
  if (remaining <= 0) {
    return { cancelled: false, refusal: { turnMayOpen: true } }
  }
  const timeoutMs = Math.min(input.requestTimeoutMs ?? Infinity, remaining)
  try {
    await session.connection.request(
      'turn/interrupt',
      { threadId, turnId },
      { timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined }
    )
  } catch (error) {
    if (!isCodexAppServerRequestError(error) && !isCodexAppServerUnsupportedError(error)) {
      throw error
    }
    const detail = providerDiagnosticOf(error)
    return {
      cancelled: false,
      refusal: {
        ...(detail ? { detail } : {}),
        ...(isCodexTurnNotRunningRefusal(error) ? { turnNotRunning: true } : {})
      }
    }
  }
  if (threadId === session.threadId) {
    session.abortedTurnIds?.add(turnId)
  }
  const promptAdmission = input.onConfirmed?.()
  if (promptAdmission && !promptAdmission.accepted) {
    throw new Error(
      `Codex prompt cancellation lifecycle was not admitted (${promptAdmission.reason})`
    )
  }
  return { cancelled: true }
}
