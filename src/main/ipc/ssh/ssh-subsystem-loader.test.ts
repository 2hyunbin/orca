import { afterEach, describe, expect, it, vi } from 'vitest'
import { quitTeardownStartGate } from '../../quit-teardown-start-gate'
import { createSshSubsystemLoader } from './ssh-subsystem-loader'

afterEach(() => quitTeardownStartGate.resetForTests())

describe('SSH first-use loading', () => {
  it('shares one load and initialization across simultaneous callers', async () => {
    const module = Promise.withResolvers<string>()
    const load = vi.fn(() => module.promise)
    const initialized: string[] = []
    const subsystem = createSshSubsystemLoader(load, (value) => {
      initialized.push(value)
      return { module: value }
    })
    expect(load).not.toHaveBeenCalled()
    const first = subsystem.load()
    const second = subsystem.load()
    expect(first).toBe(second)
    expect(subsystem.loaded).toBeUndefined()
    module.resolve('ssh')
    await expect(first).resolves.toEqual({ module: 'ssh' })
    expect(initialized).toEqual(['ssh'])
    expect(await subsystem.load()).toBe(subsystem.loaded)
    expect(load).toHaveBeenCalledOnce()
  })

  it('retries a failed load without publishing partially initialized handlers', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValue('ssh')
    const initialized: string[] = []
    const subsystem = createSshSubsystemLoader(load, (value) => {
      initialized.push(value)
      return value
    })
    const first = subsystem.load()
    const concurrent = subsystem.load()
    await expect(first).rejects.toThrow('chunk unavailable')
    await expect(concurrent).rejects.toThrow('chunk unavailable')
    expect(subsystem.loaded).toBeUndefined()
    expect(initialized).toEqual([])
    await expect(subsystem.load()).resolves.toBe('ssh')
    expect(initialized).toEqual(['ssh'])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('retries initialization failure using a fresh attempt', async () => {
    let attempts = 0
    const subsystem = createSshSubsystemLoader(
      async () => 'ssh',
      (module) => {
        if (++attempts === 1) {
          throw new Error('setup failed')
        }
        return module
      }
    )
    await expect(subsystem.load()).rejects.toThrow('setup failed')
    expect(subsystem.loaded).toBeUndefined()
    await expect(subsystem.load()).resolves.toBe('ssh')
  })

  it('does not load during committed quit', async () => {
    const load = vi.fn(async () => 'ssh')
    const subsystem = createSshSubsystemLoader(load, (module) => module)
    quitTeardownStartGate.tryStart({ preventDefault() {} })
    await expect(subsystem.load()).rejects.toThrow('app shutdown')
    expect(load).not.toHaveBeenCalled()
  })

  it('does not initialize transports when quit wins an outstanding load', async () => {
    const module = Promise.withResolvers<string>()
    const initialize = vi.fn((value: string) => value)
    const subsystem = createSshSubsystemLoader(() => module.promise, initialize)
    const first = subsystem.load()
    const concurrent = subsystem.load()
    await Promise.resolve()
    quitTeardownStartGate.tryStart({ preventDefault() {} })
    module.resolve('ssh')
    await expect(first).rejects.toThrow('app shutdown')
    await expect(concurrent).rejects.toThrow('app shutdown')
    expect(initialize).not.toHaveBeenCalled()
    expect(subsystem.loaded).toBeUndefined()
    await expect(subsystem.load()).rejects.toThrow('app shutdown')
  })
})
