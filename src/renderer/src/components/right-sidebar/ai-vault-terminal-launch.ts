import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import type { AiVaultResumeStartup } from '@/lib/ai-vault-resume-command'
import type { AiVaultSurfaceSwitchOperation } from '@/lib/ai-vault-surface-switch-operation'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import type { AiVaultSessionLaunchContext } from '../../../../shared/ai-vault-selected-session'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'
import { agentLabel } from './ai-vault-session-filters'
import { activateAiVaultResumeWorkspace } from './ai-vault-session-resume-in-chat-launch'
import {
  aiVaultResumeUnsupportedMessage,
  resolveAiVaultSessionLaunchTarget
} from './ai-vault-session-launch-target'

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
  const showQueuedToast = (): void => {
    toast.success(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.agentSessionQueued',
        '{{value0}} session queued',
        { value0: agentLabel(session.agent) }
      )
    )
  }
  await prepareStartup(targetId.worktreeId)
    .then(async (startup) => {
      if (operation && !operation.isSourceOpen()) {
        return
      }
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
              describeFailure(outcome.message) ||
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
          showQueuedToast()
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
      showQueuedToast()
    })
    .catch((error: unknown) => {
      if (!operation?.signal.aborted) {
        notifyAiVaultSessionPreparationFailure(error, describeFailure)
      }
    })
}

export function notifyAiVaultSessionPreparationFailure(
  error: unknown,
  describeFailure: (message: string) => string = (message) => message
): void {
  toast.error(
    error instanceof Error
      ? describeFailure(error.message)
      : translate(
          'auto.components.right.sidebar.AiVaultPanel.prepareSessionResumeFailed',
          'Could not prepare this session for resume.'
        )
  )
}

export function resolveAiVaultSessionLaunchTargetOrNotify(
  args: Parameters<typeof resolveAiVaultSessionLaunchTarget>[0]
): Extract<ReturnType<typeof resolveAiVaultSessionLaunchTarget>, { status: 'ready' }> | null {
  const target = resolveAiVaultSessionLaunchTarget(args)
  if (target.status === 'missing') {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.openWorkspaceBeforeResuming',
        'Open a workspace before resuming a session.'
      )
    )
    return null
  }
  if (target.status === 'unsupported') {
    toast.error(aiVaultResumeUnsupportedMessage(target.targetStatus))
    return null
  }
  return target
}
