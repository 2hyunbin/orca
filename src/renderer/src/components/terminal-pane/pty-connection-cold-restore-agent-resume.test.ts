import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { RESET_GRAPHIC_RENDITION } from '../../../../shared/terminal-mode-reset-profiles'
import { flushAsyncTicks } from './pty-connection-test-async'
import { UUID_RE } from './pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { ConnectCallbacks, MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Why: the working→idle test invokes the real useNotificationDispatch hook outside React, so useCallback must pass through (safe suite-wide: no test here renders React).
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

// Why: stub only getEagerPtyBufferHandle so tests can simulate a live eager buffer (adopt path) without standing up the real IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

const PANE_KEY = makePaneKey('tab-1', LEAF_1)
const CODEX_SESSION = { key: 'session_id', id: 'codex-session-1' }
const CODEX_RESUME_COMMAND =
  "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'"

function codexRecord(fields: { state: string; origin?: string }) {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: CODEX_SESSION,
    prompt: '',
    capturedAt: 1,
    updatedAt: 1,
    ...fields
  }
}

function codexStatus(state: string) {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agentType: 'codex',
    state,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    providerSession: CODEX_SESSION
  }
}

/** A restored tab whose pane names a PTY its daemon no longer holds. */
function setRestoredPaneState(
  agents: Pick<StoreState, 'agentStatusByPaneKey' | 'sleepingAgentSessionsByPaneKey'>
): void {
  Object.assign(mockStoreState, {
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }] },
    settings: { ...mockStoreState.settings, agentCmdOverrides: {} },
    ...agents
  })
}

let lastConnectCallbacks: ConnectCallbacks | undefined

function queueColdRestoreTransport(ptyId: string, result: Record<string, unknown> = {}) {
  const transport = createMockTransport(ptyId)
  transport.connect.mockImplementation(
    async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
      lastConnectCallbacks = callbacks
      return sessionId
        ? { id: ptyId, coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }, ...result }
        : ptyId
    }
  )
  transportFactoryQueue.push(transport)
  return transport
}

async function connectRestoredPane(ptyId: string): Promise<void> {
  const { connectPanePty } = await import('./pty-connection')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
  const args = [
    createPane(1),
    createManager(1),
    createDeps({ restoredLeafId: LEAF_1, restoredPtyIdByLeafId: { [LEAF_1]: ptyId } })
  ] as unknown as Parameters<typeof connectPanePty>
  connectPanePty(...args)
  await flushAsyncTicks(20)
  await new Promise((resolve) => setTimeout(resolve, 70))
}

