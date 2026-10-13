import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { classifyErrorMock, trackMock } from './pty-ipc-mock-registry'
import {
  providerFacts,
  recordOf,
  restoreMainPlatform,
  setMainPlatform,
  startParityLanes,
  type ParityLanes
} from './pty-launch-parity.test-fixture'
import {
  POSIX_PATH,
  WINDOW_LAUNCH_CASES
} from '../../shared/launch-parity-window-cases.test-fixture'
import { PLUS_LAUNCH_CASES } from '../../shared/launch-parity-plus-cases.test-fixture'
import {
  expectedWindowProvider,
  launchWorkspaceId,
  windowSpawnRequest,
  type LaunchWorkspace,
  type WindowProviderFacts
} from '../../shared/launch-parity-window-request.test-fixture'
import {
  AUTOMATION_LAUNCH_CASES,
  automationSpawnRequest
} from '../../shared/launch-parity-automation-cases.test-fixture'
import {
  expectedHostProvider,
  HOST_LEAF_ID,
  HOST_LAUNCH_CASES,
  type HostLaunchCase
} from './pty-launch-parity-host.test-cases'
import { CALLER_LAUNCH_CASES, OPENCODE_MODEL } from './pty-launch-parity-caller.test-cases'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { DESKTOP_RPC_CALLER } from '../runtime/rpc/rpc-caller-identity'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from './desktop-renderer-runtime-capabilities'
import { TERMINAL_LIFECYCLE_METHODS } from '../runtime/rpc/methods/terminal/terminal-lifecycle-methods'
import { AGENT_SESSION_METHODS } from '../runtime/rpc/methods/agent-session'
import { applyManagedDataAccountEnvironment } from '../managed-data-accounts/launch-environment'
import { probeOpenCodeLaunchCapabilities } from '../opencode/opencode-launch-capabilities'
import {
  probeOpenCodeModelAvailability,
  resolveOpenCodeDirectModelExecutable
} from '../opencode/opencode-model-availability'
import { probeOpenCodeLaunchModelContext } from '../opencode/opencode-launch-model-context'
import type { TerminalWorkspaceLaunchScope } from '../runtime/runtime-legacy-worker-terminal-recovery-types'
import {
  setRuntimeDesktopSurface,
  type RuntimeDesktopSurface
} from '../runtime/runtime-desktop-surface'
import type { BrowserWindow, IpcMainEvent } from 'electron'

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

type WindowLaneCase = {
  label: string
  client: NodeJS.Platform
  workspace: LaunchWorkspace
  settings?: Record<string, unknown>
  request: Record<string, unknown>
  provider: WindowProviderFacts
  /** The agent env the case saved, as the provider must receive it. */
  env: Record<string, string>
}

const WINDOW_LANE_CASES: WindowLaneCase[] = [
  ...[...WINDOW_LAUNCH_CASES, ...PLUS_LAUNCH_CASES].map((c) => ({
    ...c,
    label: `row ${c.row}: ${c.name}`,
    request: windowSpawnRequest(c),
    env: c.request.agentEnv ?? {}
  })),
  ...AUTOMATION_LAUNCH_CASES.map((c) => ({
    ...c,
    label: `row 5: ${c.name}`,
    request: automationSpawnRequest(c),
    env: {}
  }))
]

// Pins main's current launch behaviour as the convergence parity baseline (rows 1, 2, 5 and 6, main
// half): each table request, fed to pty:spawn, reaches the provider with these facts (the pane's
// measured size, never hidden), one agent_started, and a pane binding.
// C2 (row 1), C5a-e and C6 check the merged spawn pipeline against it.
describe('window lane: pty:spawn request -> provider', () => {
  const suite = setupPtyIpcSuite()
  afterEach(() => restoreMainPlatform())

  it.each(WINDOW_LANE_CASES)(
    '$label',
    async ({ client, workspace, settings, request, provider, env: agentEnv }) => {
      // A desktop client's main process runs on the client OS.
      setMainPlatform(client)
      const lanes = startParityLanes(suite, { workspace, settings })
      await lanes.spawnWindow(request)

      expect(await providerFacts(lanes.provider)).toEqual(
        expectedWindowProvider(request, provider, agentEnv)
      )
      expect(trackMock.mock.calls).toEqual([['agent_started', request.telemetry]])
      expect(lanes.persistPtyBinding.mock.calls).toEqual([
        [
          {
            worktreeId: request.worktreeId,
            tabId: request.tabId,
            leafId: request.leafId,
            ptyId: expect.any(String),
            startupCwd: expect.any(String),
            ...pick(request, ['placement']),
            origin: 'spawn'
          }
        ]
      ])
    }
  )
})

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]))
}

