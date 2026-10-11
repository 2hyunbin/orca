import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import './orca-runtime-test-lifecycle.spec'
import { OrcaRuntimeService, listWorktrees } from './orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from './orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  makeWorktreeInfo,
  makeWorktreeMeta,
  store
} from './orca-runtime-test-fixtures.spec'

describe('runtime sort-order saves', () => {
  it('publishes the changed order without rescanning Git, while structural changes still rescan', async () => {
    const firstPath = join(TEST_REPO_PATH, 'first')
    const secondPath = join(TEST_REPO_PATH, 'second')
    const firstId = `${TEST_REPO_ID}::${firstPath}`
    const secondId = `${TEST_REPO_ID}::${secondPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [firstId]: makeWorktreeMeta({ sortOrder: 200 }),
      [secondId]: makeWorktreeMeta({ sortOrder: 100 })
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (id: string) => metaById[id],
      setWorktreeMeta: (id: string, meta: Partial<WorktreeMeta>) => {
        metaById[id] = { ...metaById[id], ...meta }
        return metaById[id]
      }
    })
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockResolvedValue([
      makeWorktreeInfo(firstPath),
      makeWorktreeInfo(secondPath)
    ])
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    const events: { type: string; repoId?: string }[] = []
    const unsubscribe = runtime.onClientEvent((event) => events.push(event))

    expect(runtime.persistManagedWorktreeSortOrder([secondId, firstId])).toEqual({ updated: 2 })
    unsubscribe()
    const listed = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(events).toEqual([{ type: 'worktreesChanged', repoId: TEST_REPO_ID }])
    expect(listWorktrees).toHaveBeenCalledTimes(1)
    const sortOrderOf = (id: string) =>
      listed.worktrees.find((worktree) => worktree.id === id)?.sortOrder ?? Number.NaN
    expect(sortOrderOf(secondId)).toBeGreaterThan(sortOrderOf(firstId))

    runtime.publishWorktreeRemovalChange(TEST_REPO_ID)
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    expect(listWorktrees).toHaveBeenCalledTimes(2)
  })
})
