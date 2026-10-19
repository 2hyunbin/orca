import type { StructuredAgentSessionStatusObserverOptions } from './agent-session-wire/structured-agent-session-status-observation'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  clampConversationNameFirstPrompt,
  conversationNameSeed
} from '../../shared/conversation-name-generation'
import { hasStructuredChatPromptText } from '../../shared/structured-agent-session-first-prompt'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from './agent-session-wire/structured-agent-session-logger'

export type StructuredChatNamingDeps = {
  getStore: () => Pick<
    AgentSessionRecordStore,
    'getRecord' | 'compareAndSetConversationName'
  > | null
  getSettings: () => Pick<GlobalSettings, 'nativeChatAutoName'>
  readFirstPrompt: (sessionId: string, hostStartedAt: number) => Promise<string>
  now?: () => number
  /** An orchestration worker's chat takes its task's title instead of a generated name. */
  workerTaskTitle: (record: AgentSessionRecord) => { title: string } | null
  generate: (record: AgentSessionRecord, firstPrompt: string) => Promise<string | null>
  onNamed: (workspaceId: string, sessionId: string) => void
  logger: StructuredAgentSessionLogger
  wait?: (ms: number) => Promise<void>
}

/** Backoff before each retry of a failed first name; the seed stays if every try fails. */
const GENERATION_RETRY_DELAYS_MS = [2000, 4000]

const waitFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createStructuredChatNamingHandler(deps: StructuredChatNamingDeps) {
  const attempted = new Set<string>()
  const hostStartedAt = (deps.now ?? Date.now)()
  const logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
  const warn = (sessionId: string, error: unknown) =>
    logger.warn('Chat name generation failed', {
      scope: 'conversation-name',
      sessionId,
      error
    })
  const refresh = (record: AgentSessionRecord) => {
    try {
      deps.onNamed(record.location.workspaceId, record.sessionId)
    } catch (error) {
      warn(record.sessionId, error)
    }
  }

  async function generateWithRetries(
    record: AgentSessionRecord,
    firstPrompt: string,
    stillSeeded: () => boolean
  ): Promise<string | null> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const chatName = await deps.generate(record, firstPrompt)
        if (chatName) {
          return chatName
        }
      } catch (error) {
        warn(record.sessionId, error)
      }
      const delay = GENERATION_RETRY_DELAYS_MS[attempt]
      if (delay === undefined) {
        return null
      }
      await (deps.wait ?? waitFor)(delay)
      if (!stillSeeded()) {
        return null
      }
    }
  }

  async function name(summary: AgentSessionStatusSummary) {
    const store = deps.getStore()
    const record = store?.getRecord(summary.sessionId)
    const namingOff = () => deps.getSettings().nativeChatAutoName === false
    if (!store || !record || record.conversationName !== undefined || namingOff()) {
      return
    }
    const workerTask = deps.workerTaskTitle(record)
    if (workerTask) {
      const named =
        workerTask.title &&
        (await store.compareAndSetConversationName(summary.sessionId, workerTask.title, null))
      if (named) {
        refresh(named)
      }
      return
    }
    const firstPrompt = clampConversationNameFirstPrompt(
      await deps.readFirstPrompt(record.sessionId, hostStartedAt)
    )
    const seed = hasStructuredChatPromptText(firstPrompt) ? conversationNameSeed(firstPrompt) : null
    if (!seed || namingOff()) {
      return
    }
    // The prompt names the chat at once; generation only upgrades it, so its failure keeps a name.
    const seeded = await store.compareAndSetConversationName(summary.sessionId, seed, null)
    if (!seeded?.conversationName) {
      return
    }
    refresh(seeded)
    const stillSeeded = () =>
      !namingOff() &&
      store.getRecord(seeded.sessionId)?.conversationName === seeded.conversationName
    const chatName = await generateWithRetries(seeded, firstPrompt, stillSeeded)
    if (!chatName || namingOff()) {
      return
    }
    const named = await store.compareAndSetConversationName(
      summary.sessionId,
      chatName,
      seeded.conversationName
    )
    if (named) {
      refresh(named)
    }
  }

  return (
    summary: AgentSessionStatusSummary,
    options: StructuredAgentSessionStatusObserverOptions
  ): void => {
    if (
      options.replay ||
      options.firstInputSubmissionKey === null ||
      summary.status !== 'working' ||
      attempted.has(summary.sessionId)
    ) {
      return
    }
    attempted.add(summary.sessionId)
    void name(summary).catch((error: unknown) => warn(summary.sessionId, error))
  }
}
