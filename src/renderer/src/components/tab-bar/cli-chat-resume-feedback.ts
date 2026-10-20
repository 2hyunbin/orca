import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { structuredLaunchFailure } from '@/lib/structured-agent-session-launch-failure'
import {
  activateAiVaultStructuredSession,
  activateAiVaultStructuredSessionVerified
} from '@/lib/activate-ai-vault-structured-session'
import {
  callStructuredAgentSession,
  supportsInPlaceSwitch
} from '@/runtime/structured-agent-session-client'
import { agentSessionWriteFailureText } from '../native-chat/agent-session-write-notice-text'
import { agentLabel } from '../../../../shared/ai-vault-session-filters'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session-wire'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { cliConversationExitGuidance } from '@/lib/cli-conversation-exit-guidance'
import type { CliChatResumeSource } from './cli-chat-resume-source'

/** True only when the chat already holding the conversation took it over: the host started its
 *  agent (catching up on the terminal's turns) and its tab is active. Otherwise the terminal stays. */
export async function reportCliChatResumeFailure(
  source: CliChatResumeSource,
  error: unknown,
  target: RuntimeClientTarget
): Promise<boolean> {
  const owner = structuredLaunchFailure(error)?.owner
  if (owner) {
    return switchIntoOwner(source, owner, target)
  }
  toastCliChatResumeFailure(source, error)
  return false
}

async function switchIntoOwner(
  source: CliChatResumeSource,
  structuredSession: NonNullable<AiVaultSession['structuredSession']>,
  target: RuntimeClientTarget
): Promise<boolean> {
  // A host without the switch keeps the earlier behaviour: the chat is shown, the terminal stays.
  if (!(await supportsInPlaceSwitch(target, source.agent))) {
    await activateAiVaultStructuredSession({ structuredSession }, undefined, target)
    return false
  }
  const switched = await callStructuredAgentSession<
    { ok: true } | { ok: false; refusal: AgentSessionWireRefusal }
  >(target, 'agentSession.switchToChat', { sessionId: structuredSession.sessionId }).catch(
    () => null
  )
  if (!switched?.ok) {
    const failure = switched
      ? structuredLaunchFailure(Object.assign(new Error(switched.refusal.message), switched))
      : undefined
    // Never the owner shortcut again: a refused start keeps the terminal and says why.
    toast.error(
      failure?.code === 'agent_session_operation_invalid' &&
        failure.details?.reason === 'conversationOpenInTerminal'
        ? cliConversationExitGuidance(source.agent, true)
        : agentSessionWriteFailureText(failure ?? { kind: 'unconfirmed' }, 'read-history', {
            agentName: agentLabel(source.agent)
          })
    )
    return false
  }
  const shown = await activateAiVaultStructuredSessionVerified(
    { structuredSession },
    undefined,
    target
  )
  return shown === 'activated'
}

function toastCliChatResumeFailure(source: CliChatResumeSource, error: unknown): void {
  const refusal = structuredLaunchFailure(error)
  if (
    refusal?.code === 'agent_session_conflict' ||
    refusal?.code === 'agent_session_ownership_unknown'
  ) {
    toast.error(
      refusal.code === 'agent_session_conflict' &&
        refusal.details?.reason === 'conversationHeldElsewhere'
        ? cliConversationExitGuidance(source.agent, true)
        : translate(
            'auto.components.right.sidebar.AiVaultPanel.resumeInChatConflict',
            'Another chat is already holding this conversation.'
          )
    )
    return
  }
  // The chat's agent refused to start while the terminal may still write the conversation.
  if (
    refusal?.code === 'agent_session_operation_invalid' &&
    refusal.details?.reason === 'conversationOpenInTerminal'
  ) {
    toast.error(cliConversationExitGuidance(source.agent, true))
    return
  }
  if (refusal?.details?.reason === 'conversationMovingToTerminal') {
    toast.error(agentSessionWriteFailureText(refusal, 'read-history'))
    return
  }
  if (refusal?.code === 'agent_session_identity_required') {
    if (refusal.details?.reason === 'transcriptNotFound') {
      toast.error(
        translate(
          'components.native-chat.resumeInNewChat.notSavedYet',
          "{{agent}} hasn't saved this conversation yet. Try again after it replies.",
          { agent: agentLabel(source.agent) }
        )
      )
      return
    }
    const failure = structuredLaunchFailure(error)
    if (failure) {
      toast.error(agentSessionWriteFailureText(failure, 'read-history'))
      return
    }
  }
  toast.error(
    translate(
      'auto.components.right.sidebar.AiVaultPanel.resumeInChatFailed',
      'Could not resume this session in a new chat.'
    )
  )
}
