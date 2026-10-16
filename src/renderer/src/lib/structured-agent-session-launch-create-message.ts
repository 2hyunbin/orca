import { StructuredAgentSessionSubmissionEndedError } from './structured-agent-session-launch-errors'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { StructuredLaunchState } from './structured-agent-session-launch-registry'
import { notifyStructuredLaunchListeners } from './structured-agent-session-launch-registry'
import {
  prepareStructuredLaunchPromptForCreate,
  prepareLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection
} from '../../../shared/structured-agent-session-option-view'
import { structuredAgentSessionOptionSnapshot } from '../../../shared/structured-agent-session-options'
import { firstFrameOptionState } from '@/components/native-chat/use-structured-agent-session-option-state'
import {
  applyStructuredLaunchHeldOptions,
  settleStructuredLaunchCreateOptions
} from './structured-agent-session-launch-options'

/** Freeze what create carries once; an ambiguous reply always replays the same payload. */
export async function prepareStructuredLaunchCreateMessage(state: StructuredLaunchState): Promise<void | (() => void)> {
  const { intent } = state
  if (intent.createPrepared) {
    return
  }
  const attempt = state.callers.attempt
  const prompt = attempt.kind === 'first' ? attempt.stagedPrompt : null
  if (prompt?.sourceDraft) {
    if (!prompt.slot?.prepare()) {
      throw new StructuredAgentSessionSubmissionEndedError()
    }
    await prompt.beforeCreate?.()
  }
  return () => {
    if (prompt?.sourceDraft && !prompt.slot?.prepare()) {
      throw new StructuredAgentSessionSubmissionEndedError()
    }
    if (intent.createMessageSupport !== true) {
      prepareLegacyStructuredLaunchPrompts(intent.sessionId)
      intent.createPrepared = true
      notifyStructuredLaunchListeners()
      return
    }
    const firstMessage = prompt?.beforeSend ? undefined : prepareStructuredLaunchPromptForCreate(
      intent.sessionId, intent.target, prompt?.sourceDraft ? prompt : undefined
    )
    if (prompt?.sourceDraft && !prompt.beforeSend && !firstMessage) {
      throw new StructuredAgentSessionSubmissionEndedError()
    }
    const options = structuredLaunchCreateOptions(state)
    const params = {
      ...intent.params,
      ...(firstMessage ? { firstMessage } : {}),
      ...(options ? { options } : {})
    }
    intent.params = {
      ...params,
      envelope: {
        ...params.envelope,
        payloadFingerprint: structuredAgentSessionCreateFingerprint({
          sessionId: intent.sessionId,
          ...params
        })
      }
    }
    intent.createPrepared = true
    notifyStructuredLaunchListeners()
  }
}

/** Picks held so far, and the model and effort the chat shows: a first message starts its turn
 *  on them, as a later send does. */
function structuredLaunchCreateOptions(
  state: StructuredLaunchState
): Readonly<Record<string, string>> | undefined {
  const { intent, selection } = state
  const attempt = state.callers.attempt
  if (attempt.kind === 'first' && attempt.stagedPrompt?.sourceDraft) {
    return attempt.stagedPrompt.options
  }
  const firstFrame = firstFrameOptionState(intent.agent, intent.target, {
    newLaunch: !intent.params.resumeFrom,
    worktree: intent.params.worktree,
    seedsModel: intent.seedOptions?.model !== undefined
  })
  // Create has always carried options, so any host takes what the chat shows.
  const view = structuredAgentSessionOptionView(
    firstFrame,
    intent.seedOptions,
    selection.held,
    true
  )
  const options = {
    ...selection.held,
    ...structuredAgentSessionSendSelection(intent.agent, structuredAgentSessionOptionSnapshot(view))
  }
  return Object.keys(options).length ? options : undefined
}

/** Later picks use the normal option path without holding publication behind startup. */
const optionPublications = new WeakMap<StructuredLaunchState, Promise<StructuredAgentLaunchReceipt>>()

export function publishStructuredLaunchCreateOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt
): Promise<StructuredAgentLaunchReceipt> {
  const existing = optionPublications.get(state)
  const publication = existing ?? Promise.resolve().then(() => {
    if (state.intent.createMessageSupport === true) {
      settleStructuredLaunchCreateOptions(state, state.intent.params.options ?? {})
    }
    return receipt
  })
  optionPublications.set(state, publication)
  return publication.then(() => {
    if (state.intent.createMessageSupport !== true) {
      return applyStructuredLaunchHeldOptions(state, receipt)
    }
    void applyStructuredLaunchHeldOptions(state, receipt).catch((error: unknown) => {
      console.warn('[native-chat] applying a launch option failed', error)
    })
    return receipt
  })
}
