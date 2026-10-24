import type { ChildWorkAdmission } from '../native-chat/agent-session-wire/structured-agent-session-accepted-child-work'
import { claudePromptCardWritten } from './claude-child-work-evidence'
import {
  resetClaudeRetiredModel,
  retireClaudeLaunchedModel
} from './claude-structured-retired-model'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

type ClaudeEventDelivery = {
  session: ClaudeSession | null
  event: ClaudeStructuredSessionEvent
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'onEvent' | 'requestTimeoutMs' | 'logger'>
  publishChildWork: (
    sessionId: string,
    session?: ClaudeSession | null,
    message?: Record<string, unknown> | null
  ) => ChildWorkAdmission
}

export function emitClaudeStructuredSessionEvent({
  session,
  event,
  deps,
  publishChildWork
}: ClaudeEventDelivery): void {
  // Host evidence follows the journal; the tracker's roster remains available to contract tests.
  if (event.type === 'ended') {
    session?.childWork.clear()
    session?.backgroundTasks.clear()
  } else if (event.type === 'message') {
    session?.childWork.observe(event.message)
    session?.backgroundTasks.observe(event.message, event.startsTurn === true)
  } else if (event.type === 'prompt-cancelled') {
    // Free the child before its withdrawn card is written closed.
    publishChildWork(event.sessionId, session)
  }
  if (event.type === 'message' && session?.commands.observe(event.message)) {
    session.events?.publish()
  }
  session?.translator?.handle(event)
  const retired =
    event.type === 'message' && session ? retireClaudeLaunchedModel(session, event.message) : null
  if (session && retired !== null) {
    resetClaudeRetiredModel(session, deps, event.sessionId, retired)
  }
  const admission = publishChildWork(
    event.sessionId,
    session,
    event.type === 'message' ? event.message : null
  )
  const display = (): void => {
    const notify = (): void => {
      try {
        deps.onEvent?.(event)
      } catch (error) {
        deps.logger?.warn('Claude event observer failed', { scope: 'claude-event', error })
      }
    }
    if (session?.events?.tryAppendTransition) {
      session.events.tryAppendTransition({
        steps: [],
        lifecycle: false,
        publish: false,
        onPublished: notify
      })
    } else {
      notify()
    }
  }
  if (!admission.accepted && session?.retryChildWork) {
    const retry = session.retryChildWork
    session.retryChildWork = () => {
      const result = retry()
      if (result.accepted) {
        session.retryChildWork = undefined
        display()
      }
      return result
    }
  } else if (admission.accepted) {
    display()
  }
  // A prompt blocks its child only after the journal has written its card.
  void claudePromptCardWritten(session, event)
    ?.then(() => publishChildWork(event.sessionId))
    .catch((error: unknown) =>
      deps.logger?.warn('Claude prompt work ended unwritten', { scope: 'claude-child-work', error })
    )
}
