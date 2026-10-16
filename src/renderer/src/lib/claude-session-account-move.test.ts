import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type * as localPreflightContext from '@/lib/local-preflight-context'
import type * as paneSelectionLane from './codex-pane-selection-lane'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/runtime-terminal-inspection'
import {
  cancelPendingClaudeSessionMoves,
  findMovableClaudeSessions,
  getPendingClaudeSessionMovePtyIdsForTests,
  moveClaudeSessionsToSelectedAccount
} from './claude-session-account-move'

const laneByPtyId: Record<string, string> = {}

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  confirmRuntimeTerminalForegroundProcess: vi.fn()
}))
vi.mock('@/lib/local-preflight-context', async (importOriginal) => ({
  ...(await importOriginal<typeof localPreflightContext>()),
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('./codex-pane-selection-lane', async (importOriginal) => ({
  ...(await importOriginal<typeof paneSelectionLane>()),
  resolveCodexPaneSelectionLane: ({ ptyId }: { ptyId: string }) => ({
    laneKey: laneByPtyId[ptyId] ?? 'host',
    source: 'derived',
    derivedLaneKey: null
  })
}))

const LOCAL = { kind: 'local' } as const
const HOST = { runtime: 'host' } as const
const SESSION_ID = '01a006a6-1d07-70a1-bad5-f9110d5845c0'

type SeededPane = {
  n: number
  agentType?: 'claude' | 'codex'
  state?: AgentStatusEntry['state']
  sessionId?: string | null
}

const tabId = (n: number): string => `tab-${n}`
const leafId = (n: number): string => `0195f2ce-1111-4000-8000-00000000000${n}`
const ptyId = (n: number): string => `pty-${n}`

function makeTab(n: number): TerminalTab {
  return {
    id: tabId(n),
    ptyId: ptyId(n),
    worktreeId: 'wt1',
    title: 'claude',
    customTitle: null,
    color: null,
    sortOrder: n,
    createdAt: n
  }
}

function seedPanes(panes: SeededPane[]): void {
  const statuses: Record<string, AgentStatusEntry> = {}
  for (const pane of panes) {
    if (!pane.agentType) {
      continue
    }
    const paneKey = makePaneKey(tabId(pane.n), leafId(pane.n))
    statuses[paneKey] = {
      paneKey,
      tabId: tabId(pane.n),
      state: pane.state ?? 'done',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: [],
      agentType: pane.agentType,
      ...(pane.sessionId === null
        ? {}
        : { providerSession: { key: 'session_id', id: pane.sessionId ?? SESSION_ID } })
    }
  }
  useAppStore.setState({
    settings: null as never,
    tabsByWorktree: { wt1: panes.map((pane) => makeTab(pane.n)) },
    ptyIdsByTabId: Object.fromEntries(panes.map((pane) => [tabId(pane.n), [ptyId(pane.n)]])),
    terminalLayoutsByTabId: Object.fromEntries(
      panes.map((pane) => [
        tabId(pane.n),
        {
          root: { type: 'leaf', leafId: leafId(pane.n) },
          activeLeafId: leafId(pane.n),
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId(pane.n)]: ptyId(pane.n) }
        }
      ])
    ),
    agentStatusByPaneKey: statuses,
    agentLaunchConfigByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    pendingPaneAccountRestarts: {}
  })
}

function setPaneState(n: number, state: AgentStatusEntry['state']): void {
  const paneKey = makePaneKey(tabId(n), leafId(n))
  const current = useAppStore.getState().agentStatusByPaneKey
  useAppStore.setState({
    agentStatusByPaneKey: { ...current, [paneKey]: { ...current[paneKey], state } }
  })
}

const movable = async (target: { runtime: 'host' | 'wsl'; wslDistro?: string } = HOST) =>
  (await findMovableClaudeSessions({ owner: LOCAL, target })).map((pane) => pane.ptyId)

describe('findMovableClaudeSessions', () => {
  beforeEach(() => {
    for (const key of Object.keys(laneByPtyId)) {
      delete laneByPtyId[key]
    }
    // Why the version name: the native macOS install reports its version folder, not `claude`.
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: '2.1.258',
      hasChildProcesses: true
    })
    vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue('claude')
  })

  it('finds resumable Claude panes and skips other agents and session-less panes', async () => {
    seedPanes([
      { n: 1, agentType: 'claude' },
      { n: 2, agentType: 'codex' },
      { n: 3, agentType: 'claude', sessionId: null },
      { n: 4 }
    ])

    expect(await movable()).toEqual([ptyId(1)])
  })

  it('keeps a host switch off WSL panes and a WSL switch on its own distro', async () => {
    seedPanes([
      { n: 1, agentType: 'claude' },
      { n: 2, agentType: 'claude' },
      { n: 3, agentType: 'claude' }
    ])
    laneByPtyId[ptyId(2)] = 'wsl:Ubuntu'
    laneByPtyId[ptyId(3)] = 'wsl:Debian'

    expect(await movable()).toEqual([ptyId(1)])
    expect(await movable({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toEqual([ptyId(2)])
  })

  it('never offers a move for a remote-server switch or SSH panes', async () => {
    seedPanes([{ n: 1, agentType: 'claude' }])
    expect(
      await findMovableClaudeSessions({
        owner: { kind: 'environment', environmentId: 'env-1' },
        target: HOST
      })
    ).toEqual([])

    laneByPtyId[ptyId(1)] = 'ssh-connection'
    expect(await movable()).toEqual([])
  })

  it('skips a pane where Claude has exited to the shell', async () => {
    seedPanes([{ n: 1, agentType: 'claude' }])
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    })
    vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue('zsh')

    expect(await movable()).toEqual([])
  })
})

