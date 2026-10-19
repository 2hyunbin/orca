import { describe, expect, it, vi } from 'vitest'
import { makeDeferred } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { shouldDropRendererPtyData } from './pty-hidden-delivery-gate'
import { openTestRendererPage } from './pty-ipc-test-pane-attachments'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { registerPtyHandlers } from './pty/register-handlers'

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
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

type RuntimeSpawnController = {
  spawn: (args: { cols: number; rows: number; sessionId?: string }) => Promise<{ id: string }>
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test doubles implement only the members these spawn paths read.
const testDouble = <T>(value: unknown): T => value as T

describe('runtime-controller spawn: main owns delivery until a window connection consumes', () => {
  const {
    mainWindow,
    mainWindowIpcEvent,
    installObservableDaemonTestProvider,
    getPtySetRendererPtyConsumerListener,
    getPtySetRendererPtyVisibleListener,
    getPtyDataSendCalls
  } = setupPtyIpcSuite()

  function createRuntimeMock() {
    return {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn(() => 42),
      getPtyOutputSequence: vi.fn(() => 42),
      hasRemoteTerminalViewSubscriber: vi.fn(() => false),
      registerPreAllocatedHandleForPty: vi.fn()
    }
  }

  function installController(runtime: { setPtyController: ReturnType<typeof vi.fn> }) {
    registerPtyHandlers(testDouble(mainWindow), testDouble(runtime))
    return testDouble<RuntimeSpawnController>(runtime.setPtyController.mock.calls[0]?.[0])
  }

  it("is main's from before spawn resolves, with no hidden flag to carry", async () => {
    const runtime = createRuntimeMock()
    const daemon = installObservableDaemonTestProvider()
    const spawnGate = makeDeferred()
    let mintedSessionId: string | undefined
    daemon.spawn.mockImplementation(async (options: { sessionId?: string }) => {
      mintedSessionId = options.sessionId
      await spawnGate.promise
      return { id: options.sessionId ?? 'daemon-pty' }
    })
    const controller = installController(runtime)

    const spawnPromise = controller.spawn({ cols: 80, rows: 24 })
    await vi.waitFor(() => expect(mintedSessionId).toBeDefined())
    // Byte zero (Muse's startup queries) must already be main's to answer.
    expect(shouldDropRendererPtyData(mintedSessionId!, {})).toBe(true)

    spawnGate.resolve()
    const result = await spawnPromise
    expect(shouldDropRendererPtyData(result.id, {})).toBe(true)
    expect(daemon.setPtyBackgrounded).toHaveBeenLastCalledWith(result.id, true)
  })

  it('delivers to a view that attaches, and returns to main when its page reloads', async () => {
    const runtime = createRuntimeMock()
    const daemon = installObservableDaemonTestProvider()
    const controller = installController(runtime)

    const result = await controller.spawn({ cols: 80, rows: 24 })
    getPtySetRendererPtyVisibleListener()(null, { id: result.id, visible: true })
    expect(daemon.setPtyBackgrounded).toHaveBeenLastCalledWith(result.id, false)
    expect(shouldDropRendererPtyData(result.id, {})).toBe(false)

    // The reload ends that connection; nothing consumes until the new page attaches.
    openTestRendererPage(mainWindowIpcEvent, 'reloaded-page')
    expect(shouldDropRendererPtyData(result.id, {})).toBe(true)
    expect(daemon.setPtyBackgrounded).toHaveBeenLastCalledWith(result.id, true)
  })

  it('delivers byte one to a view that attached before spawn committed', async () => {
    const runtime = createRuntimeMock()
    const daemon = installObservableDaemonTestProvider()
    const spawnGate = makeDeferred()
    let mintedSessionId: string | undefined
    daemon.spawn.mockImplementation(async (options: { sessionId?: string }) => {
      mintedSessionId = options.sessionId
      await spawnGate.promise
      return { id: options.sessionId ?? 'daemon-pty' }
    })
    const controller = installController(runtime)

    const spawnPromise = controller.spawn({ cols: 80, rows: 24 })
    await vi.waitFor(() => expect(mintedSessionId).toBeDefined())
    getPtySetRendererPtyVisibleListener()(null, { id: mintedSessionId!, visible: true })
    spawnGate.resolve()
    const result = await spawnPromise

    daemon.emitData(result.id, 'visible output')
    await vi.waitFor(() =>
      expect(getPtyDataSendCalls()).toContainEqual([
        'pty:data',
        expect.objectContaining({ id: result.id, data: 'visible output' })
      ])
    )
  })

  it('keeps delivering a reattached session a window connection already consumes', async () => {
    const runtime = createRuntimeMock()
    const daemon = installObservableDaemonTestProvider()
    daemon.spawn.mockImplementation(async (options: { sessionId?: string }) => ({
      id: options.sessionId ?? 'daemon-pty',
      isReattach: true
    }))
    const controller = installController(runtime)
    getPtySetRendererPtyConsumerListener()(null, { id: 'existing-session', consuming: true })

    const result = await controller.spawn({ cols: 80, rows: 24, sessionId: 'existing-session' })
    expect(shouldDropRendererPtyData(result.id, {})).toBe(false)
  })

  it('answers a startup cursor-position query from the model with no renderer view', async () => {
    const daemon = installObservableDaemonTestProvider()
    const runtime = new OrcaRuntimeService(
      testDouble({
        getRepo: () => undefined,
        getRepos: () => [],
        addRepo: () => {},
        updateRepo: () => undefined,
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        setWorktreeMeta: () => undefined,
        removeWorktreeMeta: () => {},
        getGitHubCache: () => ({ pr: {}, issue: {} }),
        getSettings: () => ({
          workspaceDir: '/tmp/workspaces',
          nestWorkspaces: false,
          refreshLocalBaseRefOnWorktreeCreate: false,
          branchPrefix: 'none',
          branchPrefixCustom: '',
          terminalMainSideEffectAuthority: true,
          terminalHiddenDeliveryGate: true,
          terminalModelQueryAuthority: true
        })
      })
    )
    const setPtyController = vi.spyOn(runtime, 'setPtyController')
    registerPtyHandlers(testDouble(mainWindow), runtime)
    const controller = testDouble<RuntimeSpawnController>(setPtyController.mock.calls[0]?.[0])

    const result = await controller.spawn({ cols: 80, rows: 24 })
    daemon.emitData(result.id, '\x1b[6n')
    await runtime.serializeMainTerminalBuffer(result.id)

    expect(daemon.write).toHaveBeenCalledWith(result.id, '\x1b[1;1R')
  })
})
