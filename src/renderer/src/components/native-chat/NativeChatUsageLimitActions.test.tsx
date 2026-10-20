// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatUsageLimitActionsProvider } from './NativeChatUsageLimitActions'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import type { NativeChatOrcaStopView } from './native-chat-orca-stop-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const mocks = vi.hoisted(() => ({
  readSnapshot: {
    providerSession: { key: 'session_id', id: 'provider-chat', transcriptPath: '/work/chat.jsonl' }
  },
  follows: true,
  snapshot: vi.fn(),
  select: vi.fn(),
  dialog: vi.fn()
}))
vi.mock('./structured-agent-session-read-owner', () => ({
  getStructuredAgentSessionReadOwner: () => ({
    subscribe: () => () => {},
    getSnapshot: () => mocks.readSnapshot
  })
}))
vi.mock('@/runtime/use-host-structured-agent', () => ({
  useHostStructuredAgent: () => ({ followsAccountSelection: mocks.follows })
}))
vi.mock('@/runtime/use-worktree-runtime-target', () => ({
  useActiveAccountOwner: () => ({
    target: { kind: 'environment', environmentId: 'other' },
    wslHostDistro: null
  })
}))
vi.mock('@/lib/windows-terminal-capabilities', () => ({
  getWindowsTerminalCapabilityOwnerKey: () => 'local',
  useWindowsTerminalCapabilities: () => ({ wslDistros: [] })
}))
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot: mocks.snapshot,
  selectClaudeProviderAccount: mocks.select
}))
vi.mock('@/lib/claude-account-switch-sessions', () => ({
  handleRunningClaudeSessionsAfterSwitch: vi.fn()
}))
vi.mock('@/components/agent-session-continuation/AgentSessionContinuationDialog', () => ({
  AgentSessionContinuationDialog: (props: unknown) => {
    mocks.dialog(props)
    return null
  }
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.follows = true
})

function row(target: RuntimeClientTarget = { kind: 'local' }, offered = true) {
  const view: NativeChatOrcaStopView = {
    hostLabel: null,
    remoteHost: target.kind !== 'local',
    continueAvailable: false,
    offeredTurnItemId: null,
    continueNow: vi.fn(),
    usageLimitTurnItemId: offered ? 'cut' : null,
    continueUsageLimit: vi.fn()
  }
  return (
    <TooltipProvider>
      <NativeChatUsageLimitActionsProvider
        view={view}
        loading={false}
        pane={{
          tabId: 'tab',
          sessionId: 'chat',
          agent: 'claude',
          target,
          isVisible: true,
          isFocusedGroup: true
        }}
        directory={{
          worktreeId: 'folder',
          worktreePath: '/work',
          runtimeEnvironmentId: target.kind === 'environment' ? target.environmentId : null
        }}
        messages={[]}
      >
        <NativeChatNoticeRow
          agentName="Claude"
          block={{
            type: 'text',
            text: 'Limited',
            tone: 'warning',
            failure: { kind: 'usageLimitReached' },
            usageLimitTurnItemId: 'cut'
          }}
        />
      </NativeChatUsageLimitActionsProvider>
    </TooltipProvider>
  )
}
function snapshot(count: number) {
  return {
    claude: {
      activeAccountId: 'a0',
      accounts: Array.from({ length: count }, (_, index) => ({
        id: `a${index}`,
        email: `account${index}@example.com`,
        authMethod: 'subscription-oauth',
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }))
    }
  }
}

it('uses the existing local switcher, opens this chat in the hand-off dialog, and hides actions after sending', async () => {
  mocks.snapshot.mockResolvedValue(snapshot(2))
  mocks.select.mockResolvedValue(snapshot(2).claude)
  const original = useAppStore.getState().fetchSettings
  useAppStore.setState({ fetchSettings: vi.fn() })
  try {
    const view = render(row())
    expect(screen.getByRole('button', { name: 'Switch Account' })).toBeDisabled()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Switch Account' })).toBeEnabled()
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Switch Account' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse'
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'account1@example.com' }))
    await waitFor(() =>
      expect(mocks.select).toHaveBeenCalledWith(
        { kind: 'local' },
        { accountId: 'a1', runtime: 'host', wslDistro: null }
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Hand Off to Another Agent' }))
    expect(mocks.dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          worktreeId: 'folder',
          source: expect.objectContaining({
            transcriptPath: '/work/chat.jsonl',
            sourceAgent: 'claude'
          })
        })
      })
    )
    view.rerender(row({ kind: 'local' }, false))
    expect(screen.queryByRole('button', { name: 'Continue Now' })).toBeNull()
    expect(screen.queryByText('Continue this chat without waiting:')).toBeNull()
  } finally {
    useAppStore.setState({ fetchSettings: original })
  }
})

it('opens the existing accounts settings section for a single signed-in account', async () => {
  mocks.snapshot.mockResolvedValue(snapshot(1))
  const original = useAppStore.getState()
  const openSettingsPage = vi.fn(),
    openSettingsTarget = vi.fn()
  useAppStore.setState({ openSettingsPage, openSettingsTarget })
  try {
    render(row())
    fireEvent.click(await screen.findByRole('button', { name: 'Add Account…' }))
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'accounts',
      repoId: null,
      sectionId: 'accounts-claude'
    })
    expect(openSettingsPage).toHaveBeenCalledOnce()
  } finally {
    useAppStore.setState({
      openSettingsPage: original.openSettingsPage,
      openSettingsTarget: original.openSettingsTarget
    })
  }
})

it('offers only hand-off when the host does not declare account following or the chat is remote', () => {
  mocks.follows = false
  const view = render(row())
  expect(screen.getByRole('button', { name: 'Hand Off to Another Agent' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: /Account/ })).toBeNull()
  mocks.follows = true
  view.rerender(row({ kind: 'environment', environmentId: 'remote' }))
  expect(screen.queryByRole('button', { name: /Account/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Hand Off to Another Agent' })).toBeEnabled()
})
