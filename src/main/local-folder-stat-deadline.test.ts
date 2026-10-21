import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type DirectoryStats = { isDirectory(): boolean }

const statMock = vi.hoisted(() => vi.fn<(path: string) => Promise<DirectoryStats>>())

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statMock
}))

import {
  _resetLocalFolderStatStateForTest,
  LOCAL_FOLDER_STAT_TIMEOUT_MS,
  LocalFolderStatTimeoutError,
  statLocalFolderWithDeadline
} from './local-folder-stat-deadline'

const directoryStats = { isDirectory: () => true }

function statAnsweringAfter(ms: number): Promise<DirectoryStats> {
  return new Promise((resolve) => setTimeout(() => resolve(directoryStats), ms))
}

beforeEach(() => {
  vi.useFakeTimers()
  statMock.mockReset()
  _resetLocalFolderStatStateForTest()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('statLocalFolderWithDeadline', () => {
  it('rejects at the time limit when the mount never answers', async () => {
    statMock.mockReturnValue(new Promise<DirectoryStats>(() => {}))
    const result = statLocalFolderWithDeadline('/Volumes/nas/repo')
    const settled = vi.fn()
    result.then(settled, settled)

    await vi.advanceTimersByTimeAsync(LOCAL_FOLDER_STAT_TIMEOUT_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).rejects.toBeInstanceOf(LocalFolderStatTimeoutError)
  })

  it('resolves a slow folder that answers inside the limit', async () => {
    statMock.mockReturnValue(statAnsweringAfter(LOCAL_FOLDER_STAT_TIMEOUT_MS - 100))
    const result = statLocalFolderWithDeadline('/Volumes/nas/repo')
    await vi.advanceTimersByTimeAsync(LOCAL_FOLDER_STAT_TIMEOUT_MS - 100)
    await expect(result).resolves.toBe(directoryStats)
  })

  it('passes a real stat error through unchanged', async () => {
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    statMock.mockRejectedValue(missing)
    await expect(statLocalFolderWithDeadline('/gone')).rejects.toBe(missing)
  })

  it('joins a retry to the hung stat instead of pinning another fs thread', async () => {
    statMock.mockReturnValue(new Promise<DirectoryStats>(() => {}))
    const first = statLocalFolderWithDeadline('/Volumes/nas/repo')
    first.catch(() => {})
    await vi.advanceTimersByTimeAsync(LOCAL_FOLDER_STAT_TIMEOUT_MS)
    await expect(first).rejects.toBeInstanceOf(LocalFolderStatTimeoutError)

    const retry = statLocalFolderWithDeadline('/Volumes/nas/repo')
    retry.catch(() => {})
    expect(statMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(LOCAL_FOLDER_STAT_TIMEOUT_MS)
    await expect(retry).rejects.toBeInstanceOf(LocalFolderStatTimeoutError)
  })

  it('starts a fresh stat once the previous one settled', async () => {
    statMock.mockResolvedValue(directoryStats)
    await statLocalFolderWithDeadline('/repo')
    await statLocalFolderWithDeadline('/repo')
    expect(statMock).toHaveBeenCalledTimes(2)
  })
})
