import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeRepo, makeTerminalTab, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { makeAgentStatusEntry } from '@/runtime/sync-runtime-graph-test-harness'
import { collectAiVaultTitleRequests } from '@/lib/ai-vault-tab-title-requests'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  canPaneOfferResumeInNewChat,
  resolveTabSessionSelectedSource,
  resolveTabSessionSwitch,
  type TabSessionSelectedSource
} from './tab-session-selected-source'

const mocks = vi.hoisted(() => {
  const state: {
    resumeState: { blocked: boolean; worktreeId: string | null }
    platform: string
  } = { resumeState: { blocked: false, worktreeId: 'repo-1::/repo/wt' }, platform: 'darwin' }
  return { ...state, resumeInChat: vi.fn() }
})

// Staged host answers: its capabilities arrive over IPC at boot, and the platform from preload.
vi.mock('@/runtime/local-runtime-capabilities', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLocalRuntimeCapabilitiesOrUnknown: () => [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}))
vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => mocks.platform }))

// Parity with the panel's real composition is pinned in tab-session-selected-source.parity.test.ts.
vi.mock('../right-sidebar/ai-vault-session-resume-in-chat-workspace', () => ({
  resolveAiVaultHistoryRowResume: () => ({
    resumeState: { ...mocks.resumeState, usesSessionWorktree: true },
    resumeInChat: mocks.resumeInChat()
  })
}))

const WORKTREE_ID = 'repo-1::/repo/wt'

function row(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'row-1',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'claude-session-1',
    title: 'Fix the build',
    cwd: '/repo/wt',
    branch: 'main',
    model: null,
    filePath: '/home/.claude/projects/repo/claude-session-1.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-10-08T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 10,
    previewMessages: [{ role: 'user', text: 'Fix the build', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume claude-session-1',
    subagent: null,
    ...overrides
  }
}

const SIBLING_ID = 'repo-1::/repo/sibling'

function makeState(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey'] = {},
  repo: Partial<ReturnType<typeof makeRepo>> = {}
): AppState {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    agentStatusByPaneKey,
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    repos: [{ ...makeRepo(), ...repo }],
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTerminalTab('term-1', WORKTREE_ID, 'claude')]
    },
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(WORKTREE_ID, 'wt', { path: '/repo/wt' }),
        makeWorktree(SIBLING_ID, 'sibling', { path: '/repo/sibling' })
      ]
    }
  })
  return useAppStore.getState()
}

// What the Session History panel sends for this workspace: every path of its project, at the
// panel's default depth, on the workspace's own host.
const PANEL_REQUEST = {
  scopePaths: ['/repo/wt', '/repo/sibling', '/repos/repo-1'],
  executionHostScope: 'local',
  sessionLimit: 250
} as const

const liveClaudeEntry = {
  'term-1:leaf-1': makeAgentStatusEntry({
    agentType: 'claude',
    paneKey: 'term-1:leaf-1',
    tabId: 'term-1',
    worktreeId: WORKTREE_ID,
    providerSession: { key: 'session_id', id: 'claude-session-1' }
  })
}

const chatSubject: TabSessionSelectedSource = {
  kind: 'chat',
  agent: 'codex',
  sessionId: 'orca-chat-1',
  workspaceId: WORKTREE_ID,
  executionHostId: 'local',
  legacyListRequest: PANEL_REQUEST
}

const cliSubject: TabSessionSelectedSource = {
  kind: 'cli',
  agent: 'claude',
  paneKey: 'term-1:leaf-1',
  providerSessionId: 'claude-session-1',
  workspaceId: WORKTREE_ID,
  executionHostId: 'local',
  legacyListRequest: PANEL_REQUEST
}

beforeEach(() => {
  mocks.resumeState = { blocked: false, worktreeId: WORKTREE_ID }
  mocks.platform = 'darwin'
  mocks.resumeInChat.mockReset()
})

