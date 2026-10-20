import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { buildAiVaultResumeStartupForWorktree } from '@/lib/ai-vault-resume-command'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import { structuredLaunchFailure } from '@/lib/structured-agent-session-launch-failure'
import {
  callStructuredAgentSession,
  supportsInPlaceSwitch
} from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { AiVaultChatForkSourceSchema } from '../../../../shared/ai-vault-chat-fork-contract'
import type { AiVaultAgent } from '../../../../shared/ai-vault-types'
import { agentLabel } from '../../../../shared/ai-vault-session-filters'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { adoptsCliConversations } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { seedSwitchedTerminalConversation } from './switched-terminal-conversation'

const pending = new Set<string>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((listener) => listener())

export function useNativeChatCliSwitchPending(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => !!sessionId && pending.has(sessionId),
    () => false
  )
}

/** Why a switch to the CLI didn't happen, in words the chat's user can act on. */
export function nativeChatCliSwitchFailureText(error: unknown, agent: AiVaultAgent): string {
  const refusal = structuredLaunchFailure(error)
  const reason = refusal?.details?.reason
  if (reason === 'turnActive') {
    return translate(
      'components.tab.bar.switch.waitForReply',
      'Wait for the reply to finish or stop it, then switch.'
    )
  }
  if (reason === 'ownerUnproven') {
    return translate(
      'components.tab.bar.switch.stopUnconfirmed',
      "Couldn't confirm {{agent}} stopped. Try again.",
      { agent: agentLabel(agent) }
    )
  }
  if (reason === 'conversationHeldElsewhere') {
    return translate(
      'components.native-chat.failureWords.conversationMovingToTerminal',
      'This conversation is moving to a terminal. Use it there, or wait a moment and try again.'
    )
  }
  return (
    (refusal ? undefined : readIpcErrorMessage(error)) ||
    translate('components.tab.bar.switch.failed', "Couldn't switch this conversation to the CLI.")
  )
}

/** Moves a chat's conversation into a terminal on the same id: the host stops the idle chat, the
 *  terminal opens in the chat's slot, then the chat tab closes. `chatTabId` null opens a new tab. */
export async function runNativeChatCliSwitch(args: {
  sessionId: string
  workspaceId: string
  executionHostId: string
  agent: AiVaultAgent
  chatTabId: string | null
  onComplete?: () => void
}): Promise<void> {
  const target = structuredAgentSessionTargetForHost(args.executionHostId)
  const hostId = parseExecutionHostId(args.executionHostId)?.id
  if (pending.has(args.sessionId) || !target || !hostId) {
    return
  }
  pending.add(args.sessionId)
  changed()
  try {
    // Fail closed: a host that doesn't advertise the switch never receives it.
    if (!(await supportsInPlaceSwitch(target, args.agent))) {
      throw new Error(nativeChatCliSwitchFailureText(null, args.agent))
    }
    const answered = await callStructuredAgentSession<{ source: unknown }>(
      target,
      'agentSession.switchToTerminal',
      { sessionId: args.sessionId }
    )
    const source = AiVaultChatForkSourceSchema.parse(answered.source)
    const state = useAppStore.getState()
    const startup = buildAiVaultResumeStartupForWorktree({
      state,
      worktreeId: args.workspaceId,
      session: { ...source, executionHostId: hostId },
      commandOverride: state.settings?.agentCmdOverrides?.[source.agent]
    })
    const launch = launchAiVaultSessionInNewTab({
      agent: source.agent,
      worktreeId: args.workspaceId,
      ...startup,
      ...(args.chatTabId ? { afterTabId: args.chatTabId } : {}),
      resumeOrigin: 'switch'
    })
    const outcome = launch.tabId === null ? await launch.runtimeLaunch : null
    if (outcome && outcome.status !== 'created') {
      throw new Error(outcome.status === 'failed' ? outcome.message : undefined)
    }
    if (launch.tabId && adoptsCliConversations(source.agent)) {
      seedSwitchedTerminalConversation(launch.tabId, {
        agent: source.agent,
        providerSessionId: source.sessionId,
        executionHostId: hostId
      })
    }
    // The terminal exists, so the chat tab retires; its host close finds the agent already stopped.
    if (args.chatTabId) {
      useAppStore.getState().closeUnifiedTab(args.chatTabId)
    }
  } catch (error) {
    toast.error(nativeChatCliSwitchFailureText(error, args.agent))
  } finally {
    pending.delete(args.sessionId)
    changed()
    args.onComplete?.()
  }
}
