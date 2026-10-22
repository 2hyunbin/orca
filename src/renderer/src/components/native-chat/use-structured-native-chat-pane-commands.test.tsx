/**
 * @vitest-environment happy-dom
 */
import React, { createRef, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as I18n from '@/i18n/i18n'
import type { AppState } from '@/store'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import type { NativeChatComposerHandle } from './NativeChatComposer'
import { useStructuredNativeChatPaneCommands } from './use-structured-native-chat-pane-commands'

type ItemProps = { onSelect?: () => void; children?: ReactNode }

const items = vi.hoisted(() => ({ list: [] as ItemProps[] }))
const callRuntimeRpc = vi.hoisted(() => vi.fn())
const handOff = vi.hoisted(() => ({ options: vi.fn(), dialog: vi.fn() }))

vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => children
  return {
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: (props: ItemProps) => {
      items.list.push(props)
      return props.children
    },
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuShortcut: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuTrigger: Pass
  }
})
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/ui/tooltip', () => {
  const Pass = ({ children }: { children?: ReactNode }) => children
  return { Tooltip: Pass, TooltipTrigger: Pass, TooltipContent: () => null }
})
vi.mock('@/components/tab-bar/TabWorkspaceLayoutMenuSection', () => ({
  TabWorkspaceLayoutMenuSection: () => null
}))
vi.mock('@/components/tab-bar/tab-move-to-pane-column', () => ({
  canMoveTabToNewPaneColumn: () => false
}))
vi.mock('@/store', () => ({
  useAppStore: (
    select: (state: Pick<AppState, 'keybindings' | 'unifiedTabsByWorktree'>) => unknown
  ) => select({ keybindings: {}, unifiedTabsByWorktree: {} })
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: handOff.options
}))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => 'Fix the login bug'
}))
vi.mock('@/components/agent-session-continuation/AgentSessionContinuationDialog', () => ({
  AgentSessionContinuationDialog: (props: { request: AgentSessionContinuationRequest }) => {
    handOff.dialog(props)
    return null
  }
}))
vi.mock('../../runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc
}))

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const TARGET = { kind: 'environment', environmentId: 'env_1' } as const

function childrenText(children: ReactNode): string {
  return React.Children.toArray(children)
    .map((child) =>
      typeof child === 'string'
        ? child
        : React.isValidElement<{ children?: ReactNode }>(child)
          ? childrenText(child.props.children)
          : ''
    )
    .join('')
}

function StructuredChatTab({ inWorkspace = false }: { inWorkspace?: boolean }): ReactNode {
  const { menu } = useStructuredNativeChatPaneCommands({
    pane: {
      tabId: 'chat-tab',
      groupId: 'group-1',
      isVisible: true,
      isFocusedGroup: true,
      sessionId: SESSION,
      target: TARGET,
      agent: 'codex'
    },
    messages: [],
    rootRef: createRef<HTMLDivElement>(),
    composerRef: createRef<NativeChatComposerHandle>(),
    questionAnswerInputRef: createRef<HTMLInputElement>(),
    ...(inWorkspace
      ? {
          fileLinkContext: {
            worktreeId: 'wt-1',
            worktreePath: '/work/repo',
            runtimeEnvironmentId: 'env_1'
          }
        }
      : {})
  })
  return menu
}

describe('a structured chat tab', () => {
  beforeEach(() => {
    items.list = []
    callRuntimeRpc.mockReset().mockResolvedValue({ orcaSessionId: `orca_session_id:${SESSION}` })
    Object.assign(window, {
      api: { ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) } }
    })
  })

  it("offers Copy Orca Session ID, asking the tab's host for this session's Orca session ID", async () => {
    renderToStaticMarkup(<StructuredChatTab />)

    const item = items.list.find(
      (candidate) => childrenText(candidate.children) === 'Copy Orca Session ID'
    )
    item?.onSelect?.()

    expect(item).toBeDefined()
    await vi.waitFor(() =>
      expect(callRuntimeRpc).toHaveBeenCalledWith(TARGET, 'orchestration.sessionAddress', {
        sessionId: SESSION
      })
    )
  })

  it("hands the conversation to another agent with the chat's saved transcript", async () => {
    handOff.options.mockResolvedValue({ transcriptPath: '/work/codex.jsonl' })
    render(<StructuredChatTab inWorkspace />)

    const item = items.list.findLast(
      (candidate) => childrenText(candidate.children) === 'Hand Off to Another Agent'
    )
    await act(async () => item?.onSelect?.())

    expect(handOff.options).toHaveBeenCalledWith(TARGET, 'agentSession.options', {
      sessionId: SESSION
    })
    await waitFor(() =>
      expect(handOff.dialog).toHaveBeenLastCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            source: expect.objectContaining({
              sourceAgent: 'codex',
              sourceTitle: 'Fix the login bug',
              transcriptPath: '/work/codex.jsonl'
            }),
            worktreeId: 'wt-1',
            launchSource: 'native_chat'
          })
        })
      )
    )
    expect(handOff.dialog.mock.lastCall?.[0].request).not.toHaveProperty('avoidSourceAgent')
  })
})
