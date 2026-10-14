import type { AiVaultSurfaceSwitchOperation } from '@/lib/ai-vault-surface-switch-operation'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import type { AiVaultSessionLaunchContext } from '../../../../shared/ai-vault-selected-session'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import { prepareAiVaultSessionForResume } from '@/lib/ai-vault-session-resume-preparation'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import type { AgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/structured-agent-session-provisional-tab'

export function activateAiVaultResumeWorkspace(workspaceId: string): boolean {
  return activateAndRevealWorkspace(workspaceId) !== false
}

/** Adopt a vault conversation into a new structured chat. The route was decided by the
 *  eligibility gate that showed this action, so it re-enters as a verdict. No legacy fallback:
 *  resume has no terminal equivalent short of the resume command, and switching surface silently
 *  would hide the refusal the user needs to see. */
export async function resumeAiVaultSessionInNewChat(
  session: AiVaultSessionLaunchContext,
  agent: AgentSessionHandleProvider,
  worktreeId: string,
  requestId: AgentLaunchRequestId,
  operation?: AiVaultSurfaceSwitchOperation
): Promise<void> {
  try {
    // Codex rows can live under a shared legacy home; the same preparation the terminal resume
    // runs re-pins them, and its result is what names the conversation the host will look for.
    const preparedSession = await prepareAiVaultSessionForResume(session)
    if (operation && !operation.isSourceOpen()) {
      return
    }
    const plan = adoptAgentSessionLaunchVerdict({
      route: 'structured-native-chat',
      requestId,
      agent,
      worktreeId,
      resumeFrom: {
        providerSessionId: preparedSession.sessionId,
        ...(preparedSession.selectedSource
          ? { selectedSource: preparedSession.selectedSource }
          : {})
      }
    })
    operation?.onDispatch?.()
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: {},
      beforeOpen: () => {
        if (useAppStore.getState().activeWorktreeId !== worktreeId) {
          return activateAiVaultResumeWorkspace(worktreeId)
        }
        return true
      }
    })
    if (launch) {
      const settlement = launch.settlement.then((settlement) => {
        if (operation?.signal.aborted) {
          return
        }
        if (settlement.kind === 'failed' && !settlement.notified) {
          notifyAiVaultSessionResumeInChatFailure(settlement.error)
        }
      })
      if (operation) {
        await waitForPromiseWithSignal(settlement, operation.signal)
      } else {
        void settlement
      }
    }
  } catch (error) {
    if (!operation?.signal.aborted) {
      notifyAiVaultSessionResumeInChatFailure(error)
    }
  }
}

/** The host refuses an adoption whose conversation another chat already holds, and refuses one it
 *  cannot find under any account home it recognises. Both are actionable, and neither is the
 *  generic "could not prepare" the terminal resume reports. */
function notifyAiVaultSessionResumeInChatFailure(error: unknown): void {
  if (hasRuntimeRpcErrorCode(error, 'agent_session_conflict')) {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.resumeInChatConflict',
        'Another chat is already holding this conversation.'
      )
    )
    return
  }
  if (hasRuntimeRpcErrorCode(error, 'agent_session_identity_required')) {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.resumeInChatTranscriptMissing',
        "This conversation's history could not be loaded, so it cannot be resumed in chat."
      )
    )
    return
  }
  toast.error(
    translate(
      'auto.components.right.sidebar.AiVaultPanel.resumeInChatFailed',
      'Could not resume this session in a new chat.'
    )
  )
}
