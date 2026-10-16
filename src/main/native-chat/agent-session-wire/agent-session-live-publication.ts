import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionSubscribersHooks, Subscriber } from './structured-agent-session-subscribers'
import type { SubscriberFieldHooks } from './agent-session-subscriber-frame-fields'
import { capturePublishedWork } from './agent-session-published-work'
import { sameJournalCursor } from '../agent-session-journal/journal-cursor'

export type AgentSessionLivePublication = ReturnType<typeof captureLivePublication>

export function captureLivePublication(
  sessionId: string,
  journal: AgentSessionJournal,
  hooks: AgentSessionSubscribersHooks,
  subscribers: readonly Subscriber[]
) {
  const cursor = journal.cursor()
  const history = subscribers.some((subscriber) => !sameJournalCursor(subscriber.cursor, cursor))
    ? journal.capturePublication()
    : undefined
  const currentWork = hooks.readCurrentWork?.(sessionId, journal)
  const work =
    currentWork &&
    (history || subscribers.some((subscriber) => subscriber.workView !== currentWork.viewKey()))
      ? capturePublishedWork(history?.snapshot ?? journal.snapshot(), currentWork)
      : undefined
  const commands = subscribers.some((subscriber) => !subscriber.boundedFrames)
    ? hooks.readCommands?.(sessionId) : undefined
  const queued = hooks.readQueuePublication?.(sessionId)
  const fields: SubscriberFieldHooks = {
    ...(hooks.readCommands ? { readCommands: () => commands } : {}),
    ...(hooks.readQueuePublication ? { readQueuePublication: () => queued } : {}),
    readBackgroundTasks: hooks.readBackgroundTasks
  }
  return { cursor, history, work, fields }
}
