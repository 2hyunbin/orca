import type * as React from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import { createManager, createPane } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import {
  launchWorkspaceState,
  perClientLoader,
  type LaunchStoreHolder
} from '@/lib/launch-parity-renderer.test-fixture'
import { getDefaultSettings } from '../../../../shared/constants'
import { WINDOW_LAUNCH_CASES } from '../../../../shared/launch-parity-window-cases.test-fixture'
import { PLUS_LAUNCH_CASES } from '../../../../shared/launch-parity-plus-cases.test-fixture'
import { WORKSPACE_START_LAUNCH_CASES } from '../../../../shared/launch-parity-workspace-start-cases.test-fixture'
import {
  loadWorkspaceStartModules,
  startWorkspaceAgent
} from '@/lib/launch-parity-workspace-start.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { isWslShellName } from '../../../../shared/local-windows-terminal-runtime'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import {
  LAUNCH_LEAF_ID,
  LAUNCH_TAB_ID,
  LAUNCH_TOKEN,
  PANE_GRID,
  launchWorkspaceId,
  windowSpawnRequest,
  type WindowLaunchCase
} from '../../../../shared/launch-parity-window-request.test-fixture'

const windowTabCreates = vi.hoisted((): unknown[] => [])
// Main's answer to the window's layout commands, as a switch-on build sends them; a window tab's
// first start main runs is recorded, not started.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const client = (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
  return {
    ...client,
    callRuntimeRpc: (...args: Parameters<typeof client.callRuntimeRpc>) => {
      if (args[1] === 'terminal.create') {
        windowTabCreates.push(args[2])
        return new Promise(() => {})
      }
      return client.callRuntimeRpc(...args)
    }
  }
})

const holder = vi.hoisted((): LaunchStoreHolder => ({ store: null }))
vi.mock('@/store', async () =>
  (await import('@/lib/launch-parity-renderer.test-fixture')).launchStoreModuleMock(holder)
)
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})
vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle: () => false }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), message: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return { ...actual, useCallback: <T>(fn: T): T => fn }
})
// Row 8: what precedes the launch (setup policy and hooks trust) is decided, not asked.
vi.mock('@/lib/launch-work-item-direct-preflight', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveDirectSetupDecision: async () => ({ kind: 'decided', decision: 'inherit' })
}))
vi.mock('@/lib/ensure-hooks-confirmed', () => ({ ensureHooksConfirmed: async () => 'run' }))
vi.mock('@/lib/windows-terminal-capabilities', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasCachedWindowsTerminalCapabilities: () => true,
  getCachedWindowsTerminalCapabilities: () => ({
    wslAvailable: true,
    wslDistros: ['Ubuntu'],
    pwshAvailable: false,
    gitBashAvailable: false
  })
}))

const load = perClientLoader(async () => ({
  launch: await import('@/lib/launch-agent-in-new-tab'),
  quick: await import('@/lib/run-quick-command-in-new-tab'),
  vault: await import('@/lib/launch-ai-vault-session'),
  resume: await import('@/lib/ai-vault-resume-command'),
  dashboard: await import('@/components/dashboard/launch-dashboard-agent'),
  pane: await import('./pty-connection'),
  paneOptions: await import('./terminal-pane-manager-options'),
  defaults: await import('@/lib/pane-manager/pane-terminal-options'),
  lifecycle: await import('./terminal-pane-lifecycle-primitives'),
  workspaceStart: await loadWorkspaceStartModules(),
  startInMain: await import('@/store/terminals/window-tab-start-in-main')
}))

