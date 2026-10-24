import type { ChildWorkAdmission } from '../native-chat/agent-session-wire/structured-agent-session-accepted-child-work'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-translation'
import type {
  CodexSession,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredSessionEvent
} from './codex-structured-session-state'
import { startCodexTerminalStopProbe } from './codex-background-terminals'

export function publishCodexChildWork(
  sessions: Map<string, CodexSession>,
  event: Extract<CodexStructuredSessionEvent, { type: 'notification' }>,
  session: CodexSession,
  deps: CodexStructuredSessionAdapterDeps
): CodexJournalTranslationAdmission {
  const finish = (work: ChildWorkAdmission): CodexJournalTranslationAdmission => {
    if (!work.accepted) {
      return {
        ...work,
        retry: () => finish(work.retry?.() ?? { accepted: false, reason: 'failed' })
      }
    }
    startCodexTerminalStopProbe(sessions, event.sessionId, session, deps)
    try {
      deps.onEvent?.(event)
    } catch (error) {
      deps.logger?.warn('Codex event observer failed', { scope: 'codex-event', error })
    }
    return { accepted: true }
  }
  return finish(session.backgroundTasks.publishChildWork())
}