// What Orca remembers once the agent exits and the pane is back at its shell prompt.
const exitedAgentRecords: Record<string, Partial<AppState>> = {
  retained: {
    retainedAgentsByPaneKey: {
      'term-1:leaf-1': {
        entry: liveClaudeEntry['term-1:leaf-1'],
        worktreeId: WORKTREE_ID,
        tab: makeTerminalTab('term-1', WORKTREE_ID, 'claude'),
        agentType: 'claude',
        startedAt: 1
      }
    }
  },
  sleeping: {
    sleepingAgentSessionsByPaneKey: {
      'term-1:leaf-1': {
        paneKey: 'term-1:leaf-1',
        tabId: 'term-1',
        worktreeId: WORKTREE_ID,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session-1' },
        prompt: '',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
    }
  }
}

describe('resolveTabSessionSelectedSource', () => {
  it('finds a native chat tab by the chat it shows', () => {
    expect(
      resolveTabSessionSelectedSource(makeState(), {
        tab: { id: 'unified-1', worktreeId: WORKTREE_ID },
        nativeChat: { sessionId: 'orca-chat-1', agent: 'codex' }
      })
    ).toEqual({ ...chatSubject })
  })

  it('finds a chat of any agent whose CLI can open a copy', () => {
    expect(
      resolveTabSessionSelectedSource(makeState(), {
        tab: { id: 'unified-1', worktreeId: WORKTREE_ID },
        nativeChat: { sessionId: 'orca-chat-1', agent: 'grok' }
      })
    ).toEqual({ ...chatSubject, agent: 'grok' })
  })

  it.each(['opencode', 'omp'] as const)(
    'skips a %s chat, whose CLI cannot open a copy',
    (agent) => {
      expect(
        resolveTabSessionSelectedSource(makeState(), {
          tab: { id: 'unified-1', worktreeId: WORKTREE_ID },
          nativeChat: { sessionId: 'orca-chat-1', agent }
        })
      ).toBeNull()
    }
  )

  it('finds a terminal tab by the conversation its agent reported', () => {
    expect(
      resolveTabSessionSelectedSource(makeState(liveClaudeEntry), {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID }
      })
    ).toEqual(cliSubject)
  })

  it('finds an agent a restart reattached to before it reports again', () => {
    const [[paneKey, entry]] = Object.entries(liveClaudeEntry)
    expect(
      resolveTabSessionSelectedSource(
        makeState({ [paneKey]: { ...entry, restoredUnconfirmed: true } }),
        { tab: { id: 'term-1', worktreeId: WORKTREE_ID } }
      )
    ).toEqual(cliSubject)
  })

  it.each(Object.keys(exitedAgentRecords))(
    'offers nothing from a %s record once the agent has exited, though the tab title keeps it',
    (kind) => {
      makeState()
      useAppStore.setState(exitedAgentRecords[kind])
      const state = useAppStore.getState()
      expect(
        resolveTabSessionSelectedSource(state, { tab: { id: 'term-1', worktreeId: WORKTREE_ID } })
      ).toBeNull()
      expect(collectAiVaultTitleRequests(state)).toEqual([
        expect.objectContaining({
          tabId: 'term-1',
          providerSession: { key: 'session_id', id: 'claude-session-1' }
        })
      ])
    }
  )

  it("prefers a split pane's running agent over the focused pane's exited one", () => {
    makeState({
      'term-1:leaf-2': makeAgentStatusEntry({
        agentType: 'claude',
        paneKey: 'term-1:leaf-2',
        tabId: 'term-1',
        worktreeId: WORKTREE_ID,
        providerSession: { key: 'session_id', id: 'claude-session-1' }
      })
    })
    const exited = makeAgentStatusEntry({
      agentType: 'claude',
      paneKey: 'term-1:leaf-1',
      tabId: 'term-1',
      worktreeId: WORKTREE_ID,
      providerSession: { key: 'session_id', id: 'claude-session-old' }
    })
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'term-1': { root: null, activeLeafId: 'leaf-1', expandedLeafId: null }
      },
      retainedAgentsByPaneKey: {
        'term-1:leaf-1': {
          entry: exited,
          worktreeId: WORKTREE_ID,
          tab: makeTerminalTab('term-1', WORKTREE_ID, 'claude'),
          agentType: 'claude',
          startedAt: exited.stateStartedAt
        }
      }
    })
    expect(
      resolveTabSessionSelectedSource(useAppStore.getState(), {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID }
      })
    ).toEqual({ ...cliSubject, paneKey: 'term-1:leaf-2' })
  })

  it('looks nothing up over SSH, where neither move is ever offered', () => {
    const state = makeState(liveClaudeEntry, { connectionId: 'dev-box' })
    expect(
      resolveTabSessionSelectedSource(state, {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID }
      })
    ).toBeNull()
    expect(
      resolveTabSessionSelectedSource(state, {
        tab: { id: 'unified-1', worktreeId: WORKTREE_ID },
        nativeChat: { sessionId: 'orca-chat-1', agent: 'claude' }
      })
    ).toBeNull()
  })

  it('looks a chat up on a remote Orca server, which owns its chats, but never a CLI there', () => {
    const state = makeState(liveClaudeEntry, {
      executionHostId: 'runtime:server-1'
    })
    expect(
      resolveTabSessionSelectedSource(state, {
        tab: { id: 'unified-1', worktreeId: WORKTREE_ID },
        nativeChat: { sessionId: 'orca-chat-1', agent: 'claude' }
      })
    ).toMatchObject({
      kind: 'chat',
      executionHostId: 'runtime:server-1',
      legacyListRequest: { executionHostScope: 'runtime:server-1' }
    })
    expect(
      resolveTabSessionSelectedSource(state, {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID }
      })
    ).toBeNull()
  })

  it('skips a plain shell tab', () => {
    expect(
      resolveTabSessionSelectedSource(makeState(), {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID }
      })
    ).toBeNull()
  })
})

