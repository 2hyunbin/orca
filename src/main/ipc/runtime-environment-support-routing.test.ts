import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import {
  advanceRuntimeEnvironmentCapabilityIncarnation,
  applyRuntimeEnvironmentCapabilityVerdict,
  captureRuntimeEnvironmentCapabilityEvidence,
  resetRuntimeEnvironmentCapabilityEvidence,
  runtimeEnvironmentCapabilityOutcome
} from './runtime-environment-capability-evidence'

const {
  supportsMock,
  clearSupportMock,
  resolveEnvironmentMock,
  subscribeSharedMock,
  subscribeLegacyMock,
  sendSharedMock,
  sendLegacyMock
} = vi.hoisted(() => ({
  supportsMock: vi.fn(),
  clearSupportMock: vi.fn(),
  resolveEnvironmentMock: vi.fn(),
  subscribeSharedMock: vi.fn(),
  subscribeLegacyMock: vi.fn(),
  sendSharedMock: vi.fn(),
  sendLegacyMock: vi.fn()
}))

vi.mock('./runtime-environment-shared-control-support', () => ({
  supportsSharedControl: supportsMock,
  clearSharedControlSupport: clearSupportMock
}))
vi.mock('../../shared/runtime-environment-store', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveEnvironment: resolveEnvironmentMock
}))
vi.mock('./runtime-environment-managed-tunnel', () => ({
  resolveManagedRuntimeEnvironment: async () => resolveEnvironmentMock()
}))
vi.mock('./runtime-environment-abortable-requests', () => ({
  sendRemoteRuntimeSharedControlRequestAbortable: sendSharedMock,
  sendRemoteRuntimeRequestAbortable: sendLegacyMock
}))

vi.mock('./runtime-environment-request-connections', async (importOriginal) => ({
  ...(await importOriginal()),
  subscribeRemoteRuntimeSharedControlRequest: subscribeSharedMock
}))
vi.mock('../../shared/remote-runtime-client', async (importOriginal) => ({
  ...(await importOriginal()),
  subscribeRemoteRuntimeRequest: subscribeLegacyMock
}))
import type { subscribeRemoteRuntimeSharedControlRequest } from './runtime-environment-request-connections'
import type { subscribeRemoteRuntimeRequest } from '../../shared/remote-runtime-client'

import {
  subscribeSupportRoutedRuntimeEnvironment,
  routeRuntimeEnvironmentCallBySupport,
  routeRuntimeEnvironmentSubscriptionBySupport
} from './runtime-environment-support-routing'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

beforeEach(() => {
  resetRuntimeEnvironmentCapabilityEvidence()
  supportsMock.mockReset()
  clearSupportMock.mockReset()
  subscribeSharedMock.mockReset()
  subscribeLegacyMock.mockReset()
  sendSharedMock.mockReset()
  sendLegacyMock.mockReset()
  resolveEnvironmentMock.mockReset()
  resolveEnvironmentMock.mockReturnValue(environment())
})

