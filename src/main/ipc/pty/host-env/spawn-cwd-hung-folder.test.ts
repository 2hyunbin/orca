import type * as Fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type DirectoryStats = { isDirectory(): boolean }

const { statMock, statSyncMock } = vi.hoisted(() => ({
  statMock: vi.fn<(path: string) => Promise<DirectoryStats>>(),
  statSyncMock: vi.fn<(path: string) => DirectoryStats>()
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statMock
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof Fs>()),
  statSync: statSyncMock
}))

import { localStartupCwdDirectoryExists } from './spawn-cwd'
import {
  _resetLocalFolderStatStateForTest,
  LOCAL_FOLDER_STAT_TIMEOUT_MS
} from '../../../local-folder-stat-deadline'

const HUNG_DIR = '/Volumes/nas/repo/src'
const directoryStats = { isDirectory: () => true }

function blockFor(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // Stands in for a statSync that waits on a dead mount.
  }
}

beforeEach(() => {
  statMock.mockReset()
  statSyncMock.mockReset()
  _resetLocalFolderStatStateForTest()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the worktree-fallback folder check on a mount that stopped answering', () => {
  it('never blocks the main thread on the folder', async () => {
    statSyncMock.mockImplementation(() => {
      blockFor(300)
      return directoryStats
    })
    statMock.mockResolvedValue(directoryStats)

    const startedAt = performance.now()
    const exists = localStartupCwdDirectoryExists(HUNG_DIR)
    expect(performance.now() - startedAt).toBeLessThan(100)
    expect(statSyncMock).not.toHaveBeenCalled()
    await expect(exists).resolves.toBe(true)
  })

  it('fails the start with the existing "cannot verify this folder" refusal at the time limit', async () => {
    vi.useFakeTimers()
    statMock.mockReturnValue(new Promise<DirectoryStats>(() => {}))
    const exists = Promise.resolve(localStartupCwdDirectoryExists(HUNG_DIR))
    exists.catch(() => {})

    await vi.advanceTimersByTimeAsync(LOCAL_FOLDER_STAT_TIMEOUT_MS)
    await expect(exists).rejects.toThrow(`folder_workspace_path_unavailable:${HUNG_DIR}`)
  })

  it('treats a slow folder that answers inside the limit exactly as before', async () => {
    vi.useFakeTimers()
    statMock.mockReturnValue(
      new Promise((resolve) =>
        setTimeout(() => resolve(directoryStats), LOCAL_FOLDER_STAT_TIMEOUT_MS - 100)
      )
    )
    const exists = Promise.resolve(localStartupCwdDirectoryExists(HUNG_DIR))
    await vi.advanceTimersByTimeAsync(LOCAL_FOLDER_STAT_TIMEOUT_MS - 100)
    await expect(exists).resolves.toBe(true)
  })

  it('still reads a missing folder as missing so the start can fall back', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(Promise.resolve(localStartupCwdDirectoryExists(HUNG_DIR))).resolves.toBe(false)
  })
})
