/**
 * Partition folders whose session this run loaded. Windows keeps a loaded session's files open, so
 * deleting the folder then fails half-way (EBUSY); it is deleted on the next start instead, before
 * any session loads. The session's data is already cleared through Chromium when it is queued.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PENDING_DELETES_FILE_NAME = 'browser-route-partition-pending-deletes.json'

export function browserRoutePartitionPendingDeletesPath(partitionDataRoot: string): string {
  return join(dirname(partitionDataRoot), PENDING_DELETES_FILE_NAME)
}

function readPending(filePath: string): string[] {
  if (!existsSync(filePath)) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : []
  } catch {
    // A corrupt list only costs a folder that stays until a later removal queues it again.
    return []
  }
}

function writePending(filePath: string, directories: readonly string[]): void {
  const temp = `${filePath}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify([...new Set(directories)])}\n`)
  renameSync(temp, filePath)
}

export function queueBrowserRoutePartitionDirectoryDelete(
  filePath: string,
  directory: string
): void {
  writePending(filePath, [...readPending(filePath), directory])
}

/** Startup, before sessions load. A folder bound again since it was queued is kept: it is in use. */
export async function deletePendingBrowserRoutePartitionDirectories(input: {
  filePath: string
  isBound: (directory: string) => boolean
  removeDirectory: (directory: string) => Promise<void>
}): Promise<unknown[]> {
  const pending = readPending(input.filePath)
  if (pending.length === 0) {
    return []
  }
  const failures: unknown[] = []
  const kept: string[] = []
  for (const directory of pending) {
    if (input.isBound(directory)) {
      continue
    }
    try {
      await input.removeDirectory(directory)
    } catch (error) {
      failures.push(error)
      kept.push(directory)
    }
  }
  writePending(input.filePath, kept)
  return failures
}
