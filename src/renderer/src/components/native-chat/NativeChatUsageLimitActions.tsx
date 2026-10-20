import { createContext, useContext, useState, type ReactNode } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useStructuredChatTabConversationName } from '@/runtime/structured-conversation-name'
import { useHostStructuredAgent } from '@/runtime/use-host-structured-agent'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import {
  buildAgentSessionContinuationPrompt,
  type AgentSessionContinuationRequest
} from '@/lib/agent-session-continuation'
import { ClaudeSwitcherMenu } from '@/components/status-bar/ClaudeSwitcherMenu'
import { ProviderAccountChatButton } from '@/components/status-bar/ProviderAccountChatButton'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { AgentSessionHistoryResult } from '../../../../shared/agent-session-wire'
import {
  NativeChatOrcaStopContext,
  type NativeChatOrcaStopView
} from './native-chat-orca-stop-context'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import { nativeChatMessageCopyText } from './native-chat-message-copy-text'

type UsageLimitActions = { account: ReactNode; handOff?: () => void; disabled: boolean }
const UsageLimitActionsContext = createContext<UsageLimitActions | null>(null)

export function NativeChatUsageLimitActionsProvider({
  pane,
  directory,
  messages,
  view,
  loading,
  children
}: {
  pane: Omit<NativeChatStructuredViewProps, 'mode'>
  directory: NativeChatFileLinkContext | null
  messages: readonly NativeChatMessage[]
  view: NativeChatOrcaStopView
  loading: boolean
  children: ReactNode
}): React.JSX.Element {
  const active = view.usageLimitTurnItemId !== null
  const disabled = loading
  const chatTab = useAppStore((state) =>
    directory
      ? state.unifiedTabsByWorktree[directory.worktreeId]?.find((tab) => tab.id === pane.tabId)
      : undefined
  )
  const conversationName = useStructuredChatTabConversationName(chatTab)
  const declared = useHostStructuredAgent(pane.target, pane.agent)
  const [request, setRequest] = useState<AgentSessionContinuationRequest | null>(null)
  const canHandOff =
    active &&
    directory &&
    isTuiAgent(pane.agent) &&
    directory.runtimeEnvironmentId ===
      (pane.target.kind === 'environment' ? pane.target.environmentId : null)
  let account: ReactNode = null
  if (pane.agent === 'claude') {
    if (declared === undefined) {
      account = <ProviderAccountChatButton provider="claude" target={pane.target} disabled />
    } else if (declared.followsAccountSelection) {
      account = (
        <ClaudeSwitcherMenu claude={null} compact iconOnly chatAction={{ target: pane.target }} />
      )
    }
  }
  const openHandOff = useCallback(async (): Promise<void> => {
    if (!canHandOff || !directory || !isTuiAgent(pane.agent)) {
      return
    }
    const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
      pane.target,
      'agentSession.history',
      { sessionId: pane.sessionId, direction: 'tail', limit: 1 }
    ).catch((error: unknown) => {
      console.warn('Could not read saved chat context for hand-off', error)
      return null
    })
    const transcriptPath = history?.providerSession?.transcriptPath
    const source = {
      sourceKind: 'chat' as const,
      sourceAgent: pane.agent,
      sourceTitle: chatTab?.customLabel?.trim() || conversationName || chatTab?.label,
      sourceWorkingDirectory: directory.worktreePath,
      transcriptPath,
      capturedText: transcriptPath
        ? ''
        : messages
            .map((message) => `${message.role}: ${nativeChatMessageCopyText(message)}`)
            .join('\n\n')
    }
    if (buildAgentSessionContinuationPrompt(source, 'focused')) {
      setRequest({
        source,
        worktreeId: directory.worktreeId,
        workspacePath: directory.worktreePath,
        initialCwd: directory.worktreePath,
        groupId: pane.groupId,
        launchSource: 'native_chat',
        avoidSourceAgent: true
      })
    }
  }, [
    canHandOff,
    directory,
    pane.agent,
    pane.groupId,
    pane.sessionId,
    pane.target,
    chatTab,
    conversationName,
    messages
  ])
  const actions = useMemo<UsageLimitActions>(
    () => ({
      account,
      disabled,
      ...(canHandOff || (loading && isTuiAgent(pane.agent))
        ? {
            handOff: () => {
              void openHandOff()
            }
          }
        : {})
    }),
    [account, canHandOff, disabled, loading, openHandOff, pane.agent]
  )
  return (
    <UsageLimitActionsContext.Provider value={actions}>
      <NativeChatOrcaStopContext.Provider value={view}>
        {children}
      </NativeChatOrcaStopContext.Provider>
      {request ? (
        <AgentSessionContinuationDialog
          open
          request={request}
          onOpenChange={(open) => {
            if (!open) {
              setRequest(null)
            }
          }}
        />
      ) : null}
    </UsageLimitActionsContext.Provider>
  )
}

export function NativeChatUsageLimitActions(): React.JSX.Element | null {
  const actions = useContext(UsageLimitActionsContext)
  if (!actions || (!actions.account && !actions.handOff)) {
    return null
  }
  return (
    <div className="ml-6 space-y-2 text-chat-foreground-faint">
      <p className="text-xs">
        {translate(
          'components.native-chat.usageLimitActions.leadIn',
          'Continue this chat without waiting:'
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {actions.account}
        {actions.handOff ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={actions.disabled}
            onClick={actions.handOff}
          >
            <MessageSquarePlus />
            {translate(
              'components.agentSessionContinuation.handOffToAnotherAgent',
              'Hand Off to Another Agent'
            )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
