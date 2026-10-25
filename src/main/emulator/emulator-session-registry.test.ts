import { describe, expect, it } from 'vitest'
import { EmulatorSessionRegistry } from './emulator-session-registry'
import type { EmulatorDevice } from './backends/emulator-backend'

describe('EmulatorSessionRegistry backend tagging', () => {
  it('round-trips backend kind and stream codec', () => {
    const registry = new EmulatorSessionRegistry()
    registry.registerActive(
      'wt1',
      { deviceUdid: 'emulator-5554', wsUrl: '', streamUrl: '', streamCodec: 'h264' },
      { managed: true, backend: 'android' }
    )
    const session = registry.getSession('emulator-5554')
    expect(session?.backend).toBe('android')
    expect(session?.streamCodec).toBe('h264')
  })

  it('defaults backend to ios and codec to mjpeg when unspecified', () => {
    const registry = new EmulatorSessionRegistry()
    registry.registerActive('wt1', { deviceUdid: 'UDID', wsUrl: '', streamUrl: '' })
    const session = registry.getSession('UDID')
    expect(session?.backend).toBe('ios')
    expect(session?.streamCodec).toBe('mjpeg')
  })

  it('carries streamCodec back through getActiveForWorktree', () => {
    const registry = new EmulatorSessionRegistry()
    registry.registerActive(
      'wt1',
      { deviceUdid: 'd', wsUrl: '', streamUrl: '', streamCodec: 'h264' },
      { backend: 'android' }
    )
    const info = registry.getActiveForWorktree('wt1')
    expect(info?.streamCodec).toBe('h264')
  })
})

describe('EmulatorSessionRegistry managed-session liveness', () => {
  function registryWith(...serials: string[]): EmulatorSessionRegistry {
    const registry = new EmulatorSessionRegistry()
    serials.forEach((serial, index) =>
      registry.registerActive(
        `wt${index}`,
        { deviceUdid: serial, wsUrl: '', streamUrl: '' },
        { managed: true, backend: 'android' }
      )
    )
    return registry
  }
  const listing = (listDevices: () => Promise<EmulatorDevice[]>) => () => ({ listDevices })
  const device = (id: string, state: EmulatorDevice['state']): EmulatorDevice => ({
    backend: 'android',
    id,
    name: id,
    state,
    isAvailable: true
  })

  it('drops a managed device that stopped outside Orca and keeps the running one', async () => {
    const registry = registryWith('emulator-5554', 'emulator-5556')
    const live = await registry.pruneGoneManagedSessions(
      listing(async () => [device('emulator-5554', 'booted'), device('emulator-5556', 'shutdown')])
    )
    expect(live).toBe(true)
    expect(registry.getActiveForWorktree('wt0')?.deviceUdid).toBe('emulator-5554')
    expect(registry.getSession('emulator-5556')).toBeUndefined()
    expect(registry.getActiveForWorktree('wt1')).toBeNull()
  })

  it('reads no managed devices once every one is gone', async () => {
    const registry = registryWith('emulator-5554')
    expect(await registry.pruneGoneManagedSessions(listing(async () => []))).toBe(false)
    expect(registry.listSessions()).toEqual([])
  })

  it('keeps the record when the device listing fails', async () => {
    const registry = registryWith('emulator-5554')
    const live = await registry.pruneGoneManagedSessions(
      listing(async () => {
        throw new Error('adb hung up')
      })
    )
    expect(live).toBe(true)
    expect(registry.getSession('emulator-5554')).toBeDefined()
  })
})
