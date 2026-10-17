import { beforeEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { setAppEnvironment } from '../../shared/app-environment'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-idle-exit'
import { createAdapter } from '../daemon/daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import { installDaemonProvider, replaceDaemonProvider } from '../daemon/daemon-provider-state'
import type { DaemonIdleRetirementResult } from '../daemon/daemon-pty-runtime-state'
import { PROTOCOL_VERSION } from '../daemon/types'
import { getLocalPtyProvider } from '../ipc/pty/provider/registry'
import { restartDaemon } from '../daemon/daemon-provider-restart'
import { bindOrcadIdleShutdown, beginOrcadIdleExit } from './orcad-managed-idle-exit-host'
import { installOrcadManagedIdleExit } from './orcad-managed-idle-exit'
import type * as ManagedIdleExit from './orcad-managed-idle-exit'

const { hasLoadedProviders } = vi.hoisted(() => ({ hasLoadedProviders: vi.fn(() => false) }))

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ hasLoadedProviders })
}))
vi.mock('../daemon/daemon-provider-restart', () => ({ restartDaemon: vi.fn() }))
vi.mock('./orcad-idle-stop-record', () => ({
  consumeOrcadIdleStopRecord: vi.fn(() => null),
  discardOrcadIdleStopRecord: vi.fn(),
  writeOrcadIdleStopRecord: vi.fn()
}))
vi.mock('./orcad-managed-idle-exit', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedIdleExit>()),
  installOrcadManagedIdleExit: vi.fn(() => () => {})
}))

function freshRouter(retirement?: Promise<DaemonIdleRetirementResult>): DaemonPtyRouter {
  const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
  if (retirement) {
    vi.mocked(current.requestIdleRetirement).mockImplementation(() => retirement)
  }
  return new DaemonPtyRouter({ current, legacy: [] })
}

async function stopWithReturningClient(retirementState: DaemonIdleRetirementResult) {
  const retire = Promise.withResolvers<DaemonIdleRetirementResult>()
  installDaemonProvider(null, freshRouter(retire.promise))
  const activity = { openConnections: 0, requestsInFlight: 0, lastRequestAt: 0 }
  const shutdown = vi.fn(() => true)
  bindOrcadIdleShutdown(shutdown)
  await beginOrcadIdleExit('test-profile').start({
    rpc: { readClientActivity: () => activity },
    agentStates: () => [],
    hasStagedMigration: () => false,
    automationsBusy: () => false,
    registerCleanup: () => {}
  })
  const installed = vi.mocked(installOrcadManagedIdleExit).mock.calls.at(-1)?.[0]
  if (!installed) {
    throw new Error('idle monitor was not installed')
  }
  const stopping = installed.stop({ quietSince: 0, stoppedAt: 900_000, timeoutMs: 900_000 })
  await vi.waitFor(() =>
    expect(getLocalPtyProvider().spawn({ cols: 80, rows: 24 })).rejects.toThrow('decommissioning')
  )
  activity.openConnections = 1
  retire.resolve(retirementState)
  return { stopped: await stopping, shutdown }
}

beforeEach(() => {
  vi.clearAllMocks()
  hasLoadedProviders.mockReturnValue(false)
  vi.stubEnv(ORCAD_MANAGED_ACTIVATION_ROOT_ENV, 'test-fence')
  setAppEnvironment({
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  vi.mocked(restartDaemon).mockImplementation(async () => {
    replaceDaemonProvider(freshRouter())
    return { killedCount: 0 }
  })
})

it('serves new terminals when a client returns after the daemon retired', async () => {
  const { stopped, shutdown } = await stopWithReturningClient({ state: 'retiring' })

  await expect(getLocalPtyProvider().spawn({ cols: 80, rows: 24 })).resolves.toEqual({
    id: 'current-new'
  })
  expect(stopped).toBe(false)
  expect(shutdown).not.toHaveBeenCalled()
  expect(restartDaemon).toHaveBeenCalledOnce()
})

it('finishes the stop when the retired daemon cannot be replaced', async () => {
  vi.mocked(restartDaemon).mockRejectedValueOnce(new Error('spawn failed'))
  const { stopped, shutdown } = await stopWithReturningClient({ state: 'retiring' })

  expect(stopped).toBe(true)
  expect(shutdown).toHaveBeenCalledWith('idle', expect.any(Function))
})

it('never replaces a daemon that kept its admission open', async () => {
  const { stopped, shutdown } = await stopWithReturningClient({
    state: 'busy',
    liveSessions: 1,
    admissionReopened: true
  })

  expect(stopped).toBe(false)
  expect(shutdown).not.toHaveBeenCalled()
  expect(restartDaemon).not.toHaveBeenCalled()
  await expect(getLocalPtyProvider().spawn({ cols: 80, rows: 24 })).resolves.toEqual({
    id: 'current-new'
  })
})
