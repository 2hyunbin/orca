import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { BoundedMap } from '../../shared/bounded-map'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { AcpAgentError, AcpAuthRequiredError, AcpSignInPromptError } from './acp-errors'

const FAILED_STOP_REASONS = ['error', 'rate_limit']

function acpStopReasonFailed(stopReason: string): boolean {
  return FAILED_STOP_REASONS.includes(stopReason)
}

/** Prefer provider error details over generic messages such as Internal error. */
export function acpPromptErrorDetail(dialect: AcpDialect, error: AcpAgentError): string {
  // Orca's sign-in guidance already explains what to do.
  if (error instanceof AcpSignInPromptError) {
    return ''
  }
  return dialect.promptErrorDetail?.(error) ?? acpErrorDataWords(error.data) ?? error.message
}

// Structured metadata is not user-facing diagnostic text.
function acpErrorDataWords(data: unknown): string | undefined {
  const words =
    typeof data === 'string'
      ? data
      : typeof data === 'object' && data !== null && 'details' in data
        ? data.details
        : undefined
  return typeof words === 'string' && words.trim() ? words : undefined
}

export function acpAuthenticationRequired(dialect: AcpDialect, error: unknown): boolean {
  return (
    error instanceof AcpAuthRequiredError ||
    (error instanceof AcpAgentError && dialect.authenticationRequired?.(error) === true)
  )
}

export function acpSignInRequiredFailure(
  dialect: AcpDialect,
  error: AcpAgentError
): SubmissionRejectionFact {
  const detail = providerDiagnostic(acpPromptErrorDetail(dialect, error), 'person')
  return agentSessionFailureFact('notSignedIn', detail ? { detail } : {})
}

/** Deduplicate failure rows by turn, accepting later reasons when earlier reports lacked one. */
export class AcpTurnFailures {
  /** The reason each failed turn's row holds; '' for none yet. */
  private readonly rows = new BoundedMap<string, { text: string; notSignedIn: boolean }>({
    maxEntries: 128
  })

  constructor(
    private readonly sessionId: string,
    private readonly dialect: AcpDialect,
    private readonly agentName: string | undefined
  ) {}

  has(turn: string): boolean {
    return this.rows.has(turn)
  }

  ended(
    turn: string,
    stopReason: string,
    text: string | undefined,
    notSignedIn = false
  ): ProviderTimelineEvent[] {
    return acpStopReasonFailed(stopReason) ? this.row(turn, text, stopReason, notSignedIn) : []
  }

  row(
    turn: string,
    text: string | undefined,
    stopReason = 'error',
    notSignedIn = false
  ): ProviderTimelineEvent[] {
    const written = this.rows.peek(turn)
    const detail = text === undefined ? undefined : providerDiagnostic(text, 'person')
    if (
      written !== undefined &&
      (written.text !== '' || !detail) &&
      (!notSignedIn || written.notSignedIn)
    ) {
      return []
    }
    const diagnostic =
      detail ?? (written?.text ? providerDiagnostic(written.text, 'person') : undefined)
    const authenticationRequired = notSignedIn || written?.notSignedIn === true
    this.rows.set(turn, {
      text: diagnostic?.text ?? '',
      notSignedIn: authenticationRequired
    })
    return [
      {
        type: 'item.update',
        item: `turn-failure:${turn}`,
        body: {
          kind: 'status',
          tone: 'error',
          ...(authenticationRequired
            ? agentSessionFailureWords(
                agentSessionFailureFact('notSignedIn', { detail: diagnostic }),
                { agentName: this.agentName, surface: 'row' }
              )
            : {
                text:
                  diagnostic?.text ??
                  this.dialect.failedTurnText?.(stopReason) ??
                  `${this.agentName ?? 'The agent'} ended this turn with an error.`
              })
        },
        join: { thread: this.sessionId, turn }
      }
    ]
  }
}
