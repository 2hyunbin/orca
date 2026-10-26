import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import type { WslHostStatus } from '../../../../shared/wsl-host-types'
import { isWslHostOffForForge } from './wsl-host-off-forge'

function environment(id: string, wsl: boolean): AppState['runtimeEnvironments'][number] {
  return {
    id,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'ws',
    endpoints: [],
    ...(wsl
      ? { orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 } }
      : {})
  }
}

function status(state: WslHostStatus['state']): WslHostStatus {
  return { environmentId: 'wsl:ubuntu', distro: 'Ubuntu', state, detail: null }
}

describe('isWslHostOffForForge', () => {
  const runtimeEnvironments = [environment('wsl:ubuntu', true), environment('box', false)]

  it('skips a WSL host that is not ready, including one with no status yet', () => {
    expect(isWslHostOffForForge({ runtimeEnvironments, wslHostStatuses: {} }, 'wsl:ubuntu')).toBe(
      true
    )
    expect(
      isWslHostOffForForge(
        { runtimeEnvironments, wslHostStatuses: { 'wsl:ubuntu': status('distro-stopped') } },
        'wsl:ubuntu'
      )
    ).toBe(true)
  })

  it('lets a ready WSL host and any other paired host refresh as before', () => {
    expect(
      isWslHostOffForForge(
        { runtimeEnvironments, wslHostStatuses: { 'wsl:ubuntu': status('ready') } },
        'wsl:ubuntu'
      )
    ).toBe(false)
    expect(isWslHostOffForForge({ runtimeEnvironments, wslHostStatuses: {} }, 'box')).toBe(false)
  })
})
