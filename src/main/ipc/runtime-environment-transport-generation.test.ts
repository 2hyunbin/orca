import { describe, expect, it } from 'vitest'
import {
  _getRuntimeEnvironmentTransportGenerationCacheSize,
  advanceRuntimeEnvironmentTransportGeneration,
  getRuntimeEnvironmentTransportGeneration,
  onRuntimeEnvironmentTransportChanged
} from './runtime-environment-transport-generation'

describe('runtime environment transport generations', () => {
  it('retires only the selected environment and releases observer ownership', () => {
    let notices = 0
    const stop = onRuntimeEnvironmentTransportChanged('viewer-environment', () => notices++)
    advanceRuntimeEnvironmentTransportGeneration('other-environment')
    expect(notices).toBe(0)
    advanceRuntimeEnvironmentTransportGeneration('viewer-environment')
    expect(notices).toBe(1)
    stop()
    advanceRuntimeEnvironmentTransportGeneration('viewer-environment')
    expect(notices).toBe(1)
  })

  it('retires a document fence when the generation cache evicts its environment', () => {
    advanceRuntimeEnvironmentTransportGeneration('viewer-eviction')
    let notices = 0
    const stop = onRuntimeEnvironmentTransportChanged('viewer-eviction', () => notices++)
    for (let index = 0; index < 520; index++) {
      advanceRuntimeEnvironmentTransportGeneration(`viewer-churn-${index}`)
    }
    expect(notices).toBe(1)
    stop()
  })
  it('bounds retired environment generations', () => {
    for (let index = 0; index < 600; index += 1) {
      advanceRuntimeEnvironmentTransportGeneration(`retired-environment-${index}`)
    }

    expect(_getRuntimeEnvironmentTransportGenerationCacheSize()).toBeLessThanOrEqual(512)
  })

  it('does not reopen a fence after an environment key is evicted', () => {
    advanceRuntimeEnvironmentTransportGeneration('reused-environment')
    const beforeEviction = getRuntimeEnvironmentTransportGeneration('reused-environment')
    for (let index = 0; index < 1_100; index += 1) {
      advanceRuntimeEnvironmentTransportGeneration(`churn-${index}`)
    }
    advanceRuntimeEnvironmentTransportGeneration('reused-environment')

    expect(getRuntimeEnvironmentTransportGeneration('reused-environment')).toBeGreaterThan(
      beforeEviction
    )
  })
})