describe('runtime environment support routing', () => {
  it('re-probes an unpinned stale call exactly once and succeeds', async () => {
    supportsMock
      .mockResolvedValueOnce({ kind: 'stale_incarnation' })
      .mockResolvedValueOnce(acceptedOutcome('capable'))
    const supported = vi.fn().mockResolvedValue(success())
    const unsupported = vi.fn()

    await expect(
      routeRuntimeEnvironmentCallBySupport({
        userDataPath: '/profile',
        initialEnvironment: environment(),
        method: 'repo.list',
        timeoutMs: 100,
        supported,
        unsupported,
        markUsed: vi.fn()
      })
    ).resolves.toMatchObject({ ok: true })

    expect(supportsMock).toHaveBeenCalledTimes(2)
    expect(supported).toHaveBeenCalledOnce()
    expect(unsupported).not.toHaveBeenCalled()
  })

  it('fails a pinned stale call before probing or creating against the replacement', async () => {
    supportsMock.mockResolvedValueOnce({ kind: 'stale_incarnation' })
    resolveEnvironmentMock.mockReturnValue(environment({ pairingRevision: 2 }))
    const supported = vi.fn()
    const unsupported = vi.fn()

    const result = await routeRuntimeEnvironmentCallBySupport({
      userDataPath: '/profile',
      initialEnvironment: environment({ pairingRevision: 1 }),
      expectedPairingRevision: 1,
      method: 'repo.list',
      timeoutMs: 100,
      supported,
      unsupported,
      markUsed: vi.fn()
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'runtime_environment_changed' } })
    expect(supportsMock).toHaveBeenCalledOnce()
    expect(supported).not.toHaveBeenCalled()
    expect(unsupported).not.toHaveBeenCalled()
  })

  it('delivers a response but suppresses identity writes after response-time invalidation', async () => {
    supportsMock.mockResolvedValue(acceptedOutcome('absent'))
    const pending = deferred<ReturnType<typeof success>>()
    const unsupported = vi.fn().mockReturnValue(pending.promise)
    const markUsed = vi.fn()
    const routed = routeRuntimeEnvironmentCallBySupport({
      userDataPath: '/profile',
      initialEnvironment: environment(),
      method: 'repo.list',
      timeoutMs: 100,
      supported: vi.fn(),
      unsupported,
      markUsed
    })
    await vi.waitFor(() => expect(unsupported).toHaveBeenCalledOnce())
    advanceRuntimeEnvironmentCapabilityIncarnation('env')
    pending.resolve(success())

    await expect(routed).resolves.toMatchObject({ ok: true })
    expect(markUsed).not.toHaveBeenCalled()
  })

  it('fails a stale subscription before either factory is touched', async () => {
    const outcome = acceptedOutcome('capable')
    supportsMock.mockImplementation(async () => {
      advanceRuntimeEnvironmentCapabilityIncarnation('env')
      return outcome
    })
    const supported = vi.fn()
    const unsupported = vi.fn()

    await expect(
      routeRuntimeEnvironmentSubscriptionBySupport({
        userDataPath: '/profile',
        environment: environment(),
        timeoutMs: 100,
        isCurrent: () => true,
        supported,
        unsupported
      })
    ).rejects.toThrow('Runtime environment pairing changed')
    expect(supported).not.toHaveBeenCalled()
    expect(unsupported).not.toHaveBeenCalled()
  })
})

function acceptedOutcome(verdict: 'capable' | 'absent', runtimeId = 'runtime') {
  const environmentId = 'env'
  const pairing = {
    v: 2 as const,
    endpoint: 'ws://host',
    deviceToken: 'token',
    publicKeyB64: 'key'
  }
  const evidence = captureRuntimeEnvironmentCapabilityEvidence(
    environmentId,
    pairedRuntimeConnectionFromOffer(pairing)
  )
  applyRuntimeEnvironmentCapabilityVerdict({ evidence, verdict, runtimeId })
  return runtimeEnvironmentCapabilityOutcome(evidence, verdict, runtimeId)
}

function environment(overrides: Partial<KnownRuntimeEnvironment> = {}): KnownRuntimeEnvironment {
  return {
    id: 'env',
    name: 'Environment',
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 1,
    lastUsedAt: null,
    runtimeId: 'runtime',
    endpoints: [
      {
        id: 'ws',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://host',
        deviceToken: 'token',
        publicKeyB64: 'key'
      }
    ],
    preferredEndpointId: 'ws',
    ...overrides
  }
}

function success() {
  return { id: 'repo.list', ok: true as const, result: {}, _meta: { runtimeId: 'runtime' } }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each(['capable', 'absent'] as const)(
  'refuses a pinned close when its main support probe discovers a replacement runtime (%s)',
  async (verdict) => {
    const probe = deferred<ReturnType<typeof acceptedOutcome>>()
    supportsMock.mockReturnValue(probe.promise)
    const closing = callRuntimeEnvironment(
      '/profile',
      'env',
      'session.tabs.close',
      { tabId: 'agent-session:starting' },
      100,
      1,
      undefined,
      { expectedEnvironmentRuntimeId: 'runtime' }
    )
    await vi.waitFor(() => expect(supportsMock).toHaveBeenCalledOnce())
    resolveEnvironmentMock.mockReturnValue(environment({ runtimeId: 'replacement' }))
    probe.resolve(acceptedOutcome(verdict, 'replacement'))

    await expect(closing).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_environment_changed' }
    })
    expect(sendSharedMock).not.toHaveBeenCalled()
    expect(sendLegacyMock).not.toHaveBeenCalled()
  }
)

