import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeRpc, runtimeEnvironmentSupportsCapability } = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(async (): Promise<unknown> => ({})),
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability
}))

import {
  canResumeHostAutomaticRestores,
  observeHostAutomaticRestorePause,
  resumeHostAutomaticRestores
} from './resume-host-automatic-restores'

describe('host automatic-restore resume', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('offers the action for this app, and for a paired host only when it advertises it', async () => {
    await expect(canResumeHostAutomaticRestores(null)).resolves.toBe(true)
    runtimeEnvironmentSupportsCapability.mockResolvedValueOnce(true)
    await expect(canResumeHostAutomaticRestores('env-1')).resolves.toBe(true)
    expect(runtimeEnvironmentSupportsCapability).toHaveBeenCalledWith(
      'env-1',
      'runtime.automatic-work.v1'
    )
    runtimeEnvironmentSupportsCapability.mockResolvedValueOnce(false)
    await expect(canResumeHostAutomaticRestores('env-old')).resolves.toBe(false)
    runtimeEnvironmentSupportsCapability.mockRejectedValueOnce(new Error('offline'))
    await expect(canResumeHostAutomaticRestores('env-down')).resolves.toBe(false)
  })

  it('asks the host that owns the pane', async () => {
    await resumeHostAutomaticRestores('env-1')
    await resumeHostAutomaticRestores(null)
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      1,
      { kind: 'environment', environmentId: 'env-1' },
      'runtime.automaticWork.resume'
    )
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      { kind: 'local' },
      'runtime.automaticWork.resume'
    )
  })

  it('reads only the owning host and treats unavailable or unfamiliar reports honestly', async () => {
    for (const mode of [
      { kind: 'paused', reason: 'unclean_host_death' },
      { kind: 'paused', reason: 'pressure' },
      { kind: 'paused', reason: 'operator' }
    ]) {
      callRuntimeRpc.mockResolvedValueOnce({ automaticWork: { mode } })
      await expect(observeHostAutomaticRestorePause('env-1')).resolves.toBe(mode.reason)
    }
    for (const automaticWork of [
      null,
      {},
      { mode: { kind: 'normal' } },
      { mode: { kind: 'future' } },
      { mode: { kind: 'paused', reason: 'future' } }
    ]) {
      callRuntimeRpc.mockResolvedValueOnce({ automaticWork })
      await expect(observeHostAutomaticRestorePause('env-1')).resolves.toBeNull()
    }
    callRuntimeRpc.mockRejectedValueOnce(new Error('offline'))
    await expect(observeHostAutomaticRestorePause('env-1')).resolves.toBeNull()
    for (const call of callRuntimeRpc.mock.calls) {
      expect(call).toEqual([
        { kind: 'environment', environmentId: 'env-1' },
        'runtime.automaticWork.status',
        undefined,
        { timeoutMs: 10_000 }
      ])
    }
  })
})