function stubOpenCodeV2(): void {
  vi.mocked(applyManagedDataAccountEnvironment).mockReset()
  vi.mocked(resolveOpenCodeDirectModelExecutable).mockReset().mockResolvedValue('/bin/opencode')
  vi.mocked(probeOpenCodeLaunchCapabilities)
    .mockReset()
    .mockResolvedValue({ version: '2.0.16', pluginApi: 'v2', promptMode: 'prefill' })
  vi.mocked(probeOpenCodeModelAvailability).mockReset().mockResolvedValue(true)
  vi.mocked(probeOpenCodeLaunchModelContext)
    .mockReset()
    .mockResolvedValueOnce({
      primaryAgent: 'build',
      availableModels: [OPENCODE_MODEL],
      primaryModel: 'opencode/big-pickle'
    })
    .mockResolvedValue({
      primaryAgent: 'build',
      availableModels: [OPENCODE_MODEL],
      primaryModel: OPENCODE_MODEL
    })
}

async function runHostCall(lanes: ParityLanes, c: HostLaunchCase): Promise<unknown> {
  if (c.call.kind === 'create') {
    return lanes.runtime.createTerminal(`id:${launchWorkspaceId(c.workspace)}`, c.call.options)
  }
  const { method, params } = c.call
  const dispatcher = new RpcDispatcher({
    runtime: lanes.runtime,
    methods: [...TERMINAL_LIFECYCLE_METHODS, ...AGENT_SESSION_METHODS]
  })
  const response = await dispatcher.dispatch(
    {
      id: 'parity',
      // The transport authenticated the caller before dispatch; the dispatcher only carries it.
      authToken: 'token',
      method,
      params:
        method === 'terminal.createAgentSession'
          ? { clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`, ...params }
          : params
    },
    // Row 4 is the desktop's own runtime:call (ipc/runtime.ts); row 7 comes from a paired desktop.
    c.row === '4'
      ? {
          clientId: 'desktop-renderer',
          caller: DESKTOP_RPC_CALLER,
          clientKind: 'runtime',
          connectionId: 'desktop-window-1',
          clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
        }
      : { clientId: 'device-1', pairedDeviceId: 'device-1', clientKind: 'runtime' }
  )
  if (!response.ok) {
    throw Object.assign(new Error(response.error.message), { code: response.error.code })
  }
  return response.result
}

// Pins main's current launch behaviour as the convergence parity baseline (rows 3, 4, 7, 8, 10):
// each host producer's call reaches the provider through the real runtime controller with these
// facts, telemetry, placement and phone tab. C1, C2 and C5a-e check the host path against it.
describe('host lane: producer call -> runtime controller -> provider', () => {
  const suite = setupPtyIpcSuite()
  beforeEach(() => stubOpenCodeV2())
  afterEach(() => restoreMainPlatform())

  it.each([...HOST_LAUNCH_CASES, ...CALLER_LAUNCH_CASES])('row $row: $name', async (c) => {
    setMainPlatform(c.os)
    const lanes = startParityLanes(suite, { workspace: c.workspace, settings: c.settings })
    await runHostCall(lanes, c)

    expect(await providerFacts(lanes.provider)).toEqual(expectedHostProvider(c))
    // The host stamps its own pane identity (the window lane's stale-key case is below).
    const spawned = recordOf(lanes.provider.mock.calls.at(-1)?.[0])
    expect(recordOf(spawned.env).ORCA_PANE_KEY).toBe(spawned.paneKey)
    expect(trackMock.mock.calls).toEqual(c.telemetry ? [['agent_started', c.telemetry]] : [])
    expect(lanes.persistPtyBinding.mock.calls[0]?.[0]).toMatchObject({
      placement: { kind: 'new-tab' }
    })
    const phone = await lanes.runtime.listMobileSessionTabs(`id:${launchWorkspaceId(c.workspace)}`)
    expect(pick({ ...phone.tabs[0] }, ['title', 'launchAgent', 'isActive'])).toEqual(c.phone)
  })
})

describe('project runtime in a folder workspace', () => {
  const suite = setupPtyIpcSuite()
  afterEach(() => {
    restoreMainPlatform()
    setRuntimeDesktopSurface(null)
  })
  const workspace: LaunchWorkspace = {
    kind: 'folder',
    path: 'C:\\work',
    repoPath: 'C:\\work\\repo',
    projectRuntime: { kind: 'windows-host' }
  }
  const settings = {
    terminalWindowsShell: 'wsl.exe',
    terminalWindowsWslDistro: 'Debian',
    localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
    agentDefaultArgs: { claude: `--name "Bob's box"` }
  }
  const windowsCommand = 'claude "--name" "Bob\'s box"'
  it.each([
    { kind: 'windows-host' },
    { kind: 'wsl', distro: 'Ubuntu' },
    { kind: 'inherit-global' }
  ] as const)(
    'resumes project-owned $kind folders through the existing fallback before claims',
    async (projectRuntime) => {
      setMainPlatform('win32')
      const lanes = startParityLanes(suite, {
        workspace: { ...workspace, projectRuntime },
        settings
      })
      const createTerminal = vi.spyOn(lanes.runtime, 'createTerminal')
      await expect(
        lanes.runtime.ensureAgentSession({
          kind: 'explicit',
          worktree: 'id:folder:fw-1',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'resume-session' },
          placement: { tabId: 'resume-tab', leafId: HOST_LEAF_ID }
        })
      ).rejects.toThrow('agent_session_legacy_required')
      expect(createTerminal).not.toHaveBeenCalled()
      expect(lanes.provider).not.toHaveBeenCalled()
      const runsOnWindows = projectRuntime.kind === 'windows-host'
      const command = runsOnWindows
        ? 'claude "--resume" "resume-session"'
        : "claude '--resume' 'resume-session'"
      await lanes.runtime.createTerminal('id:folder:fw-1', {
        command,
        launchAgent: 'claude',
        resumeProviderSession: { key: 'session_id', id: 'resume-session' },
        launchConfig: { agentArgs: '', agentEnv: {} },
        tabId: 'resume-tab',
        leafId: HOST_LEAF_ID,
        presentation: 'background'
      })
      expect(await providerFacts(lanes.provider)).toMatchObject({
        command,
        shellOverride: runsOnWindows ? 'C:\\Windows\\system32\\cmd.exe' : 'wsl.exe',
        terminalWindowsWslDistro: runsOnWindows ? null : 'Ubuntu'
      })
      expect(recordOf(lanes.provider.mock.calls.at(-1)?.[0])).not.toHaveProperty(
        'agentSessionEnsure'
      )
      expect(lanes.persistPtyBinding).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: 'folder:fw-1',
          tabId: 'resume-tab',
          leafId: HOST_LEAF_ID
        })
      )
    }
  )

  it.each(['inherited-windows', 'repo-less', 'multi-repo', 'wsl-share'] as const)(
    'keeps the existing resume claim for an unchanged %s folder',
    async (boundary) => {
      setMainPlatform('win32')
      const lanes = startParityLanes(suite, {
        workspace: {
          ...workspace,
          ...(boundary === 'repo-less' ? { repoPath: undefined } : {}),
          ...(boundary === 'inherited-windows'
            ? { projectRuntime: { kind: 'inherit-global' } as const }
            : {}),
          ...(boundary === 'wsl-share' ? { path: '\\\\wsl$\\Ubuntu\\work' } : {})
        },
        settings: { ...settings, localWindowsRuntimeDefault: { kind: 'windows-host' } },
        ...(boundary === 'multi-repo'
          ? {
              additionalRepos: [
                {
                  id: 'repo-2',
                  path: 'C:\\work\\other',
                  displayName: 'Other',
                  badgeColor: 'blue',
                  addedAt: 0,
                  projectGroupId: 'pg-1'
                }
              ]
            }
          : {})
      })
      const createTerminal = vi
        .spyOn(lanes.runtime, 'createTerminal')
        .mockResolvedValue({ handle: 'unchanged-resume', worktreeId: 'folder:fw-1', title: null })
      await expect(
        lanes.runtime.ensureAgentSession({
          kind: 'explicit',
          worktree: 'id:folder:fw-1',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'resume-session' },
          placement: { tabId: 'resume-tab', leafId: HOST_LEAF_ID }
        })
      ).resolves.toMatchObject({ terminal: { handle: 'unchanged-resume' } })
      expect(createTerminal).toHaveBeenCalledWith(
        'id:folder:fw-1',
        expect.objectContaining({
          tabId: 'resume-tab',
          leafId: HOST_LEAF_ID,
          agentSessionClaim: expect.any(Object)
        })
      )
    }
  )
  const calls: [string, HostLaunchCase['call'], string][] = [
    [
      'AI button',
      { kind: 'create', options: { startupAgent: 'claude', launchSource: 'notes_send' } },
      windowsCommand
    ],
    [
      'CLI agent launch',
      { kind: 'create', options: { startupAgent: 'claude', launchSource: 'cli' } },
      windowsCommand
    ],
    [
      'orchestration worker',
      {
        kind: 'create',
        options: { startupAgent: 'claude', launchSource: 'orchestration', surfaceOwner: false }
      },
      windowsCommand
    ],
    [
      'typed-prompt host tab',
      {
        kind: 'rpc',
        method: 'terminal.createAgentSession',
        params: {
          worktree: 'id:folder:fw-1',
          agent: 'claude',
          presentation: 'background'
        }
      },
      windowsCommand
    ],
    [
      'headless terminal create --command',
      {
        kind: 'rpc',
        method: 'terminal.create',
        params: { worktree: 'id:folder:fw-1', command: 'claude' }
      },
      'claude'
    ]
  ]

  it.each(calls)(
    '%s uses the project Windows host and quotes for its shell',
    async (name, call, command) => {
      setMainPlatform('win32')
      const lanes = startParityLanes(suite, { workspace, settings })
      await runHostCall(lanes, {
        name,
        row: '10',
        os: 'win32',
        workspace,
        call,
        provider: { command },
        telemetry: null,
        phone: { title: 'Terminal', isActive: false }
      })
      expect(await providerFacts(lanes.provider)).toMatchObject({
        command,
        shellOverride: 'C:\\Windows\\system32\\cmd.exe',
        terminalWindowsWslDistro: null
      })
    }
  )

  it('quotes a phone compatibility launch for the Windows shell selected for its project', async () => {
    setMainPlatform('win32')
    const lanes = startParityLanes(suite, { workspace, settings })
    lanes.runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    await lanes.runtime.createMobileSessionTerminal('id:folder:fw-1', { agent: 'claude' })
    expect(await providerFacts(lanes.provider)).toMatchObject({
      command: windowsCommand,
      shellOverride: 'C:\\Windows\\system32\\cmd.exe',
      terminalWindowsWslDistro: null
    })
  })

  it('preserves the existing folder shell for the inherited Windows default', async () => {
    setMainPlatform('win32')
    const lanes = startParityLanes(suite, {
      workspace: { ...workspace, projectRuntime: { kind: 'inherit-global' } },
      settings: { ...settings, localWindowsRuntimeDefault: { kind: 'windows-host' } }
    })
    await lanes.runtime.createTerminal('id:folder:fw-1', { startupAgent: 'claude' })
    expect(await providerFacts(lanes.provider)).toMatchObject({
      command: `claude '--name' 'Bob'"'"'s box'`,
      shellOverride: 'wsl.exe',
      terminalWindowsWslDistro: 'Debian'
    })
  })

  it.each(calls)(
    '%s uses the folder project WSL distro and quotes for Linux',
    async (name, call) => {
      setMainPlatform('win32')
      const lanes = startParityLanes(suite, {
        workspace: { ...workspace, projectRuntime: { kind: 'wsl', distro: 'Ubuntu' } },
        settings: { ...settings, terminalWindowsShell: 'powershell.exe' }
      })
      await runHostCall(lanes, {
        name,
        row: '10',
        os: 'win32',
        workspace,
        call,
        provider: { command: 'unused' },
        telemetry: null,
        phone: { title: 'Terminal', isActive: false }
      })
      expect(await providerFacts(lanes.provider)).toMatchObject({
        command:
          call.kind === 'rpc' && call.method === 'terminal.create'
            ? 'claude'
            : `claude '--name' 'Bob'"'"'s box'`,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu'
      })
    }
  )

  it.each(['wsl.exe', 'powershell.exe'])(
    'inherits the global WSL distro over %s',
    async (terminalWindowsShell) => {
      setMainPlatform('win32')
      const lanes = startParityLanes(suite, {
        workspace: { ...workspace, projectRuntime: { kind: 'inherit-global' } },
        settings: { ...settings, terminalWindowsShell }
      })
      await lanes.runtime.createTerminal('id:folder:fw-1', { startupAgent: 'claude' })
      expect(await providerFacts(lanes.provider)).toMatchObject({
        command: `claude '--name' 'Bob'"'"'s box'`,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu'
      })
    }
  )

  it('uses the project WSL distro for a headless phone compatibility launch', async () => {
    setMainPlatform('win32')
    const lanes = startParityLanes(suite, {
      workspace: { ...workspace, projectRuntime: { kind: 'wsl', distro: 'Ubuntu' } },
      settings: { ...settings, terminalWindowsShell: 'powershell.exe' }
    })
    lanes.runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    await lanes.runtime.createMobileSessionTerminal('id:folder:fw-1', { agent: 'claude' })
    expect(await providerFacts(lanes.provider)).toMatchObject({
      command: `claude '--name' 'Bob'"'"'s box'`,
      shellOverride: 'wsl.exe',
      terminalWindowsWslDistro: 'Ubuntu'
    })
  })

  it('refuses an unverified OpenCode model in the chosen WSL runtime before spawning', async () => {
    setMainPlatform('win32')
    stubOpenCodeV2()
    const lanes = startParityLanes(suite, {
      workspace: { ...workspace, projectRuntime: { kind: 'wsl', distro: 'Ubuntu' } },
      settings: { ...settings, terminalWindowsShell: 'powershell.exe', agentDefaultArgs: {} }
    })
    await expect(
      runHostCall(lanes, {
        name: 'OpenCode WSL model',
        row: '4',
        os: 'win32',
        workspace,
        call: {
          kind: 'rpc',
          method: 'terminal.createAgentSession',
          params: {
            worktree: 'id:folder:fw-1',
            agent: 'opencode',
            launchPreferences: { model: OPENCODE_MODEL },
            presentation: 'background'
          }
        },
        provider: { command: 'unused' },
        telemetry: null,
        phone: { title: 'Terminal', isActive: false }
      })
    ).rejects.toThrow('cannot verify this OpenCode model launch')
    expect(lanes.provider).not.toHaveBeenCalled()
  })

  it('quotes the phone renderer handoff for PowerShell instead of the headless cmd fallback', async () => {
    setMainPlatform('win32')
    const lanes = startParityLanes(suite, { workspace, settings })
    lanes.runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    Object.defineProperty(lanes.runtime, 'getAvailableAuthoritativeWindow', {
      value: () => suite.mainWindow
    })
    type MobileCommandResolver = {
      resolveMobileSessionTerminalCommand: (
        workspace: TerminalWorkspaceLaunchScope,
        options: { agent?: 'claude' },
        fallbackHostShell?: string
      ) => Promise<{ command?: string }>
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this protected method is the real mobile command builder; only its visibility is narrowed for interception.
    const internal = lanes.runtime as unknown as MobileCommandResolver
    const resolveCommand = internal.resolveMobileSessionTerminalCommand.bind(lanes.runtime)
    let command: string | undefined
    vi.spyOn(internal, 'resolveMobileSessionTerminalCommand').mockImplementation(
      async (...args) => {
        command = (await resolveCommand(...args)).command
        throw new Error('captured-before-tab-create')
      }
    )
    await expect(
      lanes.runtime.createMobileSessionTerminal('id:folder:fw-1', { agent: 'claude' })
    ).rejects.toThrow('captured-before-tab-create')
    expect(command).toBe("claude '--name' 'Bob''s box'")
    expect(lanes.provider).not.toHaveBeenCalled()
  })

  it('keeps the phone command and shell together when a renderer tab needs host rescue', async () => {
    setMainPlatform('win32')
    const lanes = startParityLanes(suite, { workspace, settings })
    let reply: Parameters<RuntimeDesktopSurface['onIpc']>[1] | undefined
    setRuntimeDesktopSurface({
      showNotification: () => false,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mobile creation reads only the mocked window's destruction state and webContents.
      findWindowById: () => suite.mainWindow as unknown as BrowserWindow,
      onIpc: (_channel, listener) => {
        reply = listener
      },
      removeIpcListener: () => {}
    })
    suite.mainWindow.webContents.send.mockImplementation((channel, data) => {
      if (channel !== 'terminal:requestTabCreate') {
        return
      }
      const request = recordOf(data)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this reply handler authenticates only the sender, supplied by the same fake window.
      const event = { sender: suite.mainWindow.webContents } as unknown as IpcMainEvent
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the desktop port has a variadic never[] boundary; this is its documented tab-create reply shape.
      reply?.(event, { requestId: request.requestId, tabId: 'rescued-tab' } as never)
    })
    const pending = { tab: { parentTabId: 'rescued-tab', leafId: HOST_LEAF_ID }, terminal: null }
    Object.assign(lanes.runtime, {
      waitForMobileTerminalSurface: vi
        .fn()
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(null),
      findMobileTerminalSurface: () => pending
    })
    lanes.runtime.attachWindow(1)
    lanes.runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    await lanes.runtime.createMobileSessionTerminal('id:folder:fw-1', {
      agent: 'claude',
      activate: false
    })
    expect(await providerFacts(lanes.provider)).toMatchObject({
      command: "claude '--name' 'Bob''s box'",
      shellOverride: 'powershell.exe',
      terminalWindowsWslDistro: null
    })
  })

  it.each(['generic', 'agent-session'] as const)(
    'preserves Linux quoting for a UNC startup cwd on the %s path',
    async (route) => {
      setMainPlatform('win32')
      const cwd = '\\\\wsl$\\Ubuntu\\home\\test\\work'
      const lanes = startParityLanes(suite, {
        workspace,
        settings: { ...settings, agentDefaultArgs: { claude: '--name "cost $HOME"' } }
      })
      await runHostCall(lanes, {
        name: 'UNC startup cwd',
        row: '10',
        os: 'win32',
        workspace,
        call:
          route === 'generic'
            ? { kind: 'create', options: { startupAgent: 'claude', cwd } }
            : {
                kind: 'rpc',
                method: 'terminal.createAgentSession',
                params: {
                  worktree: 'id:folder:fw-1',
                  agent: 'claude',
                  startupCwd: cwd,
                  presentation: 'background'
                }
              },
        provider: { command: 'unused' },
        telemetry: null,
        phone: { title: 'Terminal', isActive: false }
      })
      expect(await providerFacts(lanes.provider)).toMatchObject({
        command: "claude '--name' 'cost $HOME'",
        shellOverride: 'wsl.exe',
        cwd: cwd.replaceAll('\\', '/')
      })
    }
  )

  it('preserves Linux quoting for a phone launch with a UNC startup cwd', async () => {
    setMainPlatform('win32')
    const cwd = '\\\\wsl$\\Ubuntu\\home\\test\\work'
    const lanes = startParityLanes(suite, {
      workspace,
      settings: { ...settings, agentDefaultArgs: { claude: '--name "cost $HOME"' } }
    })
    lanes.runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    await lanes.runtime.createMobileSessionTerminal('id:folder:fw-1', { agent: 'claude', cwd })
    expect(await providerFacts(lanes.provider)).toMatchObject({
      command: "claude '--name' 'cost $HOME'",
      shellOverride: 'wsl.exe',
      cwd: cwd.replaceAll('\\', '/')
    })
  })
})

const POSIX_REPO = { kind: 'repo', path: POSIX_PATH } as const
const WORKER = HOST_LAUNCH_CASES.find((c) => c.name.startsWith('orchestration worker'))!

// Pins main's current launch behaviour as the convergence parity baseline (rows 2 and 10; failed
// spawn, reveal, pane identity): the facts no single table row carries.
describe('launch facts outside the tables', () => {
  const suite = setupPtyIpcSuite()
  afterEach(() => restoreMainPlatform())

  // C5a (one agent_error place): main today reports a failed window-lane spawn.
  it.each([
    {
      lane: 'telemetry kind wins over the claude sniff',
      request: { command: 'claude', telemetry: { agent_kind: 'opencode' } },
      calls: [['agent_error', { agent_kind: 'opencode', error_class: 'binary_not_found' }]]
    },
    {
      lane: 'local claude without telemetry',
      request: { command: 'claude' },
      calls: [['agent_error', { agent_kind: 'claude-code', error_class: 'binary_not_found' }]]
    }
  ])('a failed window spawn, $lane, emits agent_error', async (c) => {
    setMainPlatform('darwin')
    classifyErrorMock.mockReturnValue({ error_class: 'binary_not_found' })
    const spawnError = new Error('spawn boom')
    const lanes = startParityLanes(suite, { workspace: POSIX_REPO, spawnError })
    const launch = lanes.spawnWindow({
      cols: 80,
      rows: 24,
      cwd: POSIX_PATH,
      worktreeId: launchWorkspaceId(POSIX_REPO),
      ...c.request
    })
    await expect(launch).rejects.toThrow('spawn boom')
    expect(trackMock.mock.calls.filter(([event]) => event === 'agent_error')).toEqual(c.calls)
  })

  // C5e (presentation merge): a worker asks the window to reveal its titled tab without activating it.
  it('row 10: an orchestration worker requests a titled, inactive reveal', async () => {
    setMainPlatform(WORKER.os)
    const lanes = startParityLanes(suite, { workspace: WORKER.workspace })
    await runHostCall(lanes, WORKER)
    expect(lanes.reveal.mock.calls[0]?.[1]).toMatchObject({
      title: 'worker-task-1',
      activate: false,
      surfaceOwner: false
    })
    expect(lanes.reveal.mock.calls[0]?.[1]).not.toHaveProperty('presentation')
  })

  // C5c (pane identity built once in main): main rewrites stale pane keys from the request's tab and
  // leaf; workspace keys pass.
  it('window lane: the provider gets the pane keys main derives, not the stale ones sent', async () => {
    setMainPlatform('darwin')
    const tabId = '55555555-5555-4555-8555-555555555555'
    const leafId = '66666666-6666-4666-8666-666666666666'
    const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
    await lanes.spawnWindow({
      cols: 80,
      rows: 24,
      cwd: POSIX_PATH,
      worktreeId: launchWorkspaceId(POSIX_REPO),
      tabId,
      leafId,
      env: { ORCA_WORKSPACE_ID: 'folder:f1', ORCA_PANE_KEY: 'stale', ORCA_TAB_ID: 'stale' }
    })
    const env = recordOf(recordOf(lanes.provider.mock.calls.at(-1)?.[0]).env)
    expect(pick(env, ['ORCA_WORKSPACE_ID', 'ORCA_PANE_KEY', 'ORCA_TAB_ID'])).toEqual({
      ORCA_WORKSPACE_ID: 'folder:f1',
      ORCA_PANE_KEY: `${tabId}:${leafId}`,
      ORCA_TAB_ID: tabId
    })
  })
})