/** Runs the case's real producer against a real store; returns the tab it opened. */
async function openTab(c: WindowLaunchCase) {
  const modules = await load(c.client)
  await installTerminalTestGlobals()
  Object.assign(window.api.platform, { get: () => ({ platform: c.client, osRelease: '10' }) })
  const store = modules.createStore()
  holder.store = store
  store.setState(
    launchWorkspaceState(c.workspace, { ...getDefaultSettings('/home/alice'), ...c.settings })
  )
  const worktreeId = launchWorkspaceId(c.workspace)
  const producer = c.producer
  if (producer.kind === 'work-item' || producer.kind === 'folder-composer') {
    await startWorkspaceAgent(modules.workspaceStart, store, { ...c, producer })
  } else if (producer.kind === 'quick-command') {
    modules.quick.runQuickCommandInNewTab({
      command: { id: 'qc-1', label: 'Fix', action: 'agent-prompt', ...producer },
      worktreeId
    })
  } else if (producer.kind === 'continuation') {
    // What launchAgentSessionContinuation passes once the agent is detected.
    modules.launch.launchAgentInNewTab({
      requestId: `parity-${c.name}`,
      agent: producer.agent,
      worktreeId,
      prompt: producer.prompt,
      promptDelivery: 'draft',
      launchSource: 'terminal_context_menu',
      initialCwd: producer.initialCwd
    })
  } else if (producer.kind === 'plus' && producer.via === 'dashboard') {
    // Its workspace activation asks for a PR refresh, which this harness has no bridge for.
    Object.assign(window.api, { gh: {} })
    modules.dashboard.launchDashboardAgent({ worktreeId, agent: producer.agent })
  } else if (producer.kind === 'plus') {
    // Hand-built copies of what the "+" menu and the new-agent shortcut pass.
    modules.launch.launchAgentInNewTab({
      requestId: `parity-${c.name}`,
      agent: producer.agent,
      worktreeId,
      groupId: store.getState().activeGroupIdByWorktree[worktreeId],
      launchSource: producer.via === 'menu' ? 'tab_bar_quick_launch' : 'shortcut'
    })
  } else {
    // The sidebar's "continue from transcript" builds the startup, then opens the tab.
    const startup = modules.resume.buildAiVaultResumeStartupForWorktree({
      state: store.getState(),
      worktreeId,
      session: {
        agent: 'antigravity',
        sessionId: 'ide-id',
        codexHome: null,
        executionHostId: 'local',
        filePath: producer.transcript,
        cwd: producer.cwd
      }
    })
    modules.vault.launchAiVaultSessionInNewTab({ agent: 'antigravity', worktreeId, ...startup })
  }
  const tab = store.getState().tabsByWorktree[worktreeId]?.at(-1)
  if (!tab) {
    throw new Error(`${c.name}: the producer opened no tab`)
  }
  return { modules, store, worktreeId, tab }
}

/** A tab the window put in WSL keeps its own spawn (windowTabStartsInMain). */
function startsInMain(c: WindowLaunchCase): boolean {
  const cwd = c.request.cwd ?? c.workspace.path
  return (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    !isWslShellName(String(c.request.shellOverride ?? '')) &&
    !isWslUncPath(cwd)
  )
}

/**
 * Switch-on: the `terminal.create` a window tab's first start sends main in place of the pane's
 * spawn (L252) carries the same start facts; main adds the pane identity env, grid and fallback.
 */
function mainCreateParams(c: WindowLaunchCase): Record<string, unknown> {
  const spawn = windowSpawnRequest(c)
  // The tab's own startup cwd, which the pane's spawn falls back from to the workspace path.
  const cwd = c.request.cwd ?? (c.producer.kind === 'transcript-continue' ? c.producer.cwd : null)
  return {
    worktree: `id:${launchWorkspaceId(c.workspace)}`,
    windowTab: true,
    tabId: LAUNCH_TAB_ID,
    leafId: LAUNCH_LEAF_ID,
    ...(cwd ? { cwd } : {}),
    ...(c.request.shellOverride ? { shell: c.request.shellOverride } : {}),
    command: spawn.command,
    ...(spawn.startupCommandDelivery
      ? { startupCommandDelivery: spawn.startupCommandDelivery }
      : {}),
    env: c.request.agentEnv ?? {},
    launchConfig: spawn.launchConfig,
    launchToken: LAUNCH_TOKEN,
    launchAgent: spawn.launchAgent,
    telemetry: spawn.telemetry
  }
}

/**
 * Mounts the tab's pane the way TerminalPane does and returns the pty:spawn request it sends, or
 * the `terminal.create` its tab sent main instead.
 */
