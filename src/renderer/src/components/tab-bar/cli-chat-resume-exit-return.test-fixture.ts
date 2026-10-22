import { expect, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  makeTerminalTab,
  TEST_REPO,
  makeWorktree
} from '@/store/slices/worktrees-slice-test-fixtures'
import type { StructuredAgentSessionCreateParams } from '../../../../shared/structured-agent-session-create'
import type { CliChatResumeTestMocks } from './cli-chat-resume-run.test'
import { resolveCliChatResumeSource } from './cli-chat-resume-source'
import { canPaneOfferResumeInNewChat } from './tab-session-history-switch'
import { collectAgentPaneConversations } from '@/lib/ai-vault-tab-title-requests'
import { adoptsCliConversations } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { inPlaceSwitchSupportedNow } from '@/lib/in-place-switch-support'
import { switchAiVaultSessionToNativeChat } from '../right-sidebar/ai-vault-session-in-place-switch'
import { installPaneAgentIdentity } from '../terminal-pane/pty-connection/pane-agent-identity'
import { installSleepingRecordAccess } from '../terminal-pane/pty-connection/sleeping-record-access'
import type { ConnectPanePtySession } from '../terminal-pane/pty-connection/connect-pane-pty-session'
import {
  createMockTransport,
  createPane,
  createManager,
  LEAF_1,
  LEAF_2
} from '../terminal-pane/pty-connection-test-pane-fixtures'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { CLOSE_TERMINAL_PANE_EVENT, type CloseTerminalPaneDetail } from '@/constants/terminal'