describe('moveClaudeSessionsToSelectedAccount', () => {
  const candidate = (n: number) => ({ ptyId: ptyId(n), tabId: tabId(n), leafId: leafId(n) })

  afterEach(() => {
    cancelPendingClaudeSessionMoves()
  })

  it('restarts idle sessions now and holds a mid-reply session until its turn ends', () => {
    seedPanes([
      { n: 1, agentType: 'claude', state: 'done' },
      { n: 2, agentType: 'claude', state: 'waiting' },
      { n: 3, agentType: 'claude', state: 'working' }
    ])

    moveClaudeSessionsToSelectedAccount([candidate(1), candidate(2), candidate(3)])

    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({
      [ptyId(1)]: 'claude',
      [ptyId(2)]: 'claude'
    })
    expect(getPendingClaudeSessionMovePtyIdsForTests()).toEqual([ptyId(3)])

    setPaneState(3, 'done')

    expect(useAppStore.getState().pendingPaneAccountRestarts[ptyId(3)]).toBe('claude')
    expect(getPendingClaudeSessionMovePtyIdsForTests()).toEqual([])
  })

  it('holds a session at a permission prompt until its turn ends', () => {
    seedPanes([{ n: 1, agentType: 'claude', state: 'blocked' }])

    moveClaudeSessionsToSelectedAccount([candidate(1)])
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})

    setPaneState(1, 'done')
    expect(useAppStore.getState().pendingPaneAccountRestarts[ptyId(1)]).toBe('claude')
  })

  it('drops a waiting session whose pane closes', () => {
    seedPanes([{ n: 1, agentType: 'claude', state: 'working' }])
    moveClaudeSessionsToSelectedAccount([candidate(1)])

    useAppStore.setState({ ptyIdsByTabId: { [tabId(1)]: [] } })
    setPaneState(1, 'done')

    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
    expect(getPendingClaudeSessionMovePtyIdsForTests()).toEqual([])
  })

  it('drops a waiting session when the user switches again', () => {
    seedPanes([{ n: 1, agentType: 'claude', state: 'working' }])
    moveClaudeSessionsToSelectedAccount([candidate(1)])

    cancelPendingClaudeSessionMoves()
    setPaneState(1, 'done')

    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  })
})
