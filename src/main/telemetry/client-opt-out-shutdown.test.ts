import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as telemetryClient from './client'
import type * as posthogTransport from './posthog-transport'
import {
  makeFakeSettings,
  makeFakeStore,
  makeMockPostHog,
  type MockPostHog
} from './client-test-harness'

describe('in-flight opt-out shutdown budget', () => {
  let client: typeof telemetryClient
  let sdk: MockPostHog
  let releaseImport: () => void
  const createClient = vi.fn()
  const settings = makeFakeSettings({
    installId: 'shutdown-test',
    optedIn: true,
    existedBeforeTelemetryRelease: false
  })
  const store = makeFakeStore(settings)

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('ORCA_BUILD_IDENTITY', 'stable')
    vi.stubGlobal('ORCA_POSTHOG_WRITE_KEY', 'test-key')
    for (const key of [
      'DO_NOT_TRACK',
      'ORCA_TELEMETRY_DISABLED',
      'CI',
      'GITHUB_ACTIONS',
      'GITLAB_CI',
      'CIRCLECI',
      'TRAVIS',
      'BUILDKITE',
      'JENKINS_URL',
      'TEAMCITY_VERSION'
    ]) {
      vi.stubEnv(key, undefined)
    }
    sdk = makeMockPostHog()
    createClient.mockReset().mockReturnValue(sdk)
    const moduleGate = new Promise<void>((resolve) => {
      releaseImport = resolve
    })
    const { waitForCaptureEnqueue } =
      await vi.importActual<typeof posthogTransport>('./posthog-transport')
    vi.doMock('./posthog-transport', async () => {
      await moduleGate
      return { createPostHogClient: createClient, waitForCaptureEnqueue }
    })
    settings.telemetry!.optedIn = true
    client = await import('./client')
    client.initTelemetry(store)
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await client.shutdownTelemetry()
    vi.doUnmock('./posthog-transport')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('includes capture enqueue and SDK opt-out before draining with only the remaining budget', async () => {
    sdk.capture.mockImplementation((capture: { event: string; uuid: string }) => {
      setTimeout(() => sdk.emitForTests('capture', capture), 200)
    })
    const optingOut = client.setOptIn('settings', false)
    const closing = client.shutdownTelemetry()
    await vi.advanceTimersByTimeAsync(1_500)
    releaseImport()
    await vi.advanceTimersByTimeAsync(0)
    expect(sdk.capture).toHaveBeenCalledTimes(1)
    expect(sdk.optOut).not.toHaveBeenCalled()
    expect(sdk.shutdown).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    await Promise.all([optingOut, closing])
    expect(sdk.optOut).toHaveBeenCalledTimes(1)
    expect(sdk.shutdown).toHaveBeenCalledWith(300)
  })

  it('ends a missing SDK enqueue at the shared deadline and releases its listener', async () => {
    const stopListening = vi.fn()
    sdk.on.mockReturnValue(stopListening)
    sdk.capture.mockImplementation(() => {})
    const optingOut = client.setOptIn('settings', false)
    const closing = client.shutdownTelemetry()
    await vi.advanceTimersByTimeAsync(1_500)
    releaseImport()
    await vi.advanceTimersByTimeAsync(0)
    expect(sdk.capture).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    await Promise.all([optingOut, closing])
    expect(stopListening).toHaveBeenCalledTimes(1)
    expect(sdk.optOut).toHaveBeenCalledTimes(1)
    expect(sdk.shutdown).toHaveBeenCalledExactlyOnceWith(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sdk.capture).toHaveBeenCalledTimes(1)
    expect(sdk.shutdown).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('checks the absolute deadline before constructing even before the timeout callback runs', async () => {
    const optingOut = client.setOptIn('settings', false)
    const closing = client.shutdownTelemetry()
    vi.setSystemTime(Date.now() + 2_001)
    releaseImport()
    await Promise.all([optingOut, closing])
    expect(createClient).not.toHaveBeenCalled()
    expect(sdk.capture).not.toHaveBeenCalled()
  })

  it('does not capture if construction consumes the remaining shutdown budget', async () => {
    createClient.mockImplementationOnce(() => {
      vi.setSystemTime(Date.now() + 2_001)
      return sdk
    })
    const optingOut = client.setOptIn('settings', false)
    const closing = client.shutdownTelemetry()
    releaseImport()
    await Promise.all([optingOut, closing])
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(sdk.capture).not.toHaveBeenCalled()
    expect(sdk.optOut).toHaveBeenCalledTimes(1)
    expect(sdk.shutdown).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('does not extend the deadline when the final SDK drain stalls', async () => {
    sdk.shutdown.mockImplementationOnce(() => new Promise(() => {}))
    const optingOut = client.setOptIn('settings', false)
    const closing = client.shutdownTelemetry()
    await vi.advanceTimersByTimeAsync(1_500)
    releaseImport()
    await vi.advanceTimersByTimeAsync(0)
    await optingOut
    expect(sdk.shutdown).toHaveBeenCalledWith(500)
    await vi.advanceTimersByTimeAsync(500)
    await closing
    expect(client.track('app_opened', {})).toBe(false)
    expect(sdk.capture).toHaveBeenCalledTimes(1)
  })

  it('retires the SDK when opt-out finishes after the absolute deadline', async () => {
    sdk.optOut.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 2_001)
    })
    const optingOut = client.setOptIn('settings', false)
    const closing = client.shutdownTelemetry()
    releaseImport()
    await Promise.all([optingOut, closing])
    expect(sdk.shutdown).toHaveBeenCalledExactlyOnceWith(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts SDK cleanup at the deadline while an admitted opt-out is still pending', async () => {
    const failure = new Error('transport shutdown failed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sdk.shutdown.mockRejectedValueOnce(failure)
    let finishOptOut = (): void => {}
    sdk.optOut.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishOptOut = resolve))
    )
    const optingOut = client.setOptIn('settings', false)
    const closing = client.shutdownTelemetry()
    releaseImport()
    await vi.advanceTimersByTimeAsync(0)
    expect(sdk.optOut).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    await closing
    expect(sdk.shutdown).toHaveBeenCalledExactlyOnceWith(0)
    expect(warn).toHaveBeenCalledExactlyOnceWith('[telemetry] shutdown error (ignored):', failure)
    finishOptOut()
    await optingOut
    expect(sdk.shutdown).toHaveBeenCalledExactlyOnceWith(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['DO_NOT_TRACK', 'ORCA_TELEMETRY_DISABLED', 'CI'])(
    'respects %s revocation while quit joins an admitted opt-out import',
    async (key) => {
      const optingOut = client.setOptIn('settings', false)
      const closing = client.shutdownTelemetry()
      vi.stubEnv(key, '1')
      releaseImport()
      await Promise.all([optingOut, closing])
      expect(createClient).not.toHaveBeenCalled()
      expect(sdk.capture).not.toHaveBeenCalled()
    }
  )

  it('rechecks privacy before capturing after construction during quit', async () => {
    createClient.mockImplementationOnce(() => {
      vi.stubEnv('DO_NOT_TRACK', '1')
      return sdk
    })
    const optingOut = client.setOptIn('settings', false)
    const closing = client.shutdownTelemetry()
    releaseImport()
    await Promise.all([optingOut, closing])
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(sdk.capture).not.toHaveBeenCalled()
    expect(sdk.optOut).toHaveBeenCalledTimes(1)
  })

  it('does not admit a new explicit opt-out after quit has started', async () => {
    await client.shutdownTelemetry()
    await client.setOptIn('settings', false)
    expect(settings.telemetry?.optedIn).toBe(false)
    expect(createClient).not.toHaveBeenCalled()
    expect(sdk.capture).not.toHaveBeenCalled()
  })
})