export async function verifyExitedPaneHistoryReturn(
  mocks: CliChatResumeTestMocks,
  redrawFromMain: () => Promise<void>,
  settleMain: () => Promise<void>,
  deferred: <T>() => { promise: Promise<T>; resolve: (value: T) => void }
): Promise<void> {
  const tabs = () => useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []
  mocks.realSource = true
  mocks.switchCapability.mockResolvedValue(true)
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [makeWorktree({ id: 'wt-1', repoId: 'repo1' })] },
    tabsByWorktree: { 'wt-1': [makeTerminalTab({ id: 'shell', worktreeId: 'wt-1' })] },
    terminalLayoutsByTabId: {
      shell: {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: LEAF_1 },
          second: { type: 'leaf', leafId: LEAF_2 }
        },
        activeLeafId: LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'pty-1', [LEAF_2]: 'pty-2' }
      }
    }
  })
  const pinned = useAppStore
    .getState()
    .createUnifiedTab('wt-1', 'editor', { entityId: 'pinned', isPinned: true })
  const source = useAppStore
    .getState()
    .createUnifiedTab('wt-1', 'terminal', { id: 'shell', entityId: 'shell' })
  const next = useAppStore.getState().createUnifiedTab('wt-1', 'editor', { entityId: 'next' })
  await redrawFromMain()
  const paneKey = `shell:${LEAF_1}`
  const pane = { worktreeId: 'wt-1', paneKey }
  useAppStore
    .getState()
    .setAgentStatus(
      paneKey,
      { agentType: 'codex', state: 'working', prompt: 'CLI_OK' },
      undefined,
      undefined,
      { worktreeId: 'wt-1', tabId: 'shell' },
      { providerSession: { key: 'session_id', id: 'conversation-C' } }
    )
  const sibling = `shell:${LEAF_2}`
  useAppStore
    .getState()
    .setAgentStatus(
      sibling,
      { agentType: 'codex', state: 'working', prompt: 'D stays working' },
      undefined,
      undefined,
      { worktreeId: 'wt-1', tabId: 'shell' },
      { providerSession: { key: 'session_id', id: 'conversation-D' } }
    )
  const siblingStatus = useAppStore.getState().agentStatusByPaneKey[sibling]
  // The existing host exit row carries identity without claiming a running agent.
  useAppStore
    .getState()
    .recordAgentProviderSession(
      paneKey,
      'codex',
      { key: 'session_id', id: 'conversation-C' },
      undefined,
      {
        worktreeId: 'wt-1',
        tabId: 'shell'
      }
    )
  useAppStore.getState().setPaneForegroundAgent(paneKey, {
    agent: 'codex',
    agentEvidence: 'process-read',
    shellForeground: false
  })
  // SAFETY: these installers exercise only the real process-exit cleanup, with inert terminal I/O.
  const connection = {
    cacheKey: paneKey,
    pane: createPane(1),
    manager: createManager(1),
    deps: { tabId: 'shell', worktreeId: 'wt-1' },
    transport: createMockTransport('pty-1'),
    paneStartup: null,
    writeInputModeGround: vi.fn()
  } as unknown as ConnectPanePtySession
  installSleepingRecordAccess(connection)
  installPaneAgentIdentity(connection)
  connection.paneForegroundAgentTracker.onProcessExitConfirmed({
    agent: 'codex',
    processName: 'codex'
  })
  expect(useAppStore.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
  expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
  expect(
    collectAgentPaneConversations(useAppStore.getState(), adoptsCliConversations, {
      runningAgentsOnly: true
    })
  ).toMatchObject([{ providerSession: { id: 'conversation-D' } }])
  expect(
    collectAgentPaneConversations(useAppStore.getState(), adoptsCliConversations, {
      allPanes: true
    })
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        paneKey,
        providerSession: { key: 'session_id', id: 'conversation-C' }
      })
    ])
  )
  expect(canPaneOfferResumeInNewChat(useAppStore.getState(), pane)).toBe(true)
  expect(
    resolveCliChatResumeSource(useAppStore.getState(), {
      tab: { id: 'shell', worktreeId: 'wt-1' },
      paneKey
    })
  ).toMatchObject({ providerSessionId: 'conversation-C', paneKey, ptyId: 'pty-1' })
  const history: AiVaultSession = {
    id: 'history-C',
    sessionId: 'conversation-C',
    agent: 'codex',
    executionHostId: 'local',
    title: 'Conversation',
    cwd: null,
    branch: null,
    model: null,
    filePath: '',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '',
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'codex resume conversation-C',
    subagent: null
  }
  await vi.waitFor(() => expect(inPlaceSwitchSupportedNow('local', 'codex')).toBe(true))
  mocks.call.mockResolvedValueOnce({
    ok: false,
    refusal: {
      code: 'agent_session_identity_required',
      message: 'private host error',
      details: { reason: 'transcriptUnreadable' },
      createAttemptRefusedBeforeCommit: true
    }
  })
  expect(switchAiVaultSessionToNativeChat(history)).toBe(true)
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce())
  expect(tabs().map((tab) => tab.id)).toContain('shell')
  expect(mocks.rpc.mock.calls.some(([, method]) => method === 'terminal.close')).toBe(false)
  expect(canPaneOfferResumeInNewChat(useAppStore.getState(), pane)).toBe(true)

  const ready = deferred<unknown>()
  mocks.call.mockImplementation(
    async (_target, method, params: StructuredAgentSessionCreateParams) =>
      method === 'agentSession.switchToChat'
        ? ready.promise
        : { ok: true, value: { sessionId: params.envelope.sessionId, fence: 1 } }
  )
  const closed = vi.fn((event: Event) => {
    if (!(event instanceof CustomEvent)) {
      return
    }
    const detail: CloseTerminalPaneDetail = event.detail
    expect(detail).toMatchObject({
      tabId: 'shell',
      leafId: LEAF_1,
      expectedPtyId: 'pty-1',
      retireSurface: true
    })
    useAppStore.getState().retireAgentPaneAuthority(paneKey)
    useAppStore.setState({
      terminalLayoutsByTabId: {
        shell: {
          root: { type: 'leaf', leafId: LEAF_2 },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_2]: 'pty-2' }
        }
      }
    })
  })
  window.addEventListener(CLOSE_TERMINAL_PANE_EVENT, closed)
  try {
    expect(switchAiVaultSessionToNativeChat(history)).toBe(true)
    await vi.waitFor(() =>
      expect(
        mocks.call.mock.calls.some(([, method]) => method === 'agentSession.switchToChat')
      ).toBe(true)
    )
    expect(closed).not.toHaveBeenCalled()
    ready.resolve({ ok: true })
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
    await settleMain()
    const chat = tabs().find((tab) => tab.contentType === 'agent-session')!
    expect(
      useAppStore.getState().groupsByWorktree['wt-1'].find((group) => group.id === source.groupId)
        ?.tabOrder
    ).toEqual([pinned.id, source.id, chat.id, next.id])
    expect(chat.groupId).toBe(source.groupId)
    expect(chat.isPinned).not.toBe(true)
    expect(tabs().find((tab) => tab.id === pinned.id)?.isPinned).toBe(true)
    expect(useAppStore.getState().agentStatusByPaneKey[sibling]).toBe(siblingStatus)
    expect(useAppStore.getState().terminalLayoutsByTabId.shell.ptyIdsByLeafId).toEqual({
      [LEAF_2]: 'pty-2'
    })
    expect(
      collectAgentPaneConversations(useAppStore.getState(), adoptsCliConversations)
    ).toMatchObject([{ paneKey: sibling }])
    expect(useAppStore.getState().agentConversationsByPaneKey[paneKey]).toBeUndefined()
  } finally {
    window.removeEventListener(CLOSE_TERMINAL_PANE_EVENT, closed)
    connection.paneForegroundAgentTracker.dispose()
    connection.commandLifecycle.dispose()
  }
}
