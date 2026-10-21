// The window-tab lane (L252): each window-lane table request, as the window's new tab hands it to
// main's create instead of its own pty:spawn, reaches the provider with the window lane's facts and
// one agent_started. Main measures no pane, so the size is its own, and the pane resizes on attach.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { trackMock } from './pty-ipc-mock-registry'
import {
  providerFacts,
  recordOf,
  restoreMainPlatform,
  setMainPlatform,
  startParityLanes
} from './pty-launch-parity.test-fixture'
import { WINDOW_LAUNCH_CASES } from '../../shared/launch-parity-window-cases.test-fixture'
import { PLUS_LAUNCH_CASES } from '../../shared/launch-parity-plus-cases.test-fixture'
import { WORKSPACE_START_LAUNCH_CASES } from '../../shared/launch-parity-workspace-start-cases.test-fixture'
import {
  expectedWindowProvider,
  windowSpawnRequest
} from '../../shared/launch-parity-window-request.test-fixture'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { RpcDispatchStreamingOptions } from '../runtime/rpc/dispatcher-stream-options'
import { DESKTOP_RPC_CALLER } from '../runtime/rpc/rpc-caller-identity'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from './desktop-renderer-runtime-capabilities'
import { TERMINAL_LIFECYCLE_METHODS } from '../runtime/rpc/methods/terminal/terminal-lifecycle-methods'
import { isSupportedWindowsShellOverride } from '../../shared/windows-terminal-shell'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { isWslShellName } from '../../shared/local-windows-terminal-runtime'
import { isWslUncPath } from '../../shared/wsl-paths'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).fsPromisesModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
// Why: an OpenCode v2 install with the picked model available; the probes would run the binary.
vi.mock('../managed-data-accounts/launch-environment', () => ({
  applyManagedDataAccountEnvironment: vi.fn()
}))
vi.mock('../opencode/opencode-launch-capabilities', () => ({
  probeOpenCodeLaunchCapabilities: vi.fn()
}))
vi.mock('../opencode/opencode-model-availability', () => ({
  resolveOpenCodeDirectModelExecutable: vi.fn(),
  probeOpenCodeModelAvailability: vi.fn()
}))
vi.mock('../opencode/opencode-launch-model-context', () => ({
  probeOpenCodeLaunchModelContext: vi.fn()
}))
// Why: every folder in the table exists on its host; main checks that before it spawns.
vi.mock('../project-groups/folder-workspace-path-status', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFolderWorkspacePathStatus: vi.fn(async () => ({ path: '', exists: true }))
}))
// Why: no Antigravity account is selected on this machine, so the account switch before an agy launch is a no-op.
vi.mock('../antigravity/native-account-launch', () => ({
  prepareAntigravityAccountForLaunch: vi.fn(async () => {})
}))
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)
// Why: the OpenSSH DefaultShell registry read; only a managed SSH host's case answers it.
vi.mock('../../shared/openssh-default-shell', () => ({ readOpenSshDefaultShell: vi.fn(() => '') }))

const ALL_CASES = [
  ...WINDOW_LAUNCH_CASES,
  ...PLUS_LAUNCH_CASES,
  ...WORKSPACE_START_LAUNCH_CASES
].map((c) => ({
  ...c,
  label: `row ${c.row}: ${c.name}`,
  request: windowSpawnRequest(c),
  agentEnv: c.request.agentEnv ?? {}
}))
/**
 * A tab the window put in WSL keeps its own spawn (windowTabStartsInMain): main reads the project
 * runtime from its store, which refuses wsl.exe in a `\\wsl$` repo with no saved runtime and
 * loses the distro a folder borrows from its WSL-project repo.
 */
const keepsWindowSpawn = (c: (typeof ALL_CASES)[number]) =>
  isWslShellName(String(c.request.shellOverride ?? '')) || isWslUncPath(String(c.request.cwd))
const CASES = ALL_CASES.filter((c) => !keepsWindowSpawn(c))

