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
import type { StructuredLaunchAttempt } from './structured-agent-session-launch-request'

export type StructuredAgentLaunchReceipt = {
  sessionId: string
  fence: number
  firstMessage?: AgentJournalSubmission
  cursor?: AgentJournalCursor
}

export type StructuredLaunchRecoveryState = {
  callers?: { attempt: StructuredLaunchAttempt }
  intent: StructuredAgentSessionLaunchIntent
  promise: Promise<StructuredAgentLaunchReceipt>
  visibilityUnknown: boolean
  cancelled: boolean
  onVisibilityChanged?: () => void
  onHostSeed?: StructuredLaunchHostSeedListener
}

function issueLaunch(state: StructuredLaunchRecoveryState, unknown = false): Promise<StructuredAgentLaunchReceipt> {
  const attempt = state.callers?.attempt
  const reservedSubmission = attempt?.kind === 'first' && attempt.stagedPrompt?.sourceDraft !== undefined
  if (reservedSubmission) {
    return launchStructuredAgentSession(state.intent, state.onHostSeed, unknown, true)
  }
  return unknown
    ? launchStructuredAgentSession(state.intent, state.onHostSeed, true)
    : launchStructuredAgentSession(state.intent, state.onHostSeed)
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
  state: StructuredLaunchRecoveryState,
  replayMissingMessage = true
): Promise<StructuredAgentLaunchReceipt> {
  await verifyPublishedSession(state)
  const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    state.intent.target,
    'agentSession.history',
    { sessionId: state.intent.sessionId, direction: 'tail', limit: 1 }
  )
  throwIfLaunchCancelled(state)
  const fence = history.page.fence ?? (!history.ok ? history.fence : undefined)
  if (typeof fence !== 'number') {
    throw new Error('structured session fence publication unavailable')
  }
  const firstMessage = state.intent.params.firstMessage
    ? history.page.submissions.find((submission) => submission.clientMessageId === state.intent.params.firstMessage?.clientMessageId)
    : undefined
  if (state.intent.params.firstMessage && !firstMessage) {
    if (!replayMissingMessage) {
      throw new Error('The opening message has not been confirmed.')
    }
    return issueLaunch(state, true)
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
  try {
    const receipt = await issueLaunch(state, true)
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
    receipt = await issueLaunch(state)
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
    return retrySameIntent(state, error)
  }
}