it.each(['capable', 'absent'] as const)(
  'does not trust replacement support evidence even before the saved runtime updates (%s)',
  async (verdict) => {
    supportsMock.mockResolvedValue(acceptedOutcome(verdict, 'replacement'))
    const supported = vi.fn()
    const unsupported = vi.fn()
    const result = await routeRuntimeEnvironmentCallBySupport({
      userDataPath: '/profile',
      initialEnvironment: environment(),
      method: 'session.tabs.close',
      timeoutMs: 100,
      expectedRuntimeId: 'runtime',
      supported,
      unsupported,
      markUsed: vi.fn()
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'runtime_environment_changed' } })
    expect(supported).not.toHaveBeenCalled()
    expect(unsupported).not.toHaveBeenCalled()
  }
)

it('preserves the runtime fence when a stale support result triggers a retry', async () => {
  supportsMock.mockImplementation(async () => {
    resolveEnvironmentMock.mockReturnValue(environment({ runtimeId: 'replacement' }))
    return { kind: 'stale_incarnation' }
  })
  const supported = vi.fn()
  const unsupported = vi.fn()
  const result = await routeRuntimeEnvironmentCallBySupport({
    userDataPath: '/profile',
    initialEnvironment: environment(),
    method: 'session.tabs.close',
    timeoutMs: 100,
    expectedRuntimeId: 'runtime',
    supported,
    unsupported,
    markUsed: vi.fn()
  })
  expect(result).toMatchObject({ ok: false, error: { code: 'runtime_environment_changed' } })
  expect(supportsMock).toHaveBeenCalledOnce()
  expect(supported).not.toHaveBeenCalled()
  expect(unsupported).not.toHaveBeenCalled()
})

it.each(['capable', 'absent'] as const)(
  'allows a pinned call through the %s route when the runtime still matches',
  async (verdict) => {
    supportsMock.mockResolvedValue(acceptedOutcome(verdict))
    const supported = vi.fn().mockResolvedValue(success())
    const unsupported = vi.fn().mockResolvedValue(success())
    await expect(
      routeRuntimeEnvironmentCallBySupport({
        userDataPath: '/profile',
        initialEnvironment: environment(),
        method: 'session.tabs.close',
        timeoutMs: 100,
        expectedRuntimeId: 'runtime',
        supported,
        unsupported,
        markUsed: vi.fn()
      })
    ).resolves.toMatchObject({ ok: true })
    expect(verdict === 'capable' ? supported : unsupported).toHaveBeenCalledOnce()
    expect(verdict === 'capable' ? unsupported : supported).not.toHaveBeenCalled()
  }
)

it('cancels only the waiting subscription while a sibling waits on the same support probe', async () => {
  const probe = deferred<ReturnType<typeof acceptedOutcome>>()
  supportsMock.mockReturnValue(probe.promise)
  const supported = vi.fn().mockResolvedValue({ requestId: 'sibling' })
  const unsupported = vi.fn()
  const controller = new AbortController()
  const args = {
    userDataPath: '/profile',
    environment: environment(),
    timeoutMs: 1000,
    isCurrent: () => true,
    supported,
    unsupported
  }
  const abandoned = routeRuntimeEnvironmentSubscriptionBySupport({
    ...args,
    signal: controller.signal
  })
  const sibling = routeRuntimeEnvironmentSubscriptionBySupport(args)
  const rejection = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejection
  expect(supported).not.toHaveBeenCalled()
  probe.resolve(acceptedOutcome('capable'))
  await expect(sibling).resolves.toMatchObject({ subscription: { requestId: 'sibling' } })
  expect(supported).toHaveBeenCalledOnce()
  expect(unsupported).not.toHaveBeenCalled()
})

it.each(['capable', 'absent'] as const)(
  'forwards consumer cancellation into the %s subscription setup',
  async (verdict) => {
    supportsMock.mockResolvedValue(acceptedOutcome(verdict))
    const setup = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    subscribeSharedMock.mockImplementation(
      (...args: Parameters<typeof subscribeRemoteRuntimeSharedControlRequest>) => setup(args[6])
    )
    subscribeLegacyMock.mockImplementation(
      (...args: Parameters<typeof subscribeRemoteRuntimeRequest>) => setup(args[5]?.signal)
    )
    const controller = new AbortController()
    const pending = subscribeSupportRoutedRuntimeEnvironment({
      userDataPath: '/profile',
      environment: environment(),
      method: 'files.watch',
      params: {},
      timeoutMs: 1000,
      callbacks: { onEvent: vi.fn(), onClose: vi.fn() },
      isCurrent: () => true,
      signal: controller.signal
    })
    await vi.waitFor(() => expect(setup).toHaveBeenCalledWith(controller.signal))
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(setup).toHaveBeenCalledOnce()
  }
)
