import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const state: Record<string, unknown> = { openFiles: [] }
  return {
    state,
    runtimePathsExist: vi.fn(),
    scheduleReload: vi.fn(),
    forgetCombinedBodies: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => harness.state } }))
vi.mock('@/runtime/runtime-path-existence-batch', () => ({
  runtimePathsExist: harness.runtimePathsExist
}))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('./editor-external-watch-disk-verification', () => ({
  scheduleDebouncedEditorExternalReload: harness.scheduleReload
}))
vi.mock('@/components/editor/combined-diff/remember-view/combined-diff-view-cache', () => ({
  forgetCombinedDiffViewBodiesForWorktree: harness.forgetCombinedBodies
}))

import { reconcileEditorTabsAfterOverflow } from './editor-external-watch-overflow'

const setExternalMutation = vi.fn()
const setPendingDiskBaselineVerification = vi.fn()

function tab(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    worktreeId: 'wt-1',
    filePath: `/repo/${id}`,
    relativePath: id,
    mode: 'edit',
    isDirty: false,
    ...extra
  }
}

function setTabs(...openFiles: Record<string, unknown>[]): void {
  harness.state = { openFiles, setExternalMutation, setPendingDiskBaselineVerification }
}

const target = { worktreeId: 'wt-1', worktreePath: '/repo' }
const notification = (relativePath: string, runtimeEnvironmentId: string | null = null) => ({
  worktreeId: 'wt-1',
  worktreePath: '/repo',
  relativePath,
  runtimeEnvironmentId
})

describe('reconcileEditorTabsAfterOverflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reloads clean tabs that still exist and clears stale tombstones', async () => {
    setTabs(
      tab('a.md', { externalMutation: 'deleted' }),
      tab('staged.ts', { mode: 'diff', diffSource: 'staged' })
    )
    harness.runtimePathsExist.mockResolvedValue([{ exists: true }])
    reconcileEditorTabsAfterOverflow(target)
    await vi.waitFor(() => expect(harness.scheduleReload).toHaveBeenCalledTimes(2))

    expect(harness.scheduleReload).toHaveBeenCalledWith(notification('staged.ts'))
    expect(harness.scheduleReload).toHaveBeenCalledWith(notification('a.md'))
    expect(setExternalMutation).toHaveBeenCalledWith('a.md', null)
    expect(harness.forgetCombinedBodies).toHaveBeenCalledWith('wt-1')
  })

  it('marks a tab deleted, keeping its content, when its file is gone on the owning host', async () => {
    setTabs(tab('gone.ts'), tab('moved.ts', { externalMutation: 'renamed' }), tab('here.ts'))
    harness.runtimePathsExist.mockResolvedValue([
      { exists: false },
      { exists: false },
      { exists: true }
    ])
    reconcileEditorTabsAfterOverflow(target)
    await vi.waitFor(() => expect(harness.scheduleReload).toHaveBeenCalledTimes(1))

    expect(harness.scheduleReload).toHaveBeenCalledWith(notification('here.ts'))
    expect(setExternalMutation).toHaveBeenCalledWith('gone.ts', 'deleted')
    // Why: a rename mark is kept as is rather than downgraded or cleared.
    expect(setExternalMutation).not.toHaveBeenCalledWith('moved.ts', expect.anything())
  })

  it.each([
    ['the probe fails', () => harness.runtimePathsExist.mockRejectedValue(new Error('offline'))],
    [
      'the host answers with an error row',
      () => harness.runtimePathsExist.mockResolvedValue([{ error: 'EACCES' }])
    ]
  ])('reloads as before when %s', async (_label, arrange) => {
    arrange()
    setTabs(tab('a.ts'))
    reconcileEditorTabsAfterOverflow(target)
    await vi.waitFor(() =>
      expect(harness.scheduleReload).toHaveBeenCalledWith(notification('a.ts'))
    )
    expect(setExternalMutation).not.toHaveBeenCalledWith('a.ts', 'deleted')
  })

  it('hands dirty tabs to the disk check instead of reloading them', () => {
    setTabs(tab('dirty.ts', { isDirty: true, lastKnownDiskSignature: 'sig' }))
    reconcileEditorTabsAfterOverflow(target)

    expect(setPendingDiskBaselineVerification).toHaveBeenCalledWith('dirty.ts', true)
    expect(harness.runtimePathsExist).not.toHaveBeenCalled()
    expect(harness.scheduleReload).not.toHaveBeenCalled()
  })

  it('only touches tabs of the matching runtime owner', async () => {
    setTabs(tab('local.md'), tab('runtime.md', { runtimeEnvironmentId: 'env-1' }))
    harness.runtimePathsExist.mockResolvedValue([{ exists: true }])
    reconcileEditorTabsAfterOverflow({ ...target, runtimeEnvironmentId: 'env-1' })
    await vi.waitFor(() => expect(harness.scheduleReload).toHaveBeenCalledTimes(1))

    expect(harness.scheduleReload).toHaveBeenCalledWith(notification('runtime.md', 'env-1'))
    expect(harness.runtimePathsExist).toHaveBeenCalledWith(expect.anything(), ['/repo/runtime.md'])
  })
})
