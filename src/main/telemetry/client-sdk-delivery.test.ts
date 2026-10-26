import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type * as telemetryClient from './client'
import { BASE_COMMON, makeFakeSettings, makeFakeStore } from './client-test-harness'

const batchSchema = z.object({
  api_key: z.string(),
  batch: z.array(
    z.object({
      event: z.string(),
      distinct_id: z.string(),
      timestamp: z.string(),
      properties: z.record(z.string(), z.unknown())
    })
  )
})

describe('real PostHog SDK delivery with intercepted HTTP', () => {
  let client: typeof telemetryClient
  const requests: { url: string; status: number; payload: z.infer<typeof batchSchema> }[] = []
  let failNextRequest: boolean
  const settings = makeFakeSettings({
    installId: BASE_COMMON.install_id,
    optedIn: true,
    existedBeforeTelemetryRelease: false
  })
  const store = makeFakeStore(settings)
  const deliveredEvents = (): string[] =>
    requests
      .filter(({ status }) => status === 200)
      .flatMap(({ payload }) => payload.batch.map(({ event }) => event))

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('ORCA_BUILD_IDENTITY', 'stable')
    vi.stubGlobal('ORCA_POSTHOG_WRITE_KEY', 'local-fixture-key')
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
    requests.length = 0
    failNextRequest = false
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        expect(url).toBe('https://us.i.posthog.com/batch/')
        const body = Buffer.from(await new Response(init?.body).arrayBuffer())
        const json =
          new Headers(init?.headers).get('Content-Encoding') === 'gzip'
            ? gunzipSync(body).toString()
            : body.toString()
        const payload = batchSchema.parse(JSON.parse(json))
        const status = failNextRequest ? 503 : 200
        failNextRequest = false
        requests.push({ url, status, payload })
        return new Response('{"status":1}', { status })
      })
    )
    settings.telemetry = {
      installId: BASE_COMMON.install_id,
      optedIn: true,
      existedBeforeTelemetryRelease: false
    }
    client = await import('./client')
    client.initTelemetry(store)
  })

  afterEach(async () => {
    await client.shutdownTelemetry()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it.each(['before start', 'after start'] as const)(
    'delivers accepted events on short-session shutdown %s through the real SDK',
    async (phase) => {
      client.trackAppOpenedOnce()
      expect(client.track('telemetry_opted_in', { via: 'settings' })).toBe(true)
      expect(requests).toHaveLength(0)
      if (phase === 'after start') {
        await client.startTelemetryTransport()
      }
      await client.shutdownTelemetry()
      expect(deliveredEvents()).toEqual(['app_opened', 'telemetry_opted_in'])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.payload.api_key).toBe('local-fixture-key')
      for (const event of requests[0]?.payload.batch ?? []) {
        expect(event.distinct_id).toBe(BASE_COMMON.install_id)
        expect(event.properties).toMatchObject({
          install_id: BASE_COMMON.install_id,
          $process_person_profile: false,
          $geoip_disable: true
        })
      }
      expect(client.track('app_opened', {})).toBe(false)
    }
  )

  it.each(['user', 'environment', 'contributor', 'pending banner'] as const)(
    'makes no SDK HTTP requests for %s sessions',
    async (reason) => {
      if (reason === 'user') {
        settings.telemetry!.optedIn = false
      } else if (reason === 'environment') {
        vi.stubEnv('ORCA_TELEMETRY_DISABLED', '1')
      } else if (reason === 'pending banner') {
        settings.telemetry!.optedIn = null
      } else {
        vi.stubGlobal('ORCA_BUILD_IDENTITY', null)
        vi.resetModules()
        client = await import('./client')
        client.initTelemetry(store)
      }
      expect(client.track('app_opened', {})).toBe(false)
      await client.startTelemetryTransport()
      await client.shutdownTelemetry()
      expect(requests).toHaveLength(0)
    }
  )

  it('drops queued events on opt-out, then delivers opt-in and a single app_opened', async () => {
    client.trackAppOpenedOnce()
    await client.setOptIn('settings', false)
    expect(requests).toHaveLength(0)
    expect(client.track('app_opened', {})).toBe(false)
    await client.setOptIn('settings', true)
    await client.shutdownTelemetry()
    expect(deliveredEvents()).toEqual(['telemetry_opted_out', 'app_opened', 'telemetry_opted_in'])
  })

  it.each(['pending banner', 'enabled'] as const)(
    'delivers only the explicit pre-start opt-out for %s consent',
    async (consent) => {
      settings.telemetry!.optedIn = consent === 'pending banner' ? null : true
      client.initTelemetry(store)
      client.trackAppOpenedOnce()
      const optingOut = client.setOptIn(
        consent === 'pending banner' ? 'first_launch_banner' : 'settings',
        false
      )
      expect(settings.telemetry?.optedIn).toBe(false)
      expect(client.track('app_opened', {})).toBe(false)
      await optingOut
      await client.shutdownTelemetry()
      expect(deliveredEvents()).toEqual(['telemetry_opted_out'])
      expect(requests).toHaveLength(1)
    }
  )

  it.each(['DO_NOT_TRACK', 'ORCA_TELEMETRY_DISABLED', 'CI', 'unofficial', 'already disabled'])(
    'sends no pre-start opt-out request while blocked by %s',
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
      await client.shutdownTelemetry()
      expect(requests).toHaveLength(0)
    }
  )

  it.each(['pending banner', 'enabled'] as const)(
    'delivers the admitted %s opt-out when quit races cold SDK startup',
    async (consent) => {
      settings.telemetry!.optedIn = consent === 'pending banner' ? null : true
      client.initTelemetry(store)
      client.trackAppOpenedOnce()
      const optingOut = client.setOptIn(
        consent === 'pending banner' ? 'first_launch_banner' : 'settings',
        false
      )
      const closing = client.shutdownTelemetry()
      expect(settings.telemetry?.optedIn).toBe(false)
      expect(client.track('app_opened', {})).toBe(false)
      await Promise.all([optingOut, closing])
      expect(deliveredEvents()).toEqual(['telemetry_opted_out'])
      expect(requests).toHaveLength(1)
    }
  )

  it('enqueues opt-out before SDK optOut and delivers it during shutdown', async () => {
    await client.startTelemetryTransport()
    await client.setOptIn('settings', false)
    expect(client.track('app_opened', {})).toBe(false)
    await client.shutdownTelemetry()
    expect(deliveredEvents()).toEqual(['telemetry_opted_out'])
    expect(settings.telemetry?.optedIn).toBe(false)
  })

  it('delivers banner acknowledgment without a consent-change event', async () => {
    settings.telemetry!.optedIn = null
    expect(client.track('app_opened', {})).toBe(false)
    await client.persistBannerAcknowledgeWithoutEmitting()
    await client.shutdownTelemetry()
    expect(deliveredEvents()).toEqual(['app_opened'])
  })

  it('retries a failed HTTP delivery using the real SDK queue', async () => {
    const { createPostHogClient } = await import('./posthog-transport')
    const sdk = createPostHogClient('local-fixture-key', { effective: 'enabled' })
    try {
      failNextRequest = true
      sdk.capture({
        distinctId: BASE_COMMON.install_id,
        event: 'app_opened',
        properties: { $process_person_profile: false }
      })
      await sdk.flush()
      expect(requests.map(({ status }) => status)).toEqual([503, 200])
      expect(deliveredEvents()).toEqual(['app_opened'])
    } finally {
      await sdk.shutdown(2_000)
    }
  })
})
