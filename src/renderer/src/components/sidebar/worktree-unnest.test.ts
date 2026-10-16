import { createWorktreeIdentity } from '../../../../shared/worktree/identity'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { unnestWorktrees } from './worktree-unnest'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const rows = ['repo1::/a', 'repo1::/b'].map((id) => ({
  id,
  identity: createWorktreeIdentity({
    worktreeId: id,
    executionHostId: 'ssh:remote',
    instanceId: id
  })
}))

describe('unnestWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('clears the parent link on every requested worktree', async () => {
    const updateWorktreeLineage = vi.fn().mockResolvedValue(undefined)

    await unnestWorktrees(rows, updateWorktreeLineage)

    expect(updateWorktreeLineage).toHaveBeenCalledTimes(2)
    expect(updateWorktreeLineage).toHaveBeenCalledWith('repo1::/a', {
      noParent: true,
      identity: rows[0].identity
    })
    expect(updateWorktreeLineage).toHaveBeenCalledWith('repo1::/b', {
      noParent: true,
      identity: rows[1].identity
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  // Why: both callers fire-and-forget, so a rejection that escapes here is an unhandled rejection
  // and the user sees nothing at all.
  it('toasts instead of rejecting when the lineage update fails', async () => {
    const updateWorktreeLineage = vi
      .fn()
      .mockRejectedValue(new Error('Workspace identity is ambiguous across hosts'))

    await expect(unnestWorktrees(rows.slice(0, 1), updateWorktreeLineage)).resolves.toBeUndefined()

    expect(toast.error).toHaveBeenCalledWith('Failed to unnest workspace')
  })

  it('toasts once when several worktrees fail together', async () => {
    const updateWorktreeLineage = vi.fn().mockRejectedValue(new Error('unresolvable owner'))

    await unnestWorktrees(rows, updateWorktreeLineage)

    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('does nothing for an empty selection', async () => {
    const updateWorktreeLineage = vi.fn().mockResolvedValue(undefined)

    await unnestWorktrees([], updateWorktreeLineage)

    expect(updateWorktreeLineage).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})