/** What the window's new tab sends main for the startup its pane would have spawned with. */
function windowTabCreateParams(request: Record<string, unknown>, agentEnv: Record<string, string>) {
  const shell = typeof request.shellOverride === 'string' ? request.shellOverride : undefined
  return {
    worktree: `id:${String(request.worktreeId)}`,
    windowTab: true,
    tabId: request.tabId,
    leafId: request.leafId,
    cwd: request.cwd,
    ...(shell && isSupportedWindowsShellOverride(shell) ? { shell } : {}),
    command: request.command,
    ...(request.startupCommandDelivery
      ? { startupCommandDelivery: request.startupCommandDelivery }
      : {}),
    // The startup's own env: the pane adds its identity keys itself, and main stamps its own.
    ...(Object.keys(agentEnv).length > 0 ? { env: agentEnv } : {}),
    launchConfig: request.launchConfig,
    launchToken: request.launchToken,
    launchAgent: request.launchAgent,
    telemetry: request.telemetry
  }
}

export async function createWindowTab(
  runtime: OrcaRuntimeService,
  params: Record<string, unknown>,
  context: RpcDispatchStreamingOptions = {
    clientId: 'desktop-renderer',
    caller: DESKTOP_RPC_CALLER,
    clientKind: 'runtime',
    connectionId: 'desktop-window-1',
    clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
  }
) {
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_LIFECYCLE_METHODS })
  return dispatcher.dispatch(
    { id: 'window-tab', authToken: 'token', method: 'terminal.create', params },
    context
  )
}

describe('window-tab lane: terminal.create {windowTab} -> provider', () => {
  it('keeps the window spawn only for the Windows rows the window put in WSL', () => {
    expect(ALL_CASES.filter(keepsWindowSpawn).map((c) => c.label)).toMatchInlineSnapshot(`
      [
        "row 2: Windows wsl$ repo, no saved runtime",
        "row 2: Windows C: repo, project WSL",
        "row 2: Windows C: repo, global default WSL",
        "row 2: Windows wsl$ folder",
        "row 2: Windows folder containing a WSL-project repo",
        "row 6: continue, Windows wsl$ WSL-project repo",
        "row 8: work item, Windows C: repo, project WSL",
        "row 8: folder composer, Windows C: folder, terminal shell WSL",
      ]
    `)
  })

  const suite = setupPtyIpcSuite()
  afterEach(() => restoreMainPlatform())

  it.each(CASES)('$label', async ({ client, workspace, settings, request, provider, agentEnv }) => {
    setMainPlatform(client)
    const lanes = startParityLanes(suite, { workspace, settings })
    // The window drew the tab and wrote it to main first, as createTab does.
    await lanes.store.admitTerminalPane({
      type: 'createTerminalTab',
      workspace: String(request.worktreeId),
      tabId: String(request.tabId),
      leafId: String(request.leafId)
    })

    const response = await createWindowTab(lanes.runtime, windowTabCreateParams(request, agentEnv))

    expect(response.ok ? true : response.error).toBe(true)
    const { terminalShellArgs: _args, ...facts } = await providerFacts(lanes.provider)
    const window = expectedWindowProvider(request, provider, agentEnv)
    expect(facts).toEqual({
      ...window,
      // Main measures no pane: its size and hidden start until the pane attaches and resizes.
      cols: 120,
      rows: 40,
      hidden: true,
      // Main's create always names the provider delivery the window's spawn defaults to.
      commandDelivery: 'provider'
    })
    expect(trackMock.mock.calls).toEqual([['agent_started', request.telemetry]])
  })
})

const PLUS = CASES.find((c) => c.label.startsWith('row 1: menu "+"'))!

