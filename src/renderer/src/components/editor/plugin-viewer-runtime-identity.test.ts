import { describe, expect, it } from 'vitest'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { pluginViewerRuntimeIdentity } from './plugin-viewer-runtime-identity'

function runtimeStatus(runtimeId: string): RuntimeStatus {
  return {
    runtimeId,
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 3
  }
}

describe('viewer identity from the current paired host status', () => {
  function state(catalogRuntimeId: string | null = null) {
    return {
      runtimeEnvironments: [
        {
          id: 'managed',
          name: 'Managed host',
          runtimeId: catalogRuntimeId,
          createdAt: 1,
          updatedAt: 1,
          pairingRevision: 2,
          lastUsedAt: null,
          endpoints: [],
          preferredEndpointId: 'ws'
        }
      ],
      runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>()
    }
  }

  it('uses a verified host when its newly registered catalog still has no runtime id', () => {
    const input = state()
    const status = runtimeStatus('verified-server')
    input.runtimeStatusByEnvironmentId.set('managed', {
      status,
      checkedAt: 3,
      snapshot: {
        environmentId: 'managed',
        pairingRevision: 2,
        sequence: 1,
        checkedAt: 3,
        status,
        verification: 'verified',
        transport: 'ready'
      }
    })
    expect(pluginViewerRuntimeIdentity(input, 'managed')).toBe('verified-server')
    expect(pluginViewerRuntimeIdentity(input, 'unowned')).toBeNull()
  })

  it.each(['wrong-pairing', 'wrong-environment', 'retired', 'blocked'])(
    'rejects %s status instead of borrowing the saved catalog id',
    (kind) => {
      const input = state('saved-server')
      const status = runtimeStatus('status-server')
      input.runtimeStatusByEnvironmentId.set('managed', {
        status,
        checkedAt: 3,
        snapshot: {
          environmentId: kind === 'wrong-environment' ? 'foreign' : 'managed',
          pairingRevision: kind === 'wrong-pairing' ? 1 : 2,
          sequence: 1,
          checkedAt: 3,
          status,
          verification: kind === 'blocked' ? 'blocked' : 'verified',
          transport: 'ready',
          ...(kind === 'retired' ? { retired: true } : {})
        }
      })
      expect(pluginViewerRuntimeIdentity(input, 'managed')).toBeNull()
    }
  )

  it('retains the saved identity when no live status exists, for a fresh admission handshake', () => {
    expect(pluginViewerRuntimeIdentity(state('saved-server'), 'managed')).toBe('saved-server')
    expect(pluginViewerRuntimeIdentity(state(), 'managed')).toBeNull()
  })
})
