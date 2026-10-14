import { beforeEach, expect, it, vi } from 'vitest'
import { RuntimeRpcCallQueuePool } from '../../shared/runtime-rpc-call-queue'
import { resolveSelectedSessionByHost } from './ai-vault-selected-session'
import { AI_VAULT_SELECTED_SESSION_CAPABILITY } from '../../shared/ai-vault-selected-session'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { listResult } from '../ai-vault/structured-session-ownership.test-support'

const mocks = vi.hoisted(() => ({
  environment: vi.fn(),
  refresh: vi.fn(),
  send: vi.fn(),
  mark: vi.fn(),
  enqueue: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: mocks.environment,
  markEnvironmentUsed: mocks.mark
}))
vi.mock('./runtime-environment-managed-tunnel', () => ({
  resolveManagedRuntimeEnvironment: () => mocks.environment()
}))
vi.mock('./runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusOwner: () => ({ refresh: mocks.refresh })
}))
vi.mock('./runtime-environment-status-diagnostics', () => ({
  attachRemoteControlDiagnostics: (response: unknown) => response
}))
vi.mock('./runtime-environment-manual-disconnect', () => ({
  isRuntimeEnvironmentManuallyDisconnected: () => false
}))
vi.mock('./runtime-environment-call-queue', () => ({ enqueueRuntimeCall: mocks.enqueue }))
vi.mock('./runtime-environment-shared-control-support', () => ({
  resetSharedControlSupport: vi.fn()
}))
vi.mock('./runtime-environment-support-routing', () => ({
  shouldUseSharedControlEnvelope: () => undefined,
  shouldRouteCallBySupport: () => false,
  shouldRouteSubscriptionBySupport: () => false
}))
vi.mock('./runtime-environment-abortable-requests', () => ({
  sendRemoteRuntimeRequestAbortable: mocks.send
}))

const source = { kind: 'chat', sessionId: 'chat-1', workspaceId: 'workspace-1' } as const
const args = { source, executionHostId: 'runtime:server-1', requestToken: 'pairing' } as const
let environment: KnownRuntimeEnvironment
let queue: RuntimeRpcCallQueuePool
beforeEach(() => {
  vi.clearAllMocks()
  environment = {
    id: 'server-1',
    name: 'Host',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    pairingRevision: 1,
    runtimeId: 'runtime-1',
    preferredEndpointId: 'ws',
    endpoints: [
      {
        id: 'ws',
        kind: 'websocket',
        label: 'Host',
        endpoint: 'ws://host',
        deviceToken: 'token',
        publicKeyB64: 'key'
      }
    ]
  }
  mocks.environment.mockImplementation(() => environment)
  queue = new RuntimeRpcCallQueuePool(1)
  mocks.enqueue.mockImplementation((id, method, run, signal) =>
    queue.enqueue(id, method, run, 0, signal)
  )
})
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each([true, false])(
  'pins status, queued and sent lookup to its original pairing (modern=%s)',
  async (modern) => {
    const status = {
      id: 'status.get',
      ok: true,
      result: { capabilities: modern ? [AI_VAULT_SELECTED_SESSION_CAPABILITY] : [] },
      _meta: { runtimeId: 'runtime-1' }
    }
    mocks.refresh.mockResolvedValue(status)
    const held = deferred<void>()
    const blocker = queue.enqueue('server-1', 'repo.list', () => held.promise)
    const pending = resolveSelectedSessionByHost(args, vi.fn(), '/profile')
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce())
    environment = { ...environment, pairingRevision: 2 }
    held.resolve()
    await blocker
    await expect(pending).rejects.toThrow('pairing changed')
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.mark).not.toHaveBeenCalled()

    environment = { ...environment, pairingRevision: 1 }
    const result = modern ? { status: 'missing' } : listResult()
    const response = { id: 'lookup', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
    const sent = deferred<typeof response>()
    mocks.send.mockReturnValue(sent.promise)
    const inFlight = resolveSelectedSessionByHost(args, vi.fn(), '/profile')
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
    environment = { ...environment, pairingRevision: 2 }
    sent.resolve(response)
    await expect(inFlight).rejects.toThrow('pairing changed')
    expect(mocks.mark).not.toHaveBeenCalled()

    environment = { ...environment, pairingRevision: 1 }
    mocks.send.mockResolvedValue(response)
    await expect(resolveSelectedSessionByHost(args, vi.fn(), '/profile')).resolves.toMatchObject({
      status: 'missing'
    })
    expect(mocks.mark).toHaveBeenCalledOnce()
    expect(mocks.send.mock.calls.at(-1)?.[1]).toBe(
      modern ? 'aiVault.resolveSession' : 'aiVault.listSessions'
    )

    const probe = deferred<typeof status>()
    mocks.refresh.mockReturnValue(probe.promise)
    const probing = resolveSelectedSessionByHost(args, vi.fn(), '/profile')
    environment = { ...environment, pairingRevision: 2 }
    probe.resolve(status)
    await expect(probing).rejects.toThrow('pairing changed')
    expect(mocks.send).toHaveBeenCalledTimes(2)
  }
)
