import { describe, expect, it, vi } from 'vitest'
import type * as RuntimeEnvironmentsModule from '../../../shared/runtime-environments'

const mocks = vi.hoisted(() => ({
  reclaim: vi.fn(),
  clearLaunchSessionNote: vi.fn(),
  forgetLaunchSessionVerdict: vi.fn()
}))

vi.mock('../../managed-server/lifecycle/orcad-managed-stale-lock-reclaim', () => ({
  runManagedOrcadStaleLockReclaim: mocks.reclaim
}))
vi.mock('../../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'env-1' })
}))
vi.mock('../../../shared/runtime-environments', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeEnvironmentsModule>()),
  getOrcadSshDeployment: () => ({ sshTargetId: 'ssh-1' })
}))
vi.mock('./runtime-environment-managed-tunnel', () => ({
  clearLaunchSessionNote: mocks.clearLaunchSessionNote
}))
vi.mock('../ssh/ssh-host-launch-session-note', () => ({
  forgetLaunchSessionVerdict: mocks.forgetLaunchSessionVerdict
}))

const { reclaimManagedOrcadStaleLock } = await import('./managed-orcad-actions')

describe('reclaimManagedOrcadStaleLock', () => {
  // The lock is gone either way, so the note that offered the recovery must not outlive it.
  it('reconnects and clears the host notes even when the restart after the reclaim failed', async () => {
    mocks.reclaim.mockResolvedValue({
      status: 'reclaimed',
      environmentId: 'env-1',
      message: 'cleared',
      lockPath: '/home/dev/.orca/orcad.lock',
      notRestarted: 'The lock was cleared, but this host’s Orca server did not start: boom'
    })
    const invalidateTransport = vi.fn()
    const clearHostServerNotes = vi.fn()
    const result = await reclaimManagedOrcadStaleLock(
      {
        getUserDataPath: () => '/u',
        getActiveEnvironmentId: () => null,
        invalidateTransport,
        clearHostServerNotes,
        clearHostServerStatus: vi.fn(),
        store: Object.create(null)
      },
      'env-1',
      { yes: true, expectNonce: 'n-1' }
    )
    expect(result).toMatchObject({ status: 'reclaimed', notRestarted: expect.any(String) })
    expect(invalidateTransport).toHaveBeenCalledWith('env-1')
    expect(clearHostServerNotes).toHaveBeenCalledWith('ssh-1', 'env-1')
    expect(mocks.clearLaunchSessionNote).toHaveBeenCalledWith('ssh-1', 'env-1')
  })
})
