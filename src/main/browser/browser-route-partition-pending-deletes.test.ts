import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  browserRoutePartitionPendingDeletesPath,
  deletePendingBrowserRoutePartitionDirectories,
  queueBrowserRoutePartitionDirectoryDelete
} from './browser-route-partition-pending-deletes'

let root: string
let partitions: string
let listPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-partition-deletes-'))
  partitions = join(root, 'Partitions')
  listPath = browserRoutePartitionPendingDeletesPath(partitions)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function folder(name: string): string {
  const path = join(partitions, name)
  mkdirSync(path, { recursive: true })
  return path
}

const removeDirectory = (directory: string) => rm(directory, { recursive: true, force: true })

it('keeps the list outside the folder Chromium owns, and queues each folder once', () => {
  const a = folder('a')
  queueBrowserRoutePartitionDirectoryDelete(listPath, a)
  queueBrowserRoutePartitionDirectoryDelete(listPath, a)
  expect(listPath.startsWith(partitions)).toBe(false)
  expect(JSON.parse(readFileSync(listPath, 'utf8'))).toEqual([a])
  expect(existsSync(a)).toBe(true)
})

it('deletes queued folders on the next start and forgets them', async () => {
  const a = folder('a')
  queueBrowserRoutePartitionDirectoryDelete(listPath, a)
  expect(
    await deletePendingBrowserRoutePartitionDirectories({
      filePath: listPath,
      isBound: () => false,
      removeDirectory
    })
  ).toEqual([])
  expect(existsSync(a)).toBe(false)
  expect(JSON.parse(readFileSync(listPath, 'utf8'))).toEqual([])
})

it('keeps a folder bound again since it was queued, and retries one that failed', async () => {
  const rebound = folder('rebound')
  const busy = folder('busy')
  queueBrowserRoutePartitionDirectoryDelete(listPath, rebound)
  queueBrowserRoutePartitionDirectoryDelete(listPath, busy)
  const failures = await deletePendingBrowserRoutePartitionDirectories({
    filePath: listPath,
    isBound: (directory) => directory === rebound,
    removeDirectory: async (directory) => {
      if (directory === busy) {
        throw new Error('EBUSY')
      }
      await removeDirectory(directory)
    }
  })
  expect(failures).toHaveLength(1)
  expect(existsSync(rebound)).toBe(true)
  expect(JSON.parse(readFileSync(listPath, 'utf8'))).toEqual([busy])
})

it('does nothing with no list', async () => {
  expect(
    await deletePendingBrowserRoutePartitionDirectories({
      filePath: listPath,
      isBound: () => false,
      removeDirectory
    })
  ).toEqual([])
  expect(existsSync(listPath)).toBe(false)
})
