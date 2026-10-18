import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getState, scheduleReload } = vi.hoisted(() => ({
  getState: vi.fn(),
  scheduleReload: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState } }))
vi.mock('./editor-external-watch-disk-verification', () => ({
  scheduleDebouncedEditorExternalReload: scheduleReload
}))

import {
  armEditorTabDiskVerification,
  reloadCleanEditorTabs
} from './editor-external-watch-activation-reverify'

const target = {
  worktreeId: 'wt',
  worktreePath: '/repo',
  connectionId: undefined,
  runtimeEnvironmentId: null
}

function tab(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    worktreeId: 'wt',
    filePath: `/repo/${id}`,
    relativePath: id,
    mode: 'edit',
    isDirty: false,
    ...extra
  }
}

const openFiles = [
  tab('dirty.ts', { isDirty: true, lastKnownDiskSignature: 'sig' }),
  tab('clean.ts'),
  tab('deleted.ts', { externalMutation: 'deleted' }),
  tab('no-baseline.ts', { isDirty: true }),
  tab('already-changed.ts', {
    isDirty: true,
    lastKnownDiskSignature: 'sig',
    externalMutation: 'changed'
  }),
  tab('other.ts', { worktreeId: 'other', isDirty: true, lastKnownDiskSignature: 'sig' }),
  tab('runtime.ts', { runtimeEnvironmentId: 'env-1' })
]

describe('narrow-watch switch-back re-check', () => {
  const setPendingDiskBaselineVerification = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    getState.mockReturnValue({ setPendingDiskBaselineVerification, openFiles })
  })

  it('hands only scan-eligible dirty tabs of the workspace to the conflict scan', () => {
    armEditorTabDiskVerification(target)

    expect(setPendingDiskBaselineVerification).toHaveBeenCalledTimes(1)
    expect(setPendingDiskBaselineVerification).toHaveBeenCalledWith('dirty.ts', true)
    expect(scheduleReload).not.toHaveBeenCalled()
  })

  it('reloads clean tabs but leaves tombstoned ones alone', () => {
    reloadCleanEditorTabs(target)

    expect(scheduleReload).toHaveBeenCalledTimes(1)
    expect(scheduleReload).toHaveBeenCalledWith({
      worktreeId: 'wt',
      worktreePath: '/repo',
      relativePath: 'clean.ts',
      runtimeEnvironmentId: null
    })
    expect(setPendingDiskBaselineVerification).not.toHaveBeenCalled()
  })
})
