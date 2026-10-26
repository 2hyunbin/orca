import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { admitSourceControlRecovery } from './source-control-recovery-admission'
import { deferred } from './source-control-hook-test-harness'
import {
  isGitWorktreeMutationInFlight,
  trackGitWorktreeMutation
} from '../../../../main/git/git-worktree-mutation-state'
import { OBJECT_MAINTENANCE_ARGS } from '../../../../shared/repo-object-maintenance-policy'

const mocks = vi.hoisted(() => ({ probe: vi.fn(), toastError: vi.fn() }))
vi.mock('@/runtime/runtime-git-status-client', () => ({
  getRuntimeGitMutationInFlight: mocks.probe
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

const context: RuntimeGitContext = {
  target: { kind: 'environment', environmentId: 'host-a' },
  worktreeId: 'repo::/repo',
  worktreePath: '/repo'
}

describe('source-control recovery admission', () => {
  beforeEach(() => {
    mocks.probe.mockReset().mockResolvedValue({ inFlight: false })
    mocks.toastError.mockReset()
  })

  it('admits when the host reports no Orca Git work in flight', async () => {
    await expect(admitSourceControlRecovery(context)).resolves.toBe(true)
    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith(context)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('refuses with a message while the host runs Orca Git work here', async () => {
    mocks.probe.mockResolvedValue({ inFlight: true })
    await expect(admitSourceControlRecovery(context)).resolves.toBe(false)
    expect(mocks.toastError).toHaveBeenCalledWith('Wait for the running Git operation to finish.')
  })

  it('keeps recovery available during object maintenance and still blocks a worktree writer', async () => {
    mocks.probe.mockImplementation(async () => ({
      inFlight: await isGitWorktreeMutationInFlight(context.worktreePath, {})
    }))
    const releaseMaintenance = trackGitWorktreeMutation(OBJECT_MAINTENANCE_ARGS, {
      cwd: context.worktreePath
    })
    let releaseWriter = (): void => {}
    try {
      await expect(admitSourceControlRecovery(context)).resolves.toBe(true)
      expect(mocks.toastError).not.toHaveBeenCalled()
      releaseWriter = trackGitWorktreeMutation(['rebase', '--continue'], {
        cwd: context.worktreePath
      })
      await expect(admitSourceControlRecovery(context)).resolves.toBe(false)
      expect(mocks.toastError).toHaveBeenCalledWith('Wait for the running Git operation to finish.')
    } finally {
      releaseWriter()
      releaseMaintenance()
    }
  })

  it('keeps recovery available on hosts that predate the check', async () => {
    mocks.probe.mockRejectedValue(new Error('method_not_found'))
    await expect(admitSourceControlRecovery(context)).resolves.toBe(true)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each([false, true, 'unsupported'] as const)(
    'ignores a cancelled check returning %s',
    async (result) => {
      const check = deferred<{ inFlight: boolean }>()
      mocks.probe.mockReturnValueOnce(check.promise)
      const controller = new AbortController()
      const admission = admitSourceControlRecovery(context, controller.signal)
      controller.abort()
      if (result === 'unsupported') {
        check.reject(new Error('method_not_found'))
      } else {
        check.resolve({ inFlight: result })
      }
      await expect(admission).resolves.toBe(false)
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )
})
