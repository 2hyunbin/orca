import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import { AcpAgentError } from './acp-errors'
import { acpAuthenticationRequired, acpSignInRequiredFailure } from './acp-turn-failures'
import type { AcpStructuredSession } from './acp-structured-session'

export type AcpStructuredChild = Pick<
  AcpStructuredSession,
  | 'sessionId'
  | 'fence'
  | 'acquisitionGeneration'
  | 'spec'
  | 'connection'
  | 'closeRequested'
  | 'journalClosed'
  | 'ended'
  | 'exitObservedAt'
> & {
  phase: 'starting' | 'ready'
  lane: AcpStructuredSession['lane'] | null
  turns: AcpStructuredSession['turns'] | null
  options: AcpStructuredSession['options']
  prompts: AcpStructuredSession['prompts']
  childStops?: AcpStructuredSession['childStops']
  restoreSkipped: readonly string[]
  unbindReadingControl?: () => void
  open: (signal: AbortSignal) => Promise<StructuredAgentSessionProviderOpenResult>
  closing?: Promise<boolean>
  dispose: () => void
}

export function isAcpReadySession(
  session: AcpStructuredChild
): session is AcpStructuredSession & AcpStructuredChild {
  return session.phase === 'ready' && session.lane !== null && session.turns !== null
}

export function acpStartupFailure(
  session: AcpStructuredChild,
  error: unknown
): SubmissionRejectionFact {
  if (error instanceof AcpAgentError && acpAuthenticationRequired(session.spec.dialect, error)) {
    // The agent's sign-in words, never log lines it wrote before refusing.
    return acpSignInRequiredFailure(session.spec.dialect, error)
  }
  const text =
    session.connection.stderrTail() || (error instanceof AcpAgentError ? error.message : '')
  const detail = providerDiagnostic(text, 'person')
  return agentSessionFailureFact('providerStartFailed', detail ? { detail } : {})
}

export function assertAcpStartingSession(
  session: AcpStructuredChild,
  abandoned: () => boolean
): void {
  if (
    session.ended ||
    session.closeRequested ||
    session.journalClosed !== null ||
    session.connection.exited ||
    session.connection.closed ||
    abandoned()
  ) {
    throw new Error(
      session.connection.stderrTail() || `${session.spec.command} closed while starting`
    )
  }
}
