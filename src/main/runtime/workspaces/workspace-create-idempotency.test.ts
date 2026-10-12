import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'

describe('worktree mutation promise identity', () => {
  it('retains the original promise for a reused key even when callers violate its result-type precondition', async () => {
    const runtime = new OrcaRuntimeService(null)
    const created = Promise.resolve(42)
    const later = vi.fn(() => Promise.resolve('different result'))
    const first = runtime.dedupeWorktreeCreate('repo', 'agent.launch:mutation', () => created)
    const reused = runtime.dedupeWorktreeCreate('repo', 'agent.launch:mutation', later)
    expect(first).toBe(created)
    expect(reused).toBe(first)
    expect(later).not.toHaveBeenCalled()
    await expect(reused).resolves.toBe(42)
  })
})