async function paneSpawnRequest(c: WindowLaunchCase): Promise<unknown> {
  const { modules, store, worktreeId, tab } = await openTab(c)
  const spawn = vi.fn(async (_request: Record<string, unknown>) => ({ id: 'pty-1' }))
  const noop = (): (() => void) => () => {}
  Object.assign(window.api.pty, {
    spawn,
    onData: noop,
    onReplay: noop,
    onExit: noop,
    onWriteUnavailable: noop,
    onSideEffect: noop,
    resize: vi.fn(),
    claimViewport: vi.fn()
  })
  // As TerminalPane mounts: a queued initial cwd, else the tab's startup cwd, else the workspace.
  const cwd = modules.lifecycle.resolveQueuedInitialCwd(
    undefined,
    () => store.getState().consumeTabInitialCwd(tab.id),
    tab.startupCwd ?? c.workspace.path
  ).startupCwd
  const startup = store.getState().pendingStartupByTabId[tab.id]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real store state includes every StoreState member the pane reads.
  const deps = buildPaneConnectionDeps(() => store.getState() as never, {
    tabId: tab.id,
    worktreeId,
    cwd,
    startup
  })
  const pane = createPane(1)
  // A measured grid no lane defaults to, so the request shows the pane's size reached it.
  Object.assign(pane.terminal, PANE_GRID)
  // The xterm keyboard options the real TerminalPane builds for this tab, over the defaults (pane-dom-creation.ts).
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: building the bag and terminalOptions read only these deps, ptyDeps.startup and startupCwd.
  const managerOptions = modules.paneOptions.createTerminalPaneManagerOptions({
    deps: {
      tabId: tab.id,
      worktreeId,
      settingsRef: { current: store.getState().settings },
      isVisibleRef: { current: true },
      effectiveMacOptionAsAltRef: { current: 'false' }
    },
    ptyDeps: { startup },
    startupCwd: cwd
  } as never)
  const { vtExtensions } = {
    ...modules.defaults.buildDefaultTerminalOptions(),
    ...managerOptions.terminalOptions?.(pane.id)
  }
  pane.terminal.options.vtExtensions = { kittyKeyboard: vtExtensions?.kittyKeyboard === true }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane fixtures model every member connectPanePty reads, as in pty-connection-startup-command-delivery.test.ts.
  modules.pane.connectPanePty(pane as never, createManager(1) as never, deps as never)
  await flushAsyncTicks(20)
  const [create] = windowTabCreates
  if (create && typeof create === 'object' && 'leafId' in create && 'launchToken' in create) {
    // Main never answers here; whatever the pane spawns in the meantime runs none of the startup.
    for (const [request] of spawn.mock.calls) {
      expect(request).toMatchObject({ command: undefined })
      expect(request).not.toHaveProperty('telemetry')
      expect(request).not.toHaveProperty('launchToken')
    }
    return JSON.parse(
      JSON.stringify(create)
        .replaceAll(tab.id, LAUNCH_TAB_ID)
        .replaceAll(String(create.leafId), LAUNCH_LEAF_ID)
        .replaceAll(String(create.launchToken), LAUNCH_TOKEN)
    )
  }
  const [request] = spawn.mock.calls[0] ?? []
  // Fixed ids so the table can name them; the color replies are this harness's theme.
  const { terminalColorQueryReplies: _theme, ...rest } = request ?? {}
  return JSON.parse(
    JSON.stringify(rest)
      .replaceAll(tab.id, LAUNCH_TAB_ID)
      .replaceAll(String(rest.launchToken), LAUNCH_TOKEN)
  )
}

// Pins main's current launch behaviour as the convergence parity baseline (rows 1, 2 and 6, window
// half): the real producer, store and pane build the pty:spawn request each case's table row names.
// C2 (typed-prompt tabs onto the pane trigger) and C3 (Antigravity continue) check against it.
describe('window-tab producers: the pty:spawn request a real pane sends', () => {
  // Why: the first import transforms the whole pane graph; keep that out of the first case.
  beforeAll(async () => {
    await load('darwin')
    await load('win32')
  }, 240_000)

  afterEach(async () => {
    windowTabCreates.length = 0
    await restoreTerminalTestGlobals()
    vi.unstubAllGlobals()
  })

  it.each([...WINDOW_LAUNCH_CASES, ...PLUS_LAUNCH_CASES, ...WORKSPACE_START_LAUNCH_CASES])(
    'row $row: $name',
    async (c) => {
      expect(await paneSpawnRequest(c)).toEqual(
        startsInMain(c) ? mainCreateParams(c) : windowSpawnRequest(c)
      )
    }
  )
})

// L278 (temporary): main reads the project runtime from its own store and gave this folder's tab
// no distro, where the window's spawn enters the repo's WSL distro (PR-1 regression).
describe('a plain new tab in a folder borrowing a WSL project', () => {
  afterEach(async () => {
    await restoreTerminalTestGlobals()
    vi.unstubAllGlobals()
  })

  it("keeps the window's own spawn, so it enters the borrowed distro", async () => {
    const c = WINDOW_LAUNCH_CASES.find(
      (candidate) => candidate.name === 'Windows folder containing a WSL-project repo'
    )!
    const modules = await load(c.client)
    await installTerminalTestGlobals()
    Object.assign(window.api.platform, { get: () => ({ platform: c.client, osRelease: '10' }) })
    const store = modules.createStore()
    holder.store = store
    store.setState(
      launchWorkspaceState(c.workspace, { ...getDefaultSettings('/home/alice'), ...c.settings })
    )
    const worktreeId = launchWorkspaceId(c.workspace)

    const tab = store.getState().createTab(worktreeId)

    expect(tab.shellOverride).toBe('wsl.exe')
    expect(modules.startInMain.windowTabStartsInMain(store.getState(), tab)).toBe(false)
    // Why: alone, this case pays the pane graph's first import.
  }, 240_000)
})
