import { useState } from 'react'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../right-sidebar/AiVaultSessionSurfaceSwitchMenuItems'
import {
  resolveTabSessionHistorySubject,
  type NativeChatTabSession
} from './tab-session-history-switch'
import { runNativeChatCliFork, useNativeChatCliForkPending } from './native-chat-cli-fork-run'
import { useInPlaceSwitchSupported } from '@/lib/in-place-switch-support'
import { runNativeChatCliSwitch, useNativeChatCliSwitchPending } from './native-chat-cli-switch-run'

/** "Switch to CLI" where the chat's host switches its agent in place; otherwise the fork. */
export function NativeChatCliForkMenuItems({
  tab,
  nativeChat,
  leadingSeparator,
  onComplete
}: {
  tab: { id: string; worktreeId: string }
  nativeChat: NativeChatTabSession
  leadingSeparator: boolean
  onComplete?: () => void
}): React.JSX.Element | null {
  const [subject] = useState(() =>
    resolveTabSessionHistorySubject(useAppStore.getState(), { tab, nativeChat })
  )
  const chat = subject?.kind === 'chat' ? subject : null
  const forkPending = useNativeChatCliForkPending(chat)
  const switchPending = useNativeChatCliSwitchPending(chat?.sessionId)
  const commandOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === nativeChat.agent)
  const inPlace = useInPlaceSwitchSupported(chat?.request.executionHostScope, agent)
  if (!chat || !agent) {
    return null
  }
  return (
    <>
      {leadingSeparator ? <DropdownMenuSeparator /> : null}
      <AiVaultSessionSurfaceSwitchMenuItems
        action="switch"
        menuKind="dropdown"
        tooltipSide="right"
        cliPending={inPlace ? switchPending : forkPending}
        {...(inPlace ? { inPlaceAgent: agent } : {})}
        onResumeInNewCli={(event) => {
          event.preventDefault()
          void (inPlace
            ? runNativeChatCliSwitch({
                sessionId: chat.sessionId,
                workspaceId: chat.workspaceId,
                executionHostId: chat.request.executionHostScope,
                agent,
                chatTabId: tab.id,
                onComplete
              })
            : runNativeChatCliFork({ subject: chat, tab, agent, commandOverrides, onComplete }))
        }}
      />
    </>
  )
}
