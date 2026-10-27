import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as telemetryClient from './client'
import { DeferredTelemetryTransport } from './deferred-transport'
import { MAX_QUEUED_CAPTURES } from './capture-queue-limit'
import {
  makeFakeSettings,
  makeFakeStore,
  makeMockPostHog,
  type MockPostHog
} from './client-test-harness'

describe('deferred telemetry transport', () => {
  let client: typeof telemetryClient
  let sdk: MockPostHog
  let moduleLoads: number
  let moduleGate: Promise<void> | null
  const createClient = vi.fn()
  const settings = makeFakeSettings({
    installId: 'startup-test',
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
    moduleLoads = 0
    moduleGate = null
    sdk = makeMockPostHog()
    createClient.mockReset().mockReturnValue(sdk)
    vi.doMock('./posthog-transport', async () => {
      moduleLoads += 1
      await moduleGate
      return {
        createPostHogClient: createClient,
        waitForCaptureEnqueue: async () => true
      }
    })
    settings.telemetry = {
      installId: 'startup-test',
      optedIn: true,
      existedBeforeTelemetryRelease: false
    }
    client = await import('./client')
    client.initTelemetry(store)
  })

  afterEach(async () => {
    await client.shutdownTelemetry()
    vi.doUnmock('./posthog-transport')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('queues validated startup captures without loading the SDK and flushes once after paint', async () => {
    expect(client.track('app_opened', {})).toBe(true)
    expect(client.track('telemetry_opted_in', { via: 'settings' })).toBe(true)
    expect(client.track('app_opened', { nth_repo_added: Number.NaN })).toBe(false)
    expect(moduleLoads).toBe(0)
    expect(sdk.capture).not.toHaveBeenCalled()

    const first = client.startTelemetryTransport()
    expect(client.startTelemetryTransport()).toBe(first)
    await first
    await client.startTelemetryTransport()

    expect(createClient).toHaveBeenCalledTimes(1)
    expect(sdk.capture.mock.calls.map(([capture]) => capture.event)).toEqual([
      'app_opened',
      'telemetry_opted_in'
    ])
  })

  it.each(['user', 'environment', 'contributor'] as const)(
    'does not import or construct the SDK for disabled %s startup',
    async (reason) => {
      if (reason === 'user') {
        settings.telemetry!.optedIn = false
      } else if (reason === 'environment') {
        vi.stubEnv('DO_NOT_TRACK', '1')
      } else {
        vi.stubGlobal('ORCA_BUILD_IDENTITY', null)
        vi.resetModules()
        client = await import('./client')
        client.initTelemetry(store)
      }
      expect(client.track('app_opened', {})).toBe(false)
      await client.startTelemetryTransport()
      expect(moduleLoads).toBe(0)
      expect(createClient).not.toHaveBeenCalled()
    }
  )

  it('checks consent again before constructing a client and discards opted-out captures', async () => {
    client.track('app_opened', {})
    const loading = client.startTelemetryTransport()
    settings.telemetry!.optedIn = false
    await loading
    expect(createClient).not.toHaveBeenCalled()
    settings.telemetry!.optedIn = true
    await client.startTelemetryTransport()
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(sdk.capture).not.toHaveBeenCalled()
  })

  it.each(['before start', 'during import'] as const)(
    'drains accepted short-session events on shutdown %s and fences new captures',
    async (phase) => {
      client.trackAppOpenedOnce()
      expect(client.track('telemetry_opted_in', { via: 'settings' })).toBe(true)
      const loading = phase === 'during import' ? client.startTelemetryTransport() : null
      const closing = client.shutdownTelemetry()
      expect(client.track('app_opened', {})).toBe(false)
      await closing
      await loading
      await client.startTelemetryTransport()
      expect(createClient).toHaveBeenCalledTimes(1)
      expect(sdk.capture.mock.calls.map(([capture]) => capture.event)).toEqual([
        'app_opened',
        'telemetry_opted_in'
      ])
      expect(sdk.shutdown).toHaveBeenCalledTimes(1)
      expect(sdk.shutdown.mock.calls[0]?.[0]).toBeGreaterThan(0)
      expect(sdk.shutdown.mock.calls[0]?.[0]).toBeLessThanOrEqual(2_000)
    }
  )

  it('does not construct an unused late client after shutdown', async () => {
    const loading = client.startTelemetryTransport()
    await client.shutdownTelemetry()
    await loading
    expect(createClient).not.toHaveBeenCalled()
  })

  it('does not construct a client when the import exceeds the shutdown budget', async () => {
    vi.useFakeTimers()
    let releaseImport = (): void => {}
    moduleGate = new Promise((resolve) => {
      releaseImport = resolve
    })
    client.track('app_opened', {})
    const loading = client.startTelemetryTransport()
    const closing = client.shutdownTelemetry()
    await vi.advanceTimersByTimeAsync(2_000)
    await closing
    releaseImport()
    await loading
    expect(createClient).not.toHaveBeenCalled()
    expect(sdk.capture).not.toHaveBeenCalled()
  })

  it('includes import time in the shutdown budget', async () => {
    vi.useFakeTimers()
    let releaseImport = (): void => {}
    moduleGate = new Promise((resolve) => {
      releaseImport = resolve
    })
    client.track('app_opened', {})
    const closing = client.shutdownTelemetry()
    await vi.advanceTimersByTimeAsync(500)
    releaseImport()
    await closing
    expect(sdk.capture).toHaveBeenCalledTimes(1)
    expect(sdk.shutdown).toHaveBeenCalledWith(1_500)
  })

  it('checks the deadline before construction even if the timeout callback has not run', async () => {
    vi.useFakeTimers()
    let releaseImport = (): void => {}
    moduleGate = new Promise((resolve) => {
      releaseImport = resolve
    })
    client.track('app_opened', {})
    const closing = client.shutdownTelemetry()
    vi.setSystemTime(Date.now() + 2_001)
    releaseImport()
    await closing
    expect(createClient).not.toHaveBeenCalled()
  })

  it('checks consent again while importing for a short-session shutdown', async () => {
    let releaseImport = (): void => {}
    moduleGate = new Promise((resolve) => {
      releaseImport = resolve
    })
    client.track('app_opened', {})
    const closing = client.shutdownTelemetry()
    settings.telemetry!.optedIn = false
    releaseImport()
    await closing
    expect(createClient).not.toHaveBeenCalled()
  })

  it('bounds shutdown even if the SDK never settles', async () => {
    await client.startTelemetryTransport()
    sdk.shutdown.mockImplementationOnce(() => new Promise(() => {}))
    vi.useFakeTimers()
    const closing = client.shutdownTelemetry()
    await vi.advanceTimersByTimeAsync(2_000)
    await closing
    expect(client.track('app_opened', {})).toBe(false)
  })

  it.each(['opt_out', 'pending_banner', 'environment'] as const)(
    'discards accepted events without importing on shutdown after %s',
    async (reason) => {
      client.trackAppOpenedOnce()
      if (reason === 'environment') {
        vi.stubEnv('DO_NOT_TRACK', '1')
      } else {
        settings.telemetry!.optedIn = reason === 'opt_out' ? false : null
      }
      await client.shutdownTelemetry()
      expect(moduleLoads).toBe(0)
      expect(createClient).not.toHaveBeenCalled()
    }
  )

  it('preserves capture time while startup delivery is deferred', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T10:00:00Z'))
    client.track('app_opened', {})
    vi.setSystemTime(new Date('2026-10-26T10:00:15Z'))
    await client.startTelemetryTransport()
    expect(sdk.capture.mock.calls[0]?.[0].timestamp).toEqual(new Date('2026-10-26T10:00:00Z'))
  })

  it('does not replay queued events after consent is disabled before starting', async () => {
    client.trackAppOpenedOnce()
    settings.telemetry!.optedIn = false
    await client.startTelemetryTransport()
    expect(moduleLoads).toBe(0)
    settings.telemetry!.optedIn = true
    await client.startTelemetryTransport()
    expect(sdk.capture).not.toHaveBeenCalled()
    client.trackAppOpenedOnce()
    expect(sdk.capture).toHaveBeenCalledTimes(1)
  })

  it('retries app_opened after consent drops its queued capture', async () => {
    client.trackAppOpenedOnce()
    await client.setOptIn('settings', false)
    await client.setOptIn('settings', true)
    expect(
      sdk.capture.mock.calls.filter(([capture]) => capture.event === 'app_opened')
    ).toHaveLength(1)
  })

  it.each(['pending banner', 'enabled'] as const)(
    'starts only the explicit opt-out for pre-start %s consent',
    async (consent) => {
      settings.telemetry!.optedIn = consent === 'pending banner' ? null : true
      client.initTelemetry(store)
      client.trackAppOpenedOnce()
      let releaseImport = (): void => {}
      moduleGate = new Promise((resolve) => {
        releaseImport = resolve
      })
      const optingOut = client.setOptIn(
        consent === 'pending banner' ? 'first_launch_banner' : 'settings',
        false
      )
      expect(settings.telemetry?.optedIn).toBe(false)
      expect(client.track('app_opened', {})).toBe(false)
      const backgroundStart = client.startTelemetryTransport()
      releaseImport()
      await Promise.all([optingOut, backgroundStart])
      expect(createClient).toHaveBeenCalledTimes(1)
      expect(sdk.capture.mock.calls.map(([capture]) => capture.event)).toEqual([
        'telemetry_opted_out'
      ])
      expect(sdk.optOut).toHaveBeenCalledTimes(1)
    }
  )

  it('shares an in-flight startup import with explicit opt-out without replaying ordinary events', async () => {
    let releaseImport = (): void => {}
    moduleGate = new Promise((resolve) => {
      releaseImport = resolve
    })
    client.trackAppOpenedOnce()
    const starting = client.startTelemetryTransport()
    const optingOut = client.setOptIn('settings', false)
    releaseImport()
    await Promise.all([starting, optingOut])
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(sdk.capture.mock.calls.map(([capture]) => capture.event)).toEqual([
      'telemetry_opted_out'
    ])
  })

  it.each(['DO_NOT_TRACK', 'ORCA_TELEMETRY_DISABLED', 'CI', 'unofficial', 'already disabled'])(
    'does not import an explicit opt-out while blocked by %s',
    async (block) => {
      if (block === 'unofficial') {
        vi.stubGlobal('ORCA_BUILD_IDENTITY', null)
        vi.resetModules()
        client = await import('./client')
        client.initTelemetry(store)
      } else if (block === 'already disabled') {
        settings.telemetry!.optedIn = false
      } else {
        vi.stubEnv(block, '1')
      }
      await client.setOptIn('settings', false)
      expect(moduleLoads).toBe(0)
      expect(createClient).not.toHaveBeenCalled()
      expect(sdk.capture).not.toHaveBeenCalled()
    }
  )

  it.each(['DO_NOT_TRACK', 'ORCA_TELEMETRY_DISABLED', 'CI'])(
    'rechecks %s before constructing for an explicit opt-out',
    async (block) => {
      let releaseImport = (): void => {}
      moduleGate = new Promise((resolve) => {
        releaseImport = resolve
      })
      const optingOut = client.setOptIn('settings', false)
      vi.stubEnv(block, '1')
      releaseImport()
      await optingOut
      expect(createClient).not.toHaveBeenCalled()
      expect(sdk.capture).not.toHaveBeenCalled()
    }
  )

  it.each(['DO_NOT_TRACK', 'ORCA_TELEMETRY_DISABLED', 'CI'])(
    'rechecks %s before capturing an explicit opt-out on a newly loaded SDK',
    async (block) => {
      createClient.mockImplementationOnce(() => {
        vi.stubEnv(block, '1')
        return sdk
      })
      await client.setOptIn('settings', false)
      expect(createClient).toHaveBeenCalledTimes(1)
      expect(sdk.capture).not.toHaveBeenCalled()
      expect(sdk.optOut).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['pending banner', 'enabled'] as const)(
    'finishes an admitted %s opt-out inside the shared quit budget',
    async (consent) => {
      vi.useFakeTimers()
      settings.telemetry!.optedIn = consent === 'pending banner' ? null : true
      client.trackAppOpenedOnce()
      let releaseImport = (): void => {}
      moduleGate = new Promise((resolve) => {
        releaseImport = resolve
      })
      const optingOut = client.setOptIn(
        consent === 'pending banner' ? 'first_launch_banner' : 'settings',
        false
      )
      const closing = client.shutdownTelemetry()
      expect(settings.telemetry?.optedIn).toBe(false)
      expect(client.track('app_opened', {})).toBe(false)
      await vi.advanceTimersByTimeAsync(500)
      releaseImport()
      await Promise.all([optingOut, closing])
      expect(createClient).toHaveBeenCalledTimes(1)
      expect(sdk.capture.mock.calls.map(([capture]) => capture.event)).toEqual([
        'telemetry_opted_out'
      ])
      expect(sdk.optOut).toHaveBeenCalledTimes(1)
      expect(sdk.shutdown).toHaveBeenCalledWith(1_500)
    }
  )

  it('does not construct for an explicit opt-out after its shared quit budget expires', async () => {
    vi.useFakeTimers()
    let releaseImport = (): void => {}
    moduleGate = new Promise((resolve) => {
      releaseImport = resolve
    })
    const optingOut = client.setOptIn('settings', false)
    const closing = client.shutdownTelemetry()
    await vi.advanceTimersByTimeAsync(2_001)
    await closing
    releaseImport()
    await optingOut
    expect(createClient).not.toHaveBeenCalled()
    expect(sdk.capture).not.toHaveBeenCalled()
    expect(client.track('app_opened', {})).toBe(false)
  })

  it('does not retain opt-out loading admission after failed construction', async () => {
    createClient.mockImplementationOnce(() => {
      throw new Error('transport unavailable')
    })
    await client.setOptIn('settings', false)
    await client.startTelemetryTransport()
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(sdk.capture).not.toHaveBeenCalled()
  })

  it.each(['settings', 'banner'] as const)(
    'retains %s consent events for retry when deferred initialization fails',
    async (surface) => {
      settings.telemetry!.optedIn = surface === 'settings' ? false : null
      client.initTelemetry(store)
      const failure = new Error('transport unavailable')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      createClient.mockImplementationOnce(() => {
        throw failure
      })

      await expect(
        surface === 'settings'
          ? client.setOptIn('settings', true)
          : client.persistBannerAcknowledgeWithoutEmitting()
      ).resolves.toBeUndefined()
      expect(settings.telemetry!.optedIn).toBe(true)
      expect(warn).toHaveBeenCalledWith('[telemetry] transport initialization failed:', failure)
      expect(sdk.capture).not.toHaveBeenCalled()

      await client.startTelemetryTransport()
      client.trackAppOpenedOnce()
      expect(createClient).toHaveBeenCalledTimes(2)
      expect(sdk.capture.mock.calls.map(([capture]) => capture.event)).toEqual(
        surface === 'settings' ? ['app_opened', 'telemetry_opted_in'] : ['app_opened']
      )
    }
  )

  it('retains bounded startup captures across a failed first initialization', async () => {
    client.track('app_opened', {})
    createClient.mockImplementationOnce(() => {
      throw new Error('transport unavailable')
    })
    await expect(client.startTelemetryTransport()).rejects.toThrow('transport unavailable')
    await client.startTelemetryTransport()
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(sdk.capture).toHaveBeenCalledTimes(1)
  })

  it('retains startup captures up to the existing session ceiling as event limits refill', async () => {
    const now = vi.spyOn(Date, 'now')
    for (let index = 0; index < 1_001; index += 1) {
      now.mockReturnValue(index * 60_000)
      expect(client.track('app_opened', {})).toBe(index < 1_000)
    }
    await client.startTelemetryTransport()
    expect(sdk.capture).toHaveBeenCalledTimes(1_000)
  })

  it('bounds the deferred queue at the existing SDK queue capacity', async () => {
    const transport = new DeferredTelemetryTransport(
      () => ({ writeKey: 'test-key', consent: { effective: 'enabled' } }),
      () => {}
    )
    for (let index = 0; index <= MAX_QUEUED_CAPTURES; index += 1) {
      expect(transport.capture({ distinctId: 'startup-test', event: `event_${index}` })).toBe(
        index < MAX_QUEUED_CAPTURES
      )
    }
    expect(transport.accepting).toBe(false)
    await transport.start()
    expect(sdk.capture).toHaveBeenCalledTimes(MAX_QUEUED_CAPTURES)
    expect(sdk.capture.mock.calls[0]?.[0].event).toBe('event_0')
    expect(sdk.capture.mock.calls[MAX_QUEUED_CAPTURES - 1]?.[0].event).toBe(
      `event_${MAX_QUEUED_CAPTURES - 1}`
    )
    expect(transport.accepting).toBe(true)
    await transport.shutdown()
  })
})
