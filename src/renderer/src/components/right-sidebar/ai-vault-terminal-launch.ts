import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import type { AiVaultResumeStartup } from '@/lib/ai-vault-resume-command'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import type { AiVaultSurfaceSwitchOperation } from '@/lib/ai-vault-surface-switch-operation'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import type { AiVaultSessionLaunchContext } from '../../../../shared/ai-vault-selected-session'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'
import { agentLabel } from './ai-vault-session-filters'
import { activateAiVaultResumeWorkspace } from './ai-vault-session-resume-in-chat-launch'
import {
  notifyAiVaultSessionPreparationFailure,
  notifyAiVaultSessionQueued,
  resolveAiVaultSessionLaunchTargetOrNotify
} from './ai-vault-session-launch-feedback'

export async function launchAiVaultSessionInTerminal({
  session,
  targetWorktreeId,
  activeWorkspaceId,
  targetState,
  prepareStartup,
  describeFailure = (message) => message,
  operation
}: {
  session: AiVaultSessionLaunchContext
  targetWorktreeId: string | undefined
  activeWorkspaceId: string | null
  targetState: AiVaultSessionResumeTargetState
  prepareStartup: (worktreeId: string) => Promise<AiVaultResumeStartup>
  describeFailure?: (message: string) => string
  operation?: AiVaultSurfaceSwitchOperation
}): Promise<void> {
  const targetId = resolveAiVaultSessionLaunchTargetOrNotify({
    sessionFilePath: session.filePath,
    sessionExecutionHostId: session.executionHostId,
    activeWorktreeId: activeWorkspaceId,
    targetWorktreeId,
    targetState
  })
  if (!targetId) {
    return
  }
  await prepareStartup(targetId.worktreeId)
    .then(async (startup) => {
      if (operation && !operation.isSourceOpen()) {
        return
      }
      operation?.onDispatch?.()
      const launchResult = launchAiVaultSessionInNewTab({
        agent: session.agent,
        worktreeId: targetId.worktreeId,
        ...startup
      })
      if (launchResult.tabId === null) {
        const settlement = launchResult.runtimeLaunch.then((outcome) => {
          if (operation?.signal.aborted) {
            return
          }
          if (outcome.status === 'failed') {
            toast.error(
              readIpcErrorMessage(new Error(describeFailure(outcome.message))) ||
                translate(
                  'auto.lib.launch.agent.in.new.tab.11cce5cc77',
                  'Could not launch {{value0}} in a new terminal.',
                  { value0: agentLabel(session.agent) }
                )
            )
            return
          }
          if (useAppStore.getState().activeWorktreeId !== targetId.worktreeId) {
            activateAiVaultResumeWorkspace(targetId.worktreeId)
          }
          notifyAiVaultSessionQueued(session.agent)
        })
        if (operation) {
          await waitForPromiseWithSignal(settlement, operation.signal)
        } else {
          void settlement
        }
        return
      }
      if (useAppStore.getState().activeWorktreeId !== targetId.worktreeId) {
        activateAiVaultResumeWorkspace(targetId.worktreeId)
      }
      notifyAiVaultSessionQueued(session.agent)
    })
    .catch((error: unknown) => {
      if (!operation?.signal.aborted) {
        notifyAiVaultSessionPreparationFailure(error, session.agent, describeFailure)
      }
    })
}
