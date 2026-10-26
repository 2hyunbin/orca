import { describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, request?: unknown) => unknown

const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
}))
vi.mock('../wsl/wsl-host-connector', () => ({ createWslHostConnector: vi.fn() }))
vi.mock('../wsl/wsl-host-e2e-fake-connector', () => ({
  createFakeWslHostConnector: vi.fn(),
  readFakeWslHostsConfig: () => null
}))
vi.mock('../orcad/orcad-artifact-materializer', () => ({ hasOrcadTemplate: () => true }))
vi.mock('./runtime-environments/runtime-environment-removal-cleanup', () => ({
  retireRemovedRuntimeEnvironment: vi.fn()
}))
vi.mock('./runtime-environments/runtime-environment-status-probe', () => ({
  getRuntimeEnvironmentStatus: vi.fn()
}))
vi.mock('./runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn()
}))
vi.mock('./runtime-environments/runtime-environment-request-connections', () => ({
  isRemoteRuntimeConnectionReady: () => false
}))
vi.mock('../ssh/orcad-terminal-census-client', () => ({ requestOrcadTerminalCensus: vi.fn() }))
const service = vi.hoisted(() => ({
  add: vi.fn(
    async (): Promise<{
      ok: boolean
      environmentId?: string
      kind?: string
      message?: string
    }> => ({
      ok: true,
      environmentId: 'wsl:Ubuntu'
    })
  ),
  remove: vi.fn(async () => ({ stopped: true })),
  recordForEnvironment: vi.fn(() => ({ distro: 'Ubuntu', environmentId: 'wsl:Ubuntu' }))
}))
vi.mock('../wsl/wsl-host-service-instance', () => ({
  getWslHostService: () => service,
  setWslHostService: vi.fn()
}))

import { registerWslHostHandlers } from './wsl-host-handlers'
import { onWslHostUserAction, type WslHostUserAction } from '../wsl/wsl-host-user-actions'

function register(): void {
  registerWslHostHandlers({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the add and remove handlers run, and they read the active runtime setting alone.
    store: { getSettings: () => ({ activeRuntimeEnvironmentId: null }) } as never,
    getUserDataPath: () => '/user-data',
    invalidateTransport: vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The service is mocked; no other argument is read on this path.
  } as never)
}

describe('WSL host IPC: the user Add and Remove (D3a)', () => {
  it('reports a Remove and a successful Add, so the orchestrator can decline and resume', async () => {
    register()
    const heard: WslHostUserAction[] = []
    const stop = onWslHostUserAction((action) => heard.push(action))
    await handlers.get('wslHosts:remove')?.({}, { environmentId: 'wsl:Ubuntu' })
    await handlers.get('wslHosts:add')?.({}, { distro: 'Ubuntu' })
    service.add.mockResolvedValueOnce({ ok: false, kind: 'failed', message: 'no' })
    await handlers.get('wslHosts:add')?.({}, { distro: 'Debian' })
    stop()
    expect(heard).toEqual([
      { kind: 'removed', distro: 'Ubuntu' },
      { kind: 'added', distro: 'Ubuntu' }
    ])
  })
})
