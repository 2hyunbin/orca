import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  providerFacts,
  recordOf,
  restoreMainPlatform,
  setMainPlatform,
  startParityLanes,
  type ParityLanes
} from './pty-launch-parity.test-fixture'
import {
  launchWorkspaceId,
  type LaunchWorkspace
} from '../../shared/launch-parity-window-request.test-fixture'
import { HOST_TAB_ID, HOST_LEAF_ID, type HostLaunchCase } from './pty-launch-parity-host.test-cases'
import { OPENCODE_MODEL } from './pty-launch-parity-caller.test-cases'
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
    {
      projectRuntime: { kind: 'windows-host' },
      terminalWindowsShell: 'cmd.exe',
      shellOverride: 'cmd.exe',
      command: 'claude "--name" "Bob\'s box" "--resume" "resume-session"',
      distro: null
    },
    {
      projectRuntime: { kind: 'wsl', distro: 'Ubuntu' },
      terminalWindowsShell: 'powershell.exe',
      shellOverride: 'wsl.exe',
      command: `claude '--name' 'Bob'"'"'s box' '--resume' 'resume-session'`,
      distro: 'Ubuntu'
    }
  ] as const)(
    'paired resume quotes on the host for $projectRuntime.kind and keeps one claim',
    async (row) => {
      setMainPlatform('win32')
      const lanes = startParityLanes(suite, {
        workspace: { ...workspace, projectRuntime: row.projectRuntime },
        settings: { ...settings, terminalWindowsShell: row.terminalWindowsShell }
      })
      const spawn = lanes.provider.getMockImplementation()!
      lanes.provider.mockImplementation(async (...args) => ({
        ...(await spawn(...args)),
        incarnationId: '11111111-1111-4111-8111-111111111111'
      }))
      suite.installDaemonTestProvider({
        spawn: lanes.provider,
        listProcesses: async () =>
          await Promise.all(lanes.provider.mock.results.map((result) => result.value))
      })
      const createTerminal = vi.spyOn(lanes.runtime, 'createTerminal')
      const dispatcher = new RpcDispatcher({
        runtime: lanes.runtime,
        methods: AGENT_SESSION_METHODS
      })
      const response = await dispatcher.dispatch(
        {
          id: 'resume',
          authToken: 'token',
          method: 'terminal.ensureAgentSession',
          params: {
            kind: 'explicit',
            worktree: 'id:folder:fw-1',
            agent: 'claude',
            providerSession: { key: 'session_id', id: 'resume-session' },
            placement: { tabId: HOST_TAB_ID, leafId: HOST_LEAF_ID }
          }
        },
        { clientId: 'paired-client', pairedDeviceId: 'paired-client', clientKind: 'runtime' }
      )
      expect(response).toMatchObject({ ok: true })
      expect(createTerminal).toHaveBeenCalledTimes(1)
      expect(createTerminal).toHaveBeenCalledWith(
        'id:folder:fw-1',
        expect.objectContaining({
          command: row.command,
          shellOverride: row.shellOverride,
          agentSessionClaim: expect.any(Object)
        })
      )
      expect(lanes.provider).toHaveBeenCalledTimes(1)
      expect(await providerFacts(lanes.provider)).toMatchObject({
        command: row.command,
        shellOverride: row.shellOverride,
        terminalWindowsWslDistro: row.distro
      })
      expect(recordOf(lanes.provider.mock.calls[0]?.[0]).agentSessionEnsure).toMatchObject({
        claim: expect.any(Object)
      })
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

  it.each([{}, { command: 'echo raw shell syntax' }, { shellOverride: 'powershell.exe' }])(
    'keeps plain/raw/requested-shell folder terminals on the terminal setting: %j',
    async (options) => {
      setMainPlatform('win32')
      const lanes = startParityLanes(suite, {
        workspace: { ...workspace, projectRuntime: { kind: 'wsl', distro: 'Ubuntu' } },
        settings: { ...settings, terminalWindowsShell: 'cmd.exe' }
      })
      await lanes.runtime.createTerminal('id:folder:fw-1', options)
      expect(await providerFacts(lanes.provider)).toMatchObject({
        shellOverride: 'shellOverride' in options ? options.shellOverride : 'cmd.exe',
        terminalWindowsWslDistro: null
      })
    }
  )

  it('keeps paired-client browser pages and skill discovery on their existing host', async () => {
    setMainPlatform('win32')
    const lanes = startParityLanes(suite, {
      workspace: { ...workspace, projectRuntime: { kind: 'wsl', distro: 'Ubuntu' } },
      settings
    })
    type BrowserHostResolver = {
      resolveBrowserNetworkExecutionHostForWorktree: (worktree: {
        id: string
        hostId: 'local'
      }) => unknown
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrows only visibility of the real browser host resolver for this local folder.
    const browser = lanes.runtime as unknown as BrowserHostResolver
    expect(
      await browser.resolveBrowserNetworkExecutionHostForWorktree({
        id: 'folder:fw-1',
        hostId: 'local'
      })
    ).toMatchObject({ kind: 'native' })
    expect(lanes.runtime.resolveProjectRuntimeForWorktree('folder:fw-1')).toBeUndefined()
  })

  it('rebuilds a pending phone agent tab with its startup cwd and matching shell', async () => {
    setMainPlatform('win32')
    const cwd = '\\\\wsl$\\Ubuntu\\home\\test\\work'
    const lanes = startParityLanes(suite, {
      workspace,
      settings: { ...settings, agentDefaultArgs: { claude: '--name "cost $HOME"' } }
    })
    lanes.runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: 'folder:fw-1',
          publicationEpoch: 'pending-phone',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: [
            {
              type: 'terminal',
              id: `${HOST_TAB_ID}::${HOST_LEAF_ID}`,
              parentTabId: HOST_TAB_ID,
              leafId: HOST_LEAF_ID,
              ptyId: null,
              title: 'Claude',
              isActive: false,
              launchAgent: 'claude',
              startupCwd: cwd
            }
          ]
        }
      ]
    })
    await lanes.runtime.activateMobileSessionTab(
      'id:folder:fw-1',
      `${HOST_TAB_ID}::${HOST_LEAF_ID}`,
      undefined,
      { notifyClients: false }
    )
    expect(await providerFacts(lanes.provider)).toMatchObject({
      command: "claude '--name' 'cost $HOME'",
      shellOverride: 'wsl.exe',
      cwd: cwd.replaceAll('\\', '/')
    })
  })

  it('fails an agent launch needing repair with the existing Settings repair advice', async () => {
    setMainPlatform('win32')
    const lanes = startParityLanes(suite, {
      workspace: { ...workspace, projectRuntime: { kind: 'inherit-global' } },
      settings: { ...settings, localWindowsRuntimeDefault: { kind: 'wsl', distro: null } }
    })
    await expect(
      lanes.runtime.createTerminal('id:folder:fw-1', { startupAgent: 'claude' })
    ).rejects.toThrow('Choose a WSL distro or switch this project to Windows.')
    expect(lanes.provider).not.toHaveBeenCalled()
  })

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
        command: `claude '--name' 'Bob'"'"'s box'`,
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

  it('resolves the worker command override using the folder project shell', async () => {
    setMainPlatform('win32')
    const lanes = startParityLanes(suite, {
      workspace,
      settings: {
        ...settings,
        agentCmdOverrides: { claude: '"C:\\Program Files\\custom-claude.exe"' }
      }
    })
    expect(
      await lanes.runtime.resolveOrchestrationAgentLauncherForTarget('custom-claude', {
        worktree: 'id:folder:fw-1'
      })
    ).toBe('claude')
  })

  it('refuses an unverified OpenCode model in the chosen WSL runtime before spawning', async () => {
    setMainPlatform('win32')
    stubOpenCodeV2()
    const lanes = startParityLanes(suite, {
      workspace: { ...workspace, projectRuntime: { kind: 'wsl', distro: 'Ubuntu' } },
      settings: { ...settings, terminalWindowsShell: 'powershell.exe', agentDefaultArgs: {} }
    })
    expect(
      await lanes.runtime.probeOrchestrationOpenCodeModelLaunchSupport({
        worktree: 'id:folder:fw-1',
        model: OPENCODE_MODEL
      })
    ).toBe(false)
    expect(probeOpenCodeLaunchCapabilities).not.toHaveBeenCalled()
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
