import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionSubscribersHooks, Subscriber } from './structured-agent-session-subscribers'
import type { SubscriberFieldHooks } from './agent-session-subscriber-frame-fields'
import { capturePublishedWork } from './agent-session-published-work'

export type AgentSessionLivePublication = ReturnType<typeof captureLivePublication>

export function captureLivePublication(
  sessionId: string,
  journal: AgentSessionJournal,
  hooks: AgentSessionSubscribersHooks,
  subscribers: readonly Subscriber[]
) {
  const history = journal.capturePublication()
  const work = capturePublishedWork(history.snapshot, hooks.readCurrentWork?.(sessionId, journal))
  const commands = subscribers.some((subscriber) => !subscriber.boundedFrames)
    ? hooks.readCommands?.(sessionId) : undefined
  const queued = hooks.readQueuePublication?.(sessionId)
  const fields: SubscriberFieldHooks = {
    ...(hooks.readCommands ? { readCommands: () => commands } : {}),
    ...(hooks.readQueuePublication ? { readQueuePublication: () => queued } : {}),
    readBackgroundTasks: hooks.readBackgroundTasks
  }
  return { history, work, fields }
}