describe('window-tab lane: one start, one agent_started, owned by main', () => {
  const suite = setupPtyIpcSuite()
  afterEach(() => restoreMainPlatform())

  async function admitted(spawnError?: Error) {
    setMainPlatform(PLUS.client)
    const lanes = startParityLanes(suite, {
      workspace: PLUS.workspace,
      settings: PLUS.settings,
      ...(spawnError ? { spawnError } : {})
    })
    await lanes.store.admitTerminalPane({
      type: 'createTerminalTab',
      workspace: String(PLUS.request.worktreeId),
      tabId: String(PLUS.request.tabId),
      leafId: String(PLUS.request.leafId)
    })
    return lanes
  }

  it('records nothing again, and spawns nothing, when the pane that captured the startup attaches', async () => {
    const lanes = await admitted()
    const created = await createWindowTab(
      lanes.runtime,
      windowTabCreateParams(PLUS.request, PLUS.agentEnv)
    )
    const ptyId = created.ok ? recordOf(recordOf(created.result).terminal).ptyId : null

    // The daemon reattaches the live session it already runs.
    lanes.provider.mockImplementation(async (options: { sessionId?: string }) => ({
      id: options.sessionId,
      isReattach: true
    }))

    // The pane mounted before main took the startup, so its attach to main's terminal carries it.
    await lanes.spawnWindow({ ...PLUS.request, sessionId: ptyId })

    const spawns = lanes.provider.mock.calls.map(([options]) => recordOf(options))
    // One start; the attach reaches the daemon only to reattach, never to run the command again.
    expect(spawns.map((options) => Boolean(options.attachOnly))).toEqual([false, true])
    expect(trackMock.mock.calls).toEqual([['agent_started', PLUS.request.telemetry]])
  })

  it('records nothing when the start fails', async () => {
    const lanes = await admitted(new Error('spawn failed'))

    const response = await createWindowTab(
      lanes.runtime,
      windowTabCreateParams(PLUS.request, PLUS.agentEnv)
    )

    expect(response.ok).toBe(false)
    expect(trackMock.mock.calls).toEqual([])
  })

  it('records and starts nothing for a paired server’s tab; the window’s spawn does', async () => {
    const lanes = await admitted()
    Object.assign(lanes.runtime, {
      getWorkspaceSessionHostIdsForTab: () => [toRuntimeExecutionHostId('env-1')]
    })

    const response = await createWindowTab(
      lanes.runtime,
      windowTabCreateParams(PLUS.request, PLUS.agentEnv)
    )

    expect(response.ok ? null : response.error.message).toBe('host_not_owned')
    expect(lanes.provider).not.toHaveBeenCalled()
    expect(trackMock.mock.calls).toEqual([])
  })

  it('refuses a paired caller’s window tab, starting nothing', async () => {
    const lanes = await admitted()

    const response = await createWindowTab(
      lanes.runtime,
      windowTabCreateParams(PLUS.request, PLUS.agentEnv),
      { clientId: 'device-1', pairedDeviceId: 'device-1', clientKind: 'runtime' }
    )

    expect(response.ok ? null : response.error.message).toBe('host_not_owned')
    expect(lanes.provider).not.toHaveBeenCalled()
    expect(trackMock.mock.calls).toEqual([])
  })

  it('tells the window an agent launch it cannot read never started, running no shell for it', async () => {
    const lanes = await admitted()
    const verdicts = vi.spyOn(lanes.runtime, 'reportAgentLaunchPaneVerdict')

    const response = await createWindowTab(lanes.runtime, {
      worktree: `id:${String(PLUS.request.worktreeId)}`,
      windowTab: true,
      tabId: PLUS.request.tabId,
      leafId: PLUS.request.leafId,
      agentLaunch: { launch: 7 }
    })

    expect(response.ok).toBe(false)
    expect(lanes.provider).not.toHaveBeenCalled()
    expect(verdicts.mock.calls.map(([, verdict]) => verdict)).toEqual([
      { kind: 'not-started', code: 'agent_launch_request_invalid' }
    ])
  })

  it('launches one agent for two starts of the same agent-launch pane', async () => {
    const lanes = await admitted()
    const params = {
      worktree: `id:${String(PLUS.request.worktreeId)}`,
      windowTab: true,
      tabId: PLUS.request.tabId,
      leafId: PLUS.request.leafId,
      agentLaunch: {
        launch: {
          agent: 'claude',
          target: { kind: 'existing', worktree: `id:${String(PLUS.request.worktreeId)}` },
          launchSource: 'tab_bar_quick_launch'
        }
      }
    }

    const replies = await Promise.all([
      createWindowTab(lanes.runtime, params),
      createWindowTab(lanes.runtime, params)
    ])

    expect(replies.map((reply) => reply.ok)).toEqual([true, true])
    expect(lanes.provider).toHaveBeenCalledTimes(1)
    expect(trackMock.mock.calls).toEqual([
      [
        'agent_started',
        { agent_kind: 'claude-code', launch_source: 'tab_bar_quick_launch', request_kind: 'new' }
      ]
    ])
  })
})