describe('one pane of a terminal tab', () => {
  const claudePane = 'term-1:leaf-1'
  const grokPane = 'term-1:leaf-2'
  const splitTab = (activeLeafId: string): AppState => {
    makeState({
      [claudePane]: liveClaudeEntry['term-1:leaf-1'],
      [grokPane]: makeAgentStatusEntry({
        agentType: 'grok',
        paneKey: grokPane,
        tabId: 'term-1',
        worktreeId: WORKTREE_ID,
        providerSession: { key: 'session_id', id: 'grok-session-1' }
      })
    })
    useAppStore.setState({
      terminalLayoutsByTabId: { 'term-1': { root: null, activeLeafId, expandedLeafId: null } }
    })
    return useAppStore.getState()
  }
  const paneSubject = (state: AppState, paneKey: string) =>
    resolveTabSessionSelectedSource(state, {
      tab: { id: 'term-1', worktreeId: WORKTREE_ID },
      paneKey
    })
  const paneGate = (state: AppState, paneKey: string) =>
    canPaneOfferResumeInNewChat(state, { worktreeId: WORKTREE_ID, paneKey })

  it("never stands in a sibling pane's conversation for a pane with no move", () => {
    const state = splitTab('leaf-2')
    // The tab as a whole maps to the Claude pane; the Grok pane on its own has nothing.
    expect(
      resolveTabSessionSelectedSource(state, { tab: { id: 'term-1', worktreeId: WORKTREE_ID } })
    ).toEqual(cliSubject)
    expect(paneSubject(state, grokPane)).toBeNull()
    expect(paneGate(state, grokPane)).toBe(false)
  })

  it("finds the pane's own conversation", () => {
    const state = splitTab('leaf-1')
    expect(paneSubject(state, claudePane)).toEqual(cliSubject)
    expect(paneGate(state, claudePane)).toBe(true)
  })

  it.each(Object.keys(exitedAgentRecords))(
    'offers nothing once the agent exited and only a %s record remains, as the tab menu does',
    (kind) => {
      makeState()
      useAppStore.setState(exitedAgentRecords[kind])
      const exited = useAppStore.getState()
      expect(paneSubject(exited, claudePane)).toBeNull()
      expect(paneGate(exited, claudePane)).toBe(false)
      expect(
        resolveTabSessionSelectedSource(exited, { tab: { id: 'term-1', worktreeId: WORKTREE_ID } })
      ).toBeNull()
    }
  )

  it('offers nothing where the project runs in WSL, whose chat route is refused', () => {
    mocks.platform = 'win32'
    const onWindows = (
      localWindowsRuntimeDefault: { kind: 'wsl'; distro: string } | { kind: 'windows-host' }
    ) => {
      makeState(liveClaudeEntry)
      useAppStore.setState({
        settings: { ...getDefaultSettings('C:\\Users\\me'), localWindowsRuntimeDefault }
      })
      return useAppStore.getState()
    }
    const tabSubject = (state: AppState) =>
      resolveTabSessionSelectedSource(state, { tab: { id: 'term-1', worktreeId: WORKTREE_ID } })
    expect(paneGate(onWindows({ kind: 'windows-host' }), claudePane)).toBe(true)
    expect(tabSubject(onWindows({ kind: 'windows-host' }))).toEqual(cliSubject)
    expect(paneGate(onWindows({ kind: 'wsl', distro: 'Ubuntu' }), claudePane)).toBe(false)
    expect(tabSubject(onWindows({ kind: 'wsl', distro: 'Ubuntu' }))).toBeNull()
  })

  it('offers nothing over SSH', () => {
    expect(paneGate(makeState(liveClaudeEntry, { connectionId: 'dev-box' }), claudePane)).toBe(
      false
    )
  })
})

describe('resolveTabSessionSwitch', () => {
  const chatRow = row({
    structuredSession: { sessionId: 'orca-chat-1', workspaceId: WORKTREE_ID }
  })

  it('offers Resume in New CLI on a chat tab whose row can fork', () => {
    expect(resolveTabSessionSwitch(makeState(), chatRow, chatSubject)).toEqual({
      action: 'resume-in-new-cli',
      worktreeId: WORKTREE_ID
    })
  })

  it('hides Resume in New CLI for an empty or unresumable chat', () => {
    expect(
      resolveTabSessionSwitch(
        makeState(),
        { ...chatRow, messageCount: 0, previewMessages: [] },
        chatSubject
      )
    ).toBeNull()
    mocks.resumeState = { blocked: true, worktreeId: null }
    expect(resolveTabSessionSwitch(makeState(), chatRow, chatSubject)).toBeNull()
  })

  it('offers Resume in New Native Chat where the row is eligible, in the workspace it names', () => {
    mocks.resumeInChat.mockReturnValue({
      available: true,
      workspaceId: WORKTREE_ID
    })
    expect(resolveTabSessionSwitch(makeState(), row(), cliSubject)).toEqual({
      action: 'resume-in-new-chat',
      worktreeId: WORKTREE_ID
    })
    mocks.resumeInChat.mockReturnValue({ available: false, reason: 'empty' })
    expect(resolveTabSessionSwitch(makeState(), row(), cliSubject)).toBeNull()
  })
})
