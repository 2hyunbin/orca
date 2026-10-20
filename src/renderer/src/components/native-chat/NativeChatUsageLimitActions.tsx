import {
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useHostStructuredAgent } from '@/runtime/use-host-structured-agent'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import {
  buildAgentSessionContinuationPrompt,
  type AgentSessionContinuationRequest
} from '@/lib/agent-session-continuation'
import { ClaudeSwitcherMenu } from '@/components/status-bar/ClaudeSwitcherMenu'
import { CodexSwitcherMenu } from '@/components/status-bar/CodexSwitcherMenu'
import { ProviderAccountChatButton } from '@/components/status-bar/ProviderAccountChatButton'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { getStructuredAgentSessionReadOwner } from './structured-agent-session-read-owner'
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
  const disabled = view.usageLimitContinueDisabled === true || loading
  const owner = useMemo(
    () => getStructuredAgentSessionReadOwner(pane.sessionId, pane.target),
    [pane.sessionId, pane.target]
  )
  const { providerSession } = useSyncExternalStore(
    owner.subscribe,
    owner.getSnapshot,
    owner.getSnapshot
  )
  const declared = useHostStructuredAgent(pane.target, pane.agent)
  const [request, setRequest] = useState<AgentSessionContinuationRequest | null>(null)
  const continuation = useMemo((): AgentSessionContinuationRequest | null => {
    if (
      !active ||
      !directory ||
      !isTuiAgent(pane.agent) ||
      directory.runtimeEnvironmentId !==
        (pane.target.kind === 'environment' ? pane.target.environmentId : null)
    ) {
      return null
    }
    const source = {
      sourceAgent: pane.agent,
      sourceWorkingDirectory: directory.worktreePath,
      transcriptPath: providerSession?.transcriptPath,
      capturedText: providerSession?.transcriptPath
        ? ''
        : messages
            .map((message) => `${message.role}: ${nativeChatMessageCopyText(message)}`)
            .join('\n\n')
    }
    return buildAgentSessionContinuationPrompt(source, 'focused')
      ? {
          source,
          worktreeId: directory.worktreeId,
          workspacePath: directory.worktreePath,
          initialCwd: directory.worktreePath,
          groupId: pane.groupId,
          launchSource: 'sidebar'
        }
      : null
  }, [active, directory, messages, pane.agent, pane.groupId, pane.target, providerSession])
  let account: ReactNode = null
  if (pane.target.kind === 'local' && (pane.agent === 'claude' || pane.agent === 'codex')) {
    if (declared === undefined) {
      account = <ProviderAccountChatButton provider={pane.agent} disabled />
    } else if (declared.followsAccountSelection) {
      account =
        pane.agent === 'claude' ? (
          <ClaudeSwitcherMenu claude={null} compact iconOnly chatAction={{ disabled }} />
        ) : (
          <CodexSwitcherMenu codex={null} compact iconOnly chatAction={{ disabled }} />
        )
    }
  }
  const actions = useMemo(
    () => ({
      account,
      disabled,
      ...(continuation || (loading && isTuiAgent(pane.agent))
        ? {
            handOff: () => {
              if (continuation) {
                setRequest(continuation)
              }
            }
          }
        : {})
    }),
    [account, continuation, disabled, loading, pane.agent]
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
