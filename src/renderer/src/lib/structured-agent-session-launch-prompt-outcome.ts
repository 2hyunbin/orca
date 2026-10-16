import { handBackStagedPrompt, releaseStagedStructuredLaunchPrompt } from './structured-agent-session-launch-prompt'
import { StructuredAgentSessionSubmissionEndedError } from './structured-agent-session-launch-errors'
import type { StagedStructuredLaunchPrompt } from './structured-agent-session-launch-prompt'
import type { StructuredLaunchCaller } from './structured-agent-session-launch-callers'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import { STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS } from '@/components/native-chat/structured-agent-session-message-sender'
import {
  notifyStructuredLaunchListeners,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

/** Pre-issue reservation settlement ends the command even while discovery is unresolved. */
export function boundStructuredLaunchReservation(
  state: StructuredLaunchState,
  created: Promise<StructuredAgentLaunchReceipt>,
  prompt: StagedStructuredLaunchPrompt | null
): Promise<StructuredAgentLaunchReceipt> {
  const { intent } = state
  if (!prompt?.sourceDraft || !prompt.slot) {
    return created
  }
  return Promise.race([created, prompt.slot.outcome.then(() => {
    if (!intent.createPrepared) {
      intent.prepareCreate = () => { throw new StructuredAgentSessionSubmissionEndedError() }
      throw new StructuredAgentSessionSubmissionEndedError()
    }
    return created
  })])
}

/** The message deadline frees the composer and offers the existing Retry while create is unknown. */
export function trackStructuredLaunchPromptOutcome(
  state: StructuredLaunchState,
  caller: StructuredLaunchCaller
): void {
  const group = state.callers
  void caller.promptDeliveryResult?.then((outcome) => {
    if (
      state.callers !== group ||
      state.cancelled ||
      group.outcome !== 'pending' ||
      !(outcome.inComposer || outcome.unconfirmed)
    ) {
      return
    }
    state.visibilityUnknown = true
    group.outcome = 'unknown'
    notifyStructuredLaunchListeners()
  })
}

/** Confirmation checks share the opening message deadline after its send slot has settled. */
export function trackStructuredLaunchConfirmationDeadline(
  state: StructuredLaunchState,
  promise: Promise<StructuredAgentLaunchReceipt>
): void {
  if (state.intent.createMessageSupport === false) {
    return
  }
  const deadline = setTimeout(() => {
    if (
      state.promise !== promise ||
      state.cancelled ||
      state.callers.outcome !== 'pending' ||
      state.intent.createMessageSupport === false
    ) {
      return
    }
    state.visibilityUnknown = true
    state.callers.outcome = 'unknown'
    notifyStructuredLaunchListeners()
  }, STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
  const clear = (): void => clearTimeout(deadline)
  void promise.then(clear, clear)
}

export function failStagedStructuredLaunchPrompt(prompt: StagedStructuredLaunchPrompt): void {
  if (prompt.discarded) {
    return
  }
  if (prompt.slot) {
    prompt.slot.release(['notDoneSend'])
  } else {
    handBackStagedPrompt(prompt)
  }
  releaseStagedStructuredLaunchPrompt(prompt)
  prompt.settleCreate({ delivered: false, inComposer: true })
}
