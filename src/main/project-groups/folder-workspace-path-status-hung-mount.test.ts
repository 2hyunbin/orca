import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type DirectoryStats = { isDirectory(): boolean }

const statMock = vi.hoisted(() => vi.fn<(path: string) => Promise<DirectoryStats>>())

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statMock
}))

import {
  assertFolderWorkspacePathUsable,
  folderWorkspacePathRefusal,
  getFolderWorkspacePathStatus,
  getFolderWorkspacePathStatusForPath
} from './folder-workspace-path-status'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import {
  _resetLocalFolderStatStateForTest,
  LOCAL_FOLDER_STAT_TIMEOUT_MS
} from '../local-folder-stat-deadline'

const FOLDER = '/Volumes/nas/platform'

function folderStatus() {
  return getFolderWorkspacePathStatusForPath({
    folderPath: FOLDER,
    projectGroupId: null,
    projectGroups: [],
    repos: []
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  statMock.mockReset()
  _resetLocalFolderStatStateForTest()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('folder workspace path status on a mount that stopped answering', () => {
  it('settles as unavailable at the time limit instead of never', async () => {
    statMock.mockReturnValue(new Promise<DirectoryStats>(() => {}))
    const status = folderStatus()

    await vi.advanceTimersByTimeAsync(LOCAL_FOLDER_STAT_TIMEOUT_MS)
    const settled = await Promise.race([status, Promise.resolve('pending' as const)])
    expect(settled).toEqual({ path: FOLDER, exists: false, reason: 'unavailable' })
    expect(folderWorkspacePathRefusal(await status)).toBe(
      `folder_workspace_path_unavailable:${FOLDER}`
    )
  })

  it('still reports a slow folder that answers inside the limit as present', async () => {
    statMock.mockReturnValue(
      new Promise((resolve) =>
        setTimeout(() => resolve({ isDirectory: () => true }), LOCAL_FOLDER_STAT_TIMEOUT_MS - 100)
      )
    )
    const status = folderStatus()
    await vi.advanceTimersByTimeAsync(LOCAL_FOLDER_STAT_TIMEOUT_MS - 100)
    await expect(status).resolves.toEqual({ path: FOLDER, exists: true })
  })
  it('lets a new terminal in that folder workspace fail instead of waiting forever', async () => {
    statMock.mockReturnValue(new Promise<DirectoryStats>(() => {}))
    const workspace: FolderWorkspace = {
      id: 'fw-1',
      projectGroupId: 'group-1',
      name: 'platform',
      folderPath: FOLDER,
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1
    }
    // The same chain a local terminal start awaits before it spawns.
    const admission = getFolderWorkspacePathStatus(
      { getRepos: () => [], getFolderWorkspaces: () => [workspace] },
      { scope: 'folder-workspace', folderWorkspaceId: 'fw-1' }
    ).then(assertFolderWorkspacePathUsable)
    admission.catch(() => {})

    await vi.advanceTimersByTimeAsync(LOCAL_FOLDER_STAT_TIMEOUT_MS)
    await expect(admission).rejects.toThrow(`folder_workspace_path_unavailable:${FOLDER}`)
  })
})