describe('connectPanePty', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })
  it('resumes the provider agent session when daemon reattach cold-restores a fresh shell', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'finish the task',
          agentType: 'codex',
          paneKey,
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: {
            key: 'session_id',
            id: 'codex-session-1',
            transcriptPath: '/Users/example/.codex/sessions/2026/07/20/rollout-session.jsonl'
          }
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith(
      `${RESET_GRAPHIC_RENDITION}cold-payload`,
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('--- session restored ---'),
      expect.any(Function)
    )
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'",
        resumeProviderSession: {
          key: 'session_id',
          id: 'codex-session-1',
          transcriptPath: '/Users/example/.codex/sessions/2026/07/20/rollout-session.jsonl'
        },
        env: expect.objectContaining({
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
  })

  it('uses WSL quoting for cold-restored agent resume in Windows-path WSL projects', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: 'C:\\tmp\\wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {},
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      },
      projects: [
        {
          id: 'repo1',
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }
      ],
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: 'C:\\tmp\\wt-1',
            displayName: 'feat/notis'
          }
        ]
      },
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'finish the task',
          agentType: 'codex',
          paneKey,
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: { key: 'session_id', id: "codex-session-1's" }
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith(
      `${RESET_GRAPHIC_RENDITION}cold-payload`,
      expect.any(Function)
    )
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: `codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'"'"'s'`,
        env: expect.objectContaining({
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
  })

  it('resumes from the quit-captured sleeping record when cold-restoring after an app restart', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const transcriptPath =
      '\\\\?\\C:\\Users\\Example\\.codex\\sessions\\2026\\07\\20\\rollout-codex-session-1.jsonl'
    // Why: after restart agentStatusByPaneKey is empty — the persisted sleeping record is the only provider session id source (#5232).
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: {
            key: 'session_id',
            id: 'codex-session-1',
            transcriptPath
          },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith(
      `${RESET_GRAPHIC_RENDITION}cold-payload`,
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('--- session restored ---'),
      expect.any(Function)
    )
    const writeCalls = pane.terminal.write.mock.calls.map(([data]) => data)
    expect(writeCalls.findIndex((data) => data.includes('--- session restored ---'))).toBe(-1)
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'restored')
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'",
        resumeProviderSession: {
          key: 'session_id',
          id: 'codex-session-1',
          transcriptPath
        },
        env: expect.objectContaining({
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
    // Why: an originless record reads as hibernation, so the running pane gets a pane-owned one.
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
      paneKey,
      origin: 'quit',
      providerSession: { id: 'codex-session-1', transcriptPath }
    })
  })

  it('resumes a silent agent again when its terminal dies a second time before its next turn', async () => {
    // Why revert-sensitive: Codex reports its session only on its next turn, so a resume that
    // consumed the record left the pane with nothing to resume after a second daemon death.
    setRestoredPaneState({
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: codexRecord({ state: 'done', origin: 'quit' }) }
    })

    for (const ptyId of ['lost-pty', 'lost-again-pty']) {
      const transport = queueColdRestoreTransport(ptyId)
      await connectRestoredPane(ptyId)

      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: ptyId, command: CODEX_RESUME_COMMAND })
      )
    }
  })

  it('leaves a resume record behind a mid-turn agent resumed from its live row', async () => {
    // Why: workspace activation clears a working pane's record in favour of its live row, which
    // an app restart does not bring back for an agent that stays silent after resuming.
    setRestoredPaneState({
      agentStatusByPaneKey: {
        [PANE_KEY]: { ...codexStatus('working'), connectionId: null }
      },
      sleepingAgentSessionsByPaneKey: {}
    })
    const transport = queueColdRestoreTransport('lost-pty')
    await connectRestoredPane('lost-pty')

    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ command: CODEX_RESUME_COMMAND })
    )
    // Why connectionId: the wrong-host guards read it after a restart, when no live row is left.
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
      worktreeId: 'wt-1',
      agent: 'codex',
      providerSession: { id: 'codex-session-1' },
      connectionId: null,
      launchConfig: expect.anything()
    })
    // The registration made for this launch survives the record write.
    expect(mockStoreState.agentLaunchConfigByPaneKey[PANE_KEY]).toBeDefined()
  })

  it('keeps the launch registration of a pane resumed from its own record', async () => {
    setRestoredPaneState({
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: codexRecord({ state: 'done', origin: 'quit' }) }
    })
    queueColdRestoreTransport('lost-pty')
    await connectRestoredPane('lost-pty')

    expect(mockStoreState.agentLaunchConfigByPaneKey[PANE_KEY]).toBeDefined()
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
      origin: 'quit'
    })
  })

  it('clears the kept record once the resumed agent exits to a confirmed shell', async () => {
    // Why: the kept record must not outlive the agent, or the next restore relaunches one the user quit.
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('zsh')
    setRestoredPaneState({
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: codexRecord({ state: 'done', origin: 'quit' }) }
    })
    queueColdRestoreTransport('lost-pty')
    await connectRestoredPane('lost-pty')
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeDefined()

    lastConnectCallbacks?.onData?.('\x1b]133;D;0\x07')
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('does not resume a finished agent whose record is gone, as after the user quit it', async () => {
    // Why: a confirmed shell clears the record but leaves the finished row on screen, so the row
    // alone must never relaunch an agent the user deliberately exited.
    setRestoredPaneState({
      agentStatusByPaneKey: { [PANE_KEY]: codexStatus('done') },
      sleepingAgentSessionsByPaneKey: {}
    })
    const transport = queueColdRestoreTransport('lost-pty')
    await connectRestoredPane('lost-pty')

    expect(transport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ command: expect.anything() })
    )
  })

  it('drops the record when main started a new session instead of resuming it', async () => {
    setRestoredPaneState({
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: codexRecord({ state: 'working' }) }
    })
    queueColdRestoreTransport('lost-pty', { agentResumeUnavailable: true })
    await connectRestoredPane('lost-pty')

    expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
    // The new session's launch registration is not collateral.
    expect(mockStoreState.agentLaunchConfigByPaneKey[PANE_KEY]).toBeDefined()
  })

  it('replaces a pane-owned record naming another session with the one just resumed', async () => {
    // Why: once the live row is gone after a restart, the stale record would resume the old session.
    setRestoredPaneState({
      agentStatusByPaneKey: { [PANE_KEY]: codexStatus('working') },
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: {
          ...codexRecord({ state: 'done', origin: 'quit' }),
          providerSession: { key: 'session_id', id: 'codex-session-old' }
        }
      }
    })
    const transport = queueColdRestoreTransport('lost-pty')
    await connectRestoredPane('lost-pty')

    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ command: CODEX_RESUME_COMMAND })
    )
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
      origin: 'quit',
      providerSession: { id: 'codex-session-1' }
    })
  })

  it('replaces a worktree-sleep record with a pane-owned one after an in-place resume', async () => {
    // Why: a hibernation record on a running pane would let an empty reattach retire it.
    setRestoredPaneState({
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: codexRecord({ state: 'done', origin: 'worktree-sleep' })
      }
    })
    queueColdRestoreTransport('lost-pty')
    await connectRestoredPane('lost-pty')

    expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
      origin: 'quit',
      providerSession: { id: 'codex-session-1' }
    })
    expect(mockStoreState.agentLaunchConfigByPaneKey[PANE_KEY]).toBeDefined()
  })

  it('marks the pane as freshly started when main declined an unverifiable resume', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        // Why: main dropped `resume <id>` because it could not verify which Codex
        // account owns the rollout, so this PTY is a new session, not a restore.
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' },
          agentResumeUnavailable: true as const
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'resume-unavailable')
  })

  it('resumes from an unambiguous legacy sleeping record when cold-restoring a preserved pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const legacyPaneKey = 'tab-1:2'
    const duplicateLegacyPaneKey = 'tab-1:3'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [legacyPaneKey]: {
          paneKey: legacyPaneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        },
        [duplicateLegacyPaneKey]: {
          paneKey: duplicateLegacyPaneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 2,
          updatedAt: 2
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith(
      `${RESET_GRAPHIC_RENDITION}cold-payload`,
      expect.any(Function)
    )
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'restored')
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'"
      })
    )
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(legacyPaneKey)
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(duplicateLegacyPaneKey)
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[legacyPaneKey]).toBeUndefined()
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[duplicateLegacyPaneKey]).toBeUndefined()
  })

  it('does not choose a non-exact legacy record when same-tab provider sessions differ', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const firstLegacyPaneKey = 'tab-1:2'
    const secondLegacyPaneKey = 'tab-1:3'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [firstLegacyPaneKey]: {
          paneKey: firstLegacyPaneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        },
        [secondLegacyPaneKey]: {
          paneKey: secondLegacyPaneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-2' },
          prompt: 'finish another task',
          state: 'working',
          capturedAt: 2,
          updatedAt: 2
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith(
      `${RESET_GRAPHIC_RENDITION}cold-payload`,
      expect.any(Function)
    )
    expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
    expect(transport.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining('resume') })
    )
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
  })
})
