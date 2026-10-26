import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _enableTransportForTests,
  _setCommonPropsForTests,
  _setShuttingDownForTests,
  initTelemetry,
  hasTrackedWorkspaceDiscoveryEligibility,
  track
} from './client'
import {
  BASE_COMMON,
  cleanupTelemetryClientTest,
  setupTelemetryClientTest,
  type TelemetryClientTestState
} from './client-test-harness'

describe('workspace discovery telemetry boundaries', () => {
  let state: TelemetryClientTestState
  beforeEach(() => {
    state = setupTelemetryClientTest({
      optedIn: true,
      installId: BASE_COMMON.install_id,
      existedBeforeTelemetryRelease: false,
      workspaceDiscoveryCohort: 'control'
    })
    _setCommonPropsForTests({ ...BASE_COMMON, workspace_discovery_v1: 'control' })
  })
  afterEach(() => cleanupTelemetryClientTest(state.envStash))

  it('bounds repeated mounts and actions across windows without consuming other events or doing disk writes', () => {
    const observe = () => {
      track('workspace_discovery_eligible', {})
      for (const surface of ['suggestion', 'manage'] as const) {
        track('workspace_discovery_shown', { surface, workspace_count: 50 })
        for (const action of ['reviewed', 'import_completed', 'dismissed'] as const) {
          track('workspace_discovery_action', { surface, action, workspace_count: 50 })
        }
      }
    }
    observe()
    expect(state.mock.capture).toHaveBeenCalledTimes(9)
    expect(hasTrackedWorkspaceDiscoveryEligibility()).toBe(true)
    const reads = vi.mocked(state.store.getSettings).mock.calls.length
    for (let index = 0; index < 2000; index++) {
      observe()
    }
    expect(state.mock.capture).toHaveBeenCalledTimes(9)
    expect(state.store.getSettings).toHaveBeenCalledTimes(reads)
    expect(state.store.updateSettings).not.toHaveBeenCalled()
    expect(track('app_opened', {})).toBe(true)

    initTelemetry(state.store)
    expect(hasTrackedWorkspaceDiscoveryEligibility()).toBe(false)
    expect(track('workspace_discovery_eligible', {})).toBe(true)
  })

  it.each([
    'opt_out',
    'pending_banner',
    'do_not_track',
    'orca_disabled',
    'ci',
    'sdk_opted_out',
    'shutting_down',
    'unofficial_build',
    'unenrolled'
  ])('does not transmit or consume an observation while blocked by %s', (block) => {
    const telemetry = state.settings.telemetry
    if (!telemetry) {
      throw new Error('Test telemetry missing')
    }
    if (block === 'opt_out') {
      telemetry.optedIn = false
    } else if (block === 'pending_banner') {
      telemetry.optedIn = null
    } else if (block === 'do_not_track') {
      process.env.DO_NOT_TRACK = '1'
    } else if (block === 'orca_disabled') {
      process.env.ORCA_TELEMETRY_DISABLED = '1'
    } else if (block === 'ci') {
      process.env.CI = '1'
    } else if (block === 'sdk_opted_out') {
      Object.assign(state.mock, { optedOut: true })
    } else if (block === 'shutting_down') {
      _setShuttingDownForTests(true)
    } else if (block === 'unofficial_build') {
      _enableTransportForTests(false)
    } else {
      _setCommonPropsForTests(BASE_COMMON)
    }
    expect(track('workspace_discovery_eligible', {})).toBe(false)
    expect(track('workspace_discovery_shown', { surface: 'manage', workspace_count: 1 })).toBe(
      false
    )
    expect(
      track('workspace_discovery_action', {
        surface: 'manage',
        action: 'import_completed',
        workspace_count: 1
      })
    ).toBe(false)
    expect(state.mock.capture).not.toHaveBeenCalled()
    expect(state.store.updateSettings).not.toHaveBeenCalled()

    telemetry.optedIn = true
    delete process.env.DO_NOT_TRACK
    delete process.env.ORCA_TELEMETRY_DISABLED
    delete process.env.CI
    Object.assign(state.mock, { optedOut: false })
    _setShuttingDownForTests(false)
    _enableTransportForTests(true)
    _setCommonPropsForTests({ ...BASE_COMMON, workspace_discovery_v1: 'control' })
    expect(track('workspace_discovery_eligible', {})).toBe(true)
  })

  it('rejects private data and unbounded counts before capture without reserving the valid observation', () => {
    const privatePayload = {
      surface: 'suggestion' as const,
      action: 'reviewed' as const,
      workspace_count: 1,
      path: '/private/workspace',
      name: 'private-project',
      host: 'private-host'
    }
    expect(track('workspace_discovery_action', privatePayload)).toBe(false)
    expect(track('workspace_discovery_shown', { surface: 'suggestion', workspace_count: 51 })).toBe(
      false
    )
    expect(state.mock.capture).not.toHaveBeenCalled()
    expect(
      track('workspace_discovery_action', {
        surface: 'suggestion',
        action: 'reviewed',
        workspace_count: 1
      })
    ).toBe(true)
    expect(state.mock.capture.mock.calls[0]?.[0].properties).toEqual({
      ...BASE_COMMON,
      workspace_discovery_v1: 'control',
      surface: 'suggestion',
      action: 'reviewed',
      workspace_count: 1,
      $process_person_profile: false
    })
  })
})
