import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import { useStructuredChatTabConversationName } from '@/runtime/structured-conversation-name'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import {
  buildAgentSessionContinuationPrompt,
  type AgentSessionContinuationRequest
} from '@/lib/agent-session-continuation'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import { nativeChatMessageCopyText } from './native-chat-message-copy-text'

export type NativeChatHandOff = {
  /** This chat can seed another agent from its owning workspace. */
  available: boolean
  preparing: boolean
  open: () => void
  /** Drops a pending or open hand-off, e.g. when the conversation it describes moves on. */
  reset: () => void
  /** Identity of the current cut; another async check compares it to detect a superseded one. */
  currentIntent: () => object | null
  dialog: ReactNode
}

export function useNativeChatHandOff({
  pane,
  directory,
  messages,
  invalidation = [],
  avoidSourceAgent = false
}: {
  pane: Pick<
    NativeChatStructuredViewProps,
    'tabId' | 'groupId' | 'sessionId' | 'target' | 'agent' | 'isVisible'
  >
  directory: NativeChatFileLinkContext | null
  messages: readonly NativeChatMessage[]
  /** Facts whose change makes a pending hand-off describe a conversation that moved on. */
  invalidation?: readonly unknown[]
  avoidSourceAgent?: boolean
}): NativeChatHandOff {
  const intentKey = JSON.stringify([
    executionHostIdForStructuredTarget(pane.target),
    pane.sessionId,
    pane.agent,
    pane.isVisible,
    ...invalidation
  ])
  const intent = useRef<{ key: string; pending: boolean } | null>(null)
  const [preparing, setPreparing] = useState<string | null>(null)
  useLayoutEffect(() => {
    const current = { key: intentKey, pending: false }
    intent.current = current
    setPreparing(null)
    return () => {
      if (intent.current === current) {
        intent.current = null
      }
    }
  }, [intentKey])
  const chatTab = useAppStore((state) =>
    directory
      ? state.unifiedTabsByWorktree[directory.worktreeId]?.find((tab) => tab.id === pane.tabId)
      : undefined
  )
  const conversationName = useStructuredChatTabConversationName(chatTab)
  const [prepared, setPrepared] = useState<{
    key: string
    request: AgentSessionContinuationRequest
  } | null>(null)
  const request = prepared?.key === intentKey ? prepared.request : null
  // The dialog launches in the chat's workspace, so it must be the same host the chat runs on.
  const available = Boolean(
    pane.isVisible &&
    directory &&
    isTuiAgent(pane.agent) &&
    directory.runtimeEnvironmentId ===
      (pane.target.kind === 'environment' ? pane.target.environmentId : null)
  )
  const reset = useCallback(() => {
    intent.current = { key: intentKey, pending: false }
    setPreparing(null)
    setPrepared(null)
  }, [intentKey])
  const prepare = useCallback(async (): Promise<void> => {
    if (!available || !directory || !isTuiAgent(pane.agent)) {
      return
    }
    const current = intent.current
    if (!current || current.pending) {
      return
    }
    current.pending = true
    setPreparing(current.key)
    // Read on demand so a chat created after mount still hands off its saved transcript.
    const options = await callStructuredAgentSession<AgentSessionOptionsResult>(
      pane.target,
      'agentSession.options',
      { sessionId: pane.sessionId }
    ).catch((error: unknown) => {
      console.warn('Could not read saved chat context for hand-off', error)
      return null
    })
    if (intent.current !== current) {
      return
    }
    setPreparing(null)
    const transcriptPath = options?.transcriptPath
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
      setPrepared({
        key: current.key,
        request: {
          source,
          worktreeId: directory.worktreeId,
          workspacePath: directory.worktreePath,
          initialCwd: directory.worktreePath,
          groupId: pane.groupId,
          launchSource: 'native_chat',
          ...(avoidSourceAgent ? { avoidSourceAgent: true } : {})
        }
      })
    } else {
      current.pending = false
    }
  }, [
    available,
    avoidSourceAgent,
    directory,
    pane.agent,
    pane.groupId,
    pane.sessionId,
    pane.target,
    chatTab,
    conversationName,
    messages
  ])
  const open = useCallback(() => {
    void prepare()
  }, [prepare])
  return {
    available,
    preparing: preparing === intentKey,
    open,
    reset,
    currentIntent: () => intent.current,
    dialog: request ? (
      <AgentSessionContinuationDialog
        open
        request={request}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            intent.current = { key: intentKey, pending: false }
            setPrepared(null)
          }
        }}
      />
    ) : null
  }
}
