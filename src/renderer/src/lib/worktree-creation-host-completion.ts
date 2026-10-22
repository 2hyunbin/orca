import { useAppStore } from '@/store'
import { activateAndRevealWorktree, type ActivateAndRevealResult } from '@/lib/worktree-activation'
import { completeWorktreeCreation } from '@/lib/worktree-creation-completion'
import { showWorktreeCreationReadyToast } from '@/lib/worktree-creation-ready-toast'
import {
  acceptHostCreatedWorktree,
  materializeHostCreatedWorktree
} from '@/lib/worktree-creation-host-result'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { sendStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-sender'
import { beginStructuredAgentSessionTabClose } from '@/runtime/structured-agent-session-tab-retirement'
import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { mountCreatedWorktreeStartupTabsInBackground } from '@/lib/worktree-creation-background-mount'
import {
  notifyWorktreeParentDropped,
  type WorktreeCreateParentPick
} from '@/store/slices/worktrees/create/worktree-create-parent-pick'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { AgentLaunchResult } from '../../../shared/agent-launch-intent'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { isCreatedWorkspaceInView } from '@/lib/worktree-creation-surface'

export async function completeHostWorktreeCreation(args: {
  creationId: string
  request: WorktreeCreationRequest
  target: RuntimeClientTarget
  executionHostId: ExecutionHostId
  parent: WorktreeCreateParentPick
  launch: AgentLaunchResult
}): Promise<void> {
  const { creationId, request, target, executionHostId, parent, launch } = args
  const agent = request.agent
  if (!agent) {
    return
  }
  const cancelled = (): boolean => !useAppStore.getState().pendingWorktreeCreations[creationId]
  const closeCancelledChat = (): void => {
    if (launch.outcome.kind !== 'structured') {
      return
    }
    const store = useAppStore.getState()
    beginStructuredAgentSessionTabClose({
      target,
      worktreeId: launch.worktreeId,
      sessionId: launch.outcome.sessionId,
      provisional: true,
      layoutOwner: store
    })
    store.closeUnifiedTab(structuredAgentSessionTabId(launch.outcome.sessionId), {
      preserveWorktreeSelection: true,
      recordInteraction: false
    })
  }
  if (cancelled()) {
    closeCancelledChat()
    return
  }
  const created = await acceptHostCreatedWorktree(target, launch, request.repoId, executionHostId)
  if (parent.staleBeforeCreate || (parent.pickedParentWorktreeId && !created.lineage)) {
    notifyWorktreeParentDropped(useAppStore.getState(), parent)
  }
  try {
    await materializeHostCreatedWorktree(target, launch.worktreeId)
  } catch (error) {
    console.warn('worktree create: surface refresh failed', error)
  }
  if (cancelled()) {
    closeCancelledChat()
    return
  }
  const focusOnCompletion = isCreatedWorkspaceInView(
    useAppStore.getState(),
    creationId,
    launch.worktreeId
  )
  let activation: ActivateAndRevealResult | false = false
  if (focusOnCompletion) {
    try {
      activation = activateAndRevealWorktree(launch.worktreeId, {
        providesInitialSurface: true,
        executionHostId,
        sidebarRevealBehavior: 'auto'
      })
    } catch (error) {
      console.error('worktree create: reveal failed', error)
    }
  }
  if (cancelled()) {
    closeCancelledChat()
    return
  }
  const terminal =
    launch.outcome.kind === 'terminal' ? parsePaneKey(launch.outcome.paneKey ?? '') : null
  const tabId =
    launch.outcome.kind === 'structured'
      ? structuredAgentSessionTabId(launch.outcome.sessionId)
      : terminal
        ? target.kind === 'environment'
          ? toWebTerminalSurfaceTabId(terminal.tabId)
          : terminal.tabId
        : null
  if (tabId) {
    seedNativeChatAppliedSessionOptions(tabId, agent, request.startupPlan?.sessionOptions)
    const text = request.launchDraftPrompt ?? request.quickPrompt
    if (text) {
      if (request.promptDelivery === 'draft') {
        useAppStore
          .getState()
          .seedNativeChatLaunchDraft({ tabId, agent, text, createdAt: Date.now() })
      } else if (launch.outcome.kind === 'structured') {
        const sent = sendStructuredAgentSessionMessage({
          sessionId: launch.outcome.sessionId,
          target,
          text
        })
        if (!sent) {
          useAppStore.getState().seedNativeChatLaunchDraft({
            tabId,
            agent,
            text,
            createdAt: Date.now()
          })
        }
      } else {
        void deliverLaunchPromptToAgentTab({
          tabId,
          agent,
          content: text,
          submit: true,
          forcePaste: true
        }).catch((error: unknown) => {
          console.warn('worktree create: terminal prompt delivery failed', error)
        })
      }
    }
  }
  if (request.issueCommand) {
    try {
      ensureWorktreeHasInitialTerminal(
        useAppStore.getState(),
        launch.worktreeId,
        undefined,
        undefined,
        request.issueCommand,
        undefined,
        { callerProvidesSurface: true, activateCreatedTabs: false }
      )
      mountCreatedWorktreeStartupTabsInBackground(launch.worktreeId)
    } catch (error) {
      console.error('worktree create: issue command seeding failed', error)
    }
  }
  if (!focusOnCompletion) {
    try {
      showWorktreeCreationReadyToast(created.worktree, executionHostId)
    } catch (error) {
      console.warn('worktree create: ready toast failed', error)
    }
  }
  await completeWorktreeCreation({
    creationId,
    request,
    worktreeId: launch.worktreeId,
    structuredLaunchAccepted: true,
    activation,
    primaryTabId: tabId,
    backendSpawned: true,
    focusOnCompletion
  })
}
