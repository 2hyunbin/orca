import { StructuredAgentSessionSubmissionEndedError } from './structured-agent-session-launch-errors'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session-wire'
import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import {
  launchStructuredAgentSession,
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent,
  type StructuredLaunchHostSeedListener
} from '@/lib/launch-structured-agent-session'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { readStructuredSessionTabInventory } from '@/runtime/structured-session-tab-inventory'
import { publishStructuredAgentSessionCreateHydration } from './structured-agent-session-create-hydration'

export type StructuredAgentLaunchReceipt = {
  sessionId: string
  fence: number
  firstMessage?: AgentJournalSubmission
  cursor?: AgentJournalCursor
}

export type StructuredLaunchRecoveryState = {
  intent: StructuredAgentSessionLaunchIntent
  promise: Promise<StructuredAgentLaunchReceipt>
  visibilityUnknown: boolean
  cancelled: boolean
  onVisibilityChanged?: () => void
  onHostSeed?: StructuredLaunchHostSeedListener
}

export class StructuredAgentSessionLaunchCancelledError extends Error {
  constructor() {
    super('structured session launch cancelled')
    this.name = 'StructuredAgentSessionLaunchCancelledError'
  }
}

function throwIfLaunchCancelled(state: StructuredLaunchRecoveryState): void {
  if (state.cancelled) {
    throw new StructuredAgentSessionLaunchCancelledError()
  }
}

async function verifyPublishedSession(state: StructuredLaunchRecoveryState): Promise<void> {
  const snapshots = await readStructuredSessionTabInventory(state.intent.target)
  throwIfLaunchCancelled(state)
  const published = snapshots.some(
    (snapshot) =>
      snapshot.worktree === state.intent.worktreeId &&
      snapshot.tabs.some(
        (tab) => tab.type === 'agent-session' && tab.sessionId === state.intent.sessionId
      )
  )
  if (!published) {
    throw new Error('structured session tab publication unavailable')
  }
}

export async function recoverPublishedSessionReceipt(
  state: StructuredLaunchRecoveryState
): Promise<StructuredAgentLaunchReceipt> {
  if (!state.intent.firstSubmission) {
    await verifyPublishedSession(state)
  }
  let history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    state.intent.target,
    'agentSession.history',
    { sessionId: state.intent.sessionId, direction: 'tail', limit: state.intent.firstSubmission ? 200 : 1 }
  )
  throwIfLaunchCancelled(state)
  const fence = history.page.fence ?? (!history.ok ? history.fence : undefined)
  if (typeof fence !== 'number') {
    throw new Error('structured session fence publication unavailable')
  }
  const messageId = state.intent.firstSubmission?.clientMessageId ?? state.intent.params.firstMessage?.clientMessageId
  let firstMessage = history.page.submissions.find((submission) => submission.clientMessageId === messageId)
  for (let page = 1; state.intent.firstSubmission && !firstMessage && history.page.hasOlder && page < 8; page += 1) {
    const cursor = history.page.window.oldest
    if (!cursor) {
      break
    }
    history = await callStructuredAgentSession<AgentSessionHistoryResult>(state.intent.target, 'agentSession.history', {
      sessionId: state.intent.sessionId, direction: 'before', cursor, limit: 200
    })
    throwIfLaunchCancelled(state)
    firstMessage = history.page.submissions.find((submission) => submission.clientMessageId === messageId)
  }
  if (state.intent.firstSubmission && !firstMessage) {
    throw new Error('The opening message has not been confirmed.')
  }
  if (state.intent.params.firstMessage && !firstMessage) {
    return launchStructuredAgentSession(state.intent, state.onHostSeed, true)
  }
  if (state.intent.createMessageSupport === true) {
    publishStructuredAgentSessionCreateHydration(state.intent, history.page, fence)
  }
  return {
    sessionId: state.intent.sessionId,
    fence,
    ...(firstMessage
      ? { firstMessage, cursor: history.page.liveCursor ?? history.page.window.nextCursor }
      : {})
  }
}

async function retrySameIntent(
  state: StructuredLaunchRecoveryState,
  priorError: unknown
): Promise<StructuredAgentLaunchReceipt> {
  throwIfLaunchCancelled(state)
  if (state.intent.firstSubmission) {
    state.visibilityUnknown = true
    state.onVisibilityChanged?.()
    throw priorError
  }
  try {
    const receipt = await launchStructuredAgentSession(state.intent, state.onHostSeed, true)
    throwIfLaunchCancelled(state)
    if (state.intent.createMessageSupport !== true) {
      await verifyPublishedSession(state)
    }
    return receipt
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError || error instanceof StructuredAgentSessionSubmissionEndedError) {
      throw error
    }
    try {
      return await recoverPublishedSessionReceipt(state)
    } catch {
      if (state.cancelled) {
        throw new StructuredAgentSessionLaunchCancelledError()
      }
      state.visibilityUnknown = true
      state.onVisibilityChanged?.()
      throw error ?? priorError
    }
  }
}

export async function launchAndReconcile(
  state: StructuredLaunchRecoveryState
): Promise<StructuredAgentLaunchReceipt> {
  throwIfLaunchCancelled(state)
  let receipt: StructuredAgentLaunchReceipt
  try {
    receipt = await launchStructuredAgentSession(state.intent, state.onHostSeed)
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError || error instanceof StructuredAgentSessionSubmissionEndedError) {
      throw error
    }
    try {
      return await recoverPublishedSessionReceipt(state)
    } catch {
      return retrySameIntent(state, error)
    }
  }
  try {
    throwIfLaunchCancelled(state)
    if (state.intent.createMessageSupport !== true) {
      await verifyPublishedSession(state)
    }
    return receipt
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    return retrySameIntent(state, error)
  }
}

export async function reconcileUnknownLaunch(
  state: StructuredLaunchRecoveryState
): Promise<StructuredAgentLaunchReceipt> {
  throwIfLaunchCancelled(state)
  state.visibilityUnknown = false
  state.onVisibilityChanged?.()
  try {
    return await recoverPublishedSessionReceipt(state)
  } catch (error) {
    if (state.intent.firstSubmission) {
      state.visibilityUnknown = true
      state.onVisibilityChanged?.()
      throw error
    }
    return retrySameIntent(state, error)
  }
}
