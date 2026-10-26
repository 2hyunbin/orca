import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  saved: false,
  loaded: 0,
  ensureSsh: vi.fn(async () => {}),
  restore: vi.fn(async () => {})
}))
vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({
    getTarget: () => ({ portForwards: mocks.saved ? [{}] : [] })
  }),
  ensureSshConnectionManager: mocks.ensureSsh
}))
vi.mock('./ssh-managed-port-forward-restore', () => {
  mocks.loaded++
  return { restoreManagedHostPortForwards: mocks.restore }
})
import { restoreSavedSshPortForwards } from './ssh-port-forward-startup'

beforeEach(() => vi.clearAllMocks())

describe('startup port-forward restoration', () => {
  it('does not load SSH or the restorer for a target without saved forwards', async () => {
    mocks.saved = false
    await restoreSavedSshPortForwards('ssh-1', { tunnelUp: true })
    expect(mocks.ensureSsh).not.toHaveBeenCalled()
    expect(mocks.loaded).toBe(0)
  })

  it('waits for SSH initialization before restoring saved forwards', async () => {
    mocks.saved = true
    const loading = Promise.withResolvers<void>()
    mocks.ensureSsh.mockReturnValueOnce(loading.promise)
    const pending = restoreSavedSshPortForwards('ssh-1', { tunnelUp: true })
    expect(mocks.loaded).toBe(0)
    loading.resolve()
    await pending
    expect(mocks.loaded).toBe(1)
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith('ssh-1', { tunnelUp: true })
  })

  it('does not restore if SSH initialization is rejected by shutdown', async () => {
    mocks.saved = true
    mocks.ensureSsh.mockRejectedValueOnce(new Error('app shutdown'))
    await restoreSavedSshPortForwards('ssh-1')
    expect(mocks.restore).not.toHaveBeenCalled()
  })
})
