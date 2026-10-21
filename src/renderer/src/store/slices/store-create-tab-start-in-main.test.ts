import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import type { AppState } from '../types'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { provideLayoutFrameTerminalPanes } from '@/runtime/layout-frame-terminal-panes'
import {
  peekMainStartedPaneView,
  resetMainStartedPaneViewsForTests
} from '../terminals/main-started-pane-view'
import {
  agentStartupDeliveryKey,
  clearConsumedAgentStartupDeliveriesForTests,
  isAgentStartupDeliveryConsumed
} from '@/lib/agent-startup-delivery-guards'

type HeldCreate = { resolve: (value: unknown) => void; reject: (error: Error) => void }

const mocks = vi.hoisted(() => {
  const held: { layoutOwnerIsMain: boolean; create: HeldCreate | null } = {
    layoutOwnerIsMain: true,
    create: null
  }
  return Object.assign(held, { callRuntimeRpc: vi.fn() })
})

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WORKTREE = 'repo1::/path/wt'
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB}:${LEAF}`

function storeWithWorktree() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt' })] },
    groupsByWorktree: {
      [WORKTREE]: [{ id: 'group-1', worktreeId: WORKTREE, activeTabId: null, tabOrder: [] }]
    },
    activeGroupIdByWorktree: { [WORKTREE]: 'group-1' },
    unifiedTabsByWorktree: {}
  })
  return store
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function terminalCreateCalls() {
  return mocks.callRuntimeRpc.mock.calls.filter((call) => call[1] === 'terminal.create')
}

/** Main's frame draws the pane bound to the terminal it started. */
function drawBinding(store: ReturnType<typeof createTestStore>, ptyId: string) {
  const layout = store.getState().terminalLayoutsByTabId[TAB]!
  store.setState({
    terminalLayoutsByTabId: {
      ...store.getState().terminalLayoutsByTabId,
      [TAB]: { ...layout, ptyIdsByLeafId: { [LEAF]: ptyId } }
    }
  })
}

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.create = null
  mocks.callRuntimeRpc.mockReset()
  mocks.callRuntimeRpc.mockImplementation(async (_target: unknown, method: string) => {
    if (method === 'terminal.create') {
      return new Promise((resolve, reject) => {
        mocks.create = { resolve, reject }
      })
    }
    return { ok: true, result: { tabId: TAB } }
  })
  provideLayoutFrameTerminalPanes({ holdsTerminalPane: () => false, terminalTab: () => undefined })
})

describe("a new tab's first terminal, started by main in a layout-owner build", () => {
  it('waits, asks main to start it in the tab main wrote, then lets the pane attach', async () => {
    const store = storeWithWorktree()

    store.getState().createTab(WORKTREE, undefined, undefined, {
      id: TAB,
      initialLeafId: LEAF,
      startupCwd: '/path/wt/src',
      pendingStartup: { command: 'make dev', env: { FOO: '1' } }
    })

    // The pane mounts waiting: it starts no terminal of its own.
    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toEqual({ status: 'starting' })
    expect(mocks.callRuntimeRpc.mock.calls[0]?.[1]).toBe('layout.apply')
    await settle()
    expect(terminalCreateCalls()).toEqual([
      [
        { kind: 'local' },
        'terminal.create',
        {
          worktree: `id:${WORKTREE}`,
          windowTab: true,
          tabId: TAB,
          leafId: LEAF,
          cwd: '/path/wt/src',
          command: 'make dev',
          env: { FOO: '1' }
        }
      ]
    ])
    // Main runs the startup; a remount of the pane must not run it again.
    expect(store.getState().pendingStartupByTabId[TAB]).toBeUndefined()

    mocks.create!.resolve({ terminal: { ptyId: 'pty-main' } })
    await settle()
    // Until main's binding is drawn, the pane keeps waiting, so it never spawns a second one.
    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toEqual({ status: 'starting' })
    drawBinding(store, 'pty-main')
    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('shows why when main could not start it, as a start that timed out does', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, { id: TAB, initialLeafId: LEAF })
    await settle()

    mocks.create!.reject(new Error('Request timed out: createOrAttach'))
    await settle()

    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toEqual({
      status: 'failed',
      reason: 'Request timed out: createOrAttach'
    })
    expect(store.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([TAB])
  })

  it('lets the pane attach to whatever main binds it to', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, {
      id: TAB,
      initialLeafId: LEAF,
      pendingStartup: { command: 'make dev' }
    })
    await settle()
    mocks.create!.resolve({ terminal: { ptyId: 'pty-main' } })
    await settle()

    // Main rebound the pane before the window drew its first terminal.
    drawBinding(store, 'pty-rebound')
    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('never runs a failed start’s startup again, which main may have run before failing', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, {
      id: TAB,
      initialLeafId: LEAF,
      pendingStartup: { command: 'make dev' }
    })
    await settle()

    mocks.create!.reject(new Error('shell not found'))
    await settle()

    expect(store.getState().pendingStartupByTabId[TAB]).toBeUndefined()
  })

  it('attaches to the terminal that won the pane instead of showing a failure', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, { id: TAB, initialLeafId: LEAF })
    await settle()

    mocks.create!.reject(new Error('terminal_pane_owner_changed'))
    await settle()

    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('starts its own terminal, with its startup, when main does not hold the tab', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, {
      id: TAB,
      initialLeafId: LEAF,
      pendingStartup: { command: 'make dev' }
    })
    await settle()

    mocks.create!.reject(new Error('host_not_owned'))
    await settle()

    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toBeUndefined()
    expect(store.getState().pendingStartupByTabId[TAB]).toMatchObject({ command: 'make dev' })
  })

  it('gives no startup back to a tab the user closed before main answered', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, {
      id: TAB,
      initialLeafId: LEAF,
      pendingStartup: { command: 'make dev' }
    })
    await settle()
    const { [TAB]: _closed, ...layouts } = store.getState().terminalLayoutsByTabId
    store.setState({ terminalLayoutsByTabId: layouts })

    mocks.create!.reject(new Error('host_not_owned'))
    await settle()

    expect(store.getState().pendingStartupByTabId[TAB]).toBeUndefined()
  })

  it('keeps the window spawn for a tab that already has a terminal', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, { initialPtyId: 'pty-live' })
    await settle()

    expect(store.getState().terminalPaneStartsByPaneKey).toEqual({})
    expect(terminalCreateCalls()).toEqual([])
  })

  // PR-3b deletes the predicate and must carry this shell to main's create (no UI makes one today).
  it('keeps the window spawn for a tab with a shell that is not a Windows shell', async () => {
    const store = storeWithWorktree()
    const tab = store.getState().createTab(WORKTREE, undefined, '/bin/fish', {
      id: TAB,
      initialLeafId: LEAF
    })
    await settle()

    expect(tab.shellOverride).toBe('/bin/fish')
    expect(store.getState().terminalPaneStartsByPaneKey).toEqual({})
    expect(terminalCreateCalls()).toEqual([])
  })

  it('sends nothing to start with the build switch off', async () => {
    mocks.layoutOwnerIsMain = false
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, { id: TAB, initialLeafId: LEAF })
    await settle()

    expect(store.getState().terminalPaneStartsByPaneKey).toEqual({})
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})

const CODEX_DRAFT_DELIVERY = agentStartupDeliveryKey({
  worktreeId: WORKTREE,
  tabId: TAB,
  launchToken: 'token-1'
})
const LAUNCH_CONFIG = { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
const TELEMETRY = {
  agent_kind: 'codex',
  launch_source: 'new_workspace_composer',
  request_kind: 'new'
} as const

/** The params main's create gets for a startup, after the ids every start sends. */
type TabStartup = AppState['pendingStartupByTabId'][string]

async function startParamsFor(startup: TabStartup) {
  const store = storeWithWorktree()
  store.getState().createTab(WORKTREE, undefined, undefined, {
    id: TAB,
    initialLeafId: LEAF,
    pendingStartup: startup
  })
  await settle()
  const [{ worktree: _w, windowTab: _t, tabId: _tab, leafId: _leaf, ...params }] =
    terminalCreateCalls().map((call): Record<string, unknown> => ({ ...call[2] }))
  return { store, params }
}

describe('every start input of a new tab reaches main’s create (L252)', () => {
  beforeEach(() => {
    resetMainStartedPaneViewsForTests()
    clearConsumedAgentStartupDeliveriesForTests()
  })

  it.each<{ name: string; startup: TabStartup; params: Record<string, unknown> }>([
    {
      name: 'telemetry, which main records once its spawn commits',
      startup: { command: 'codex', launchAgent: 'codex', telemetry: TELEMETRY },
      params: { command: 'codex', launchAgent: 'codex', telemetry: TELEMETRY }
    },
    {
      name: 'an agent launch, which main plans as the pane’s own spawn did',
      startup: {
        command: '',
        launchAgent: 'claude',
        agentLaunch: {
          launch: { agent: 'claude', target: { kind: 'existing', worktree: `id:${WORKTREE}` } }
        }
      },
      params: {
        launchAgent: 'claude',
        agentLaunch: {
          launch: { agent: 'claude', target: { kind: 'existing', worktree: `id:${WORKTREE}` } }
        }
      }
    },
    {
      name: 'agent args and session options, already in the built command',
      startup: {
        command: "claude --model 'opus'",
        launchAgent: 'claude',
        agentArgsOverride: null,
        sessionOptions: { model: 'opus' }
      },
      params: { command: "claude --model 'opus'", launchAgent: 'claude' }
    },
    {
      name: 'an OpenCode model start, planned by main as createAgentSession planned it',
      startup: {
        command: 'opencode',
        launchAgent: 'opencode',
        launchConfig: LAUNCH_CONFIG,
        agentArgsOverride: '--print-logs',
        sessionOptions: { model: 'opencode/m', effort: 'high' },
        draftPrompt: 'look at this'
      },
      params: {
        startupAgent: 'opencode',
        agentArgs: '--print-logs',
        launchPreferences: { model: 'opencode/m', effort: 'high' },
        startupPrompt: 'look at this',
        startupPromptDelivery: 'draft'
      }
    },
    {
      name: 'a draft a flag carries, already in the command, with no paste',
      startup: {
        command: "claude --prefill 'look'",
        launchAgent: 'claude',
        launchConfig: LAUNCH_CONFIG,
        draftPrompt: 'look'
      },
      params: {
        command: "claude --prefill 'look'",
        launchAgent: 'claude',
        launchConfig: LAUNCH_CONFIG,
        // createTab gives every launch-bound startup a token.
        launchToken: expect.any(String)
      }
    },
    {
      name: 'a Codex draft, which main pastes once Codex is ready',
      startup: {
        command: 'codex',
        launchAgent: 'codex',
        launchConfig: LAUNCH_CONFIG,
        launchToken: 'token-1',
        draftPrompt: 'look'
      },
      params: {
        command: 'codex',
        launchAgent: 'codex',
        launchConfig: LAUNCH_CONFIG,
        launchToken: 'token-1',
        draftPaste: { agent: 'codex', content: 'look' }
      }
    },
    {
      name: 'the view facts, which stay the window’s',
      startup: {
        command: 'cmd',
        launchAgent: 'command-code',
        initialAgentStatus: { agent: 'command-code', prompt: 'go' },
        showSessionRestoredBanner: true
      },
      params: { command: 'cmd', launchAgent: 'command-code' }
    }
  ])('$name', async ({ startup, params }) => {
    const { store, params: sent } = await startParamsFor(startup)
    expect(sent).toEqual(params)
    // Main runs it: the pane waits instead of spawning its own.
    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toEqual({ status: 'starting' })
    expect(store.getState().pendingStartupByTabId[TAB]).toBeUndefined()
  })

  it('keeps the start’s status prompt for the pane, which seeds it when it attaches', async () => {
    const startup: TabStartup = {
      command: 'cmd',
      launchAgent: 'command-code',
      launchConfig: LAUNCH_CONFIG,
      initialAgentStatus: { agent: 'command-code', prompt: 'go' }
    }
    await startParamsFor(startup)

    expect(peekMainStartedPaneView(PANE_KEY)).toEqual({
      initialAgentStatus: { agent: 'command-code', prompt: 'go' },
      launchConfig: LAUNCH_CONFIG,
      launchToken: expect.any(String)
    })
  })

  it('fences the delayed delivery of a Codex draft, so main’s paste is the only one', async () => {
    await startParamsFor({
      command: 'codex',
      launchAgent: 'codex',
      launchConfig: LAUNCH_CONFIG,
      launchToken: 'token-1',
      draftPrompt: 'look'
    })

    expect(isAgentStartupDeliveryConsumed(CODEX_DRAFT_DELIVERY)).toBe(true)
  })

  it('gives the whole startup back when main does not hold the tab', async () => {
    const startup: TabStartup = {
      command: 'codex',
      launchAgent: 'codex',
      launchConfig: LAUNCH_CONFIG,
      launchToken: 'token-1',
      draftPrompt: 'look',
      telemetry: TELEMETRY,
      agentArgsOverride: null,
      sessionOptions: { model: 'gpt' },
      initialAgentStatus: { agent: 'codex', prompt: 'look' },
      showSessionRestoredBanner: true
    }
    const { store } = await startParamsFor(startup)

    mocks.create!.reject(new Error('host_not_owned'))
    await settle()

    expect(store.getState().pendingStartupByTabId[TAB]).toEqual(startup)
    // The pane's own spawn seeds and pastes, as before.
    expect(peekMainStartedPaneView(PANE_KEY)).toBeUndefined()
    expect(isAgentStartupDeliveryConsumed(CODEX_DRAFT_DELIVERY)).toBe(false)
  })
})
