import { chmod, lstat, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { TrackedSourceEntry } from './worktree-source-identity'

export async function setWorktreeSourcePermissions(
  root: string,
  entries: readonly TrackedSourceEntry[],
  writable: boolean,
  signal?: AbortSignal
): Promise<void> {
  const expected = new Map(entries.map((entry) => [entry.path, entry.mode]))
  const directories = [root]
  while (directories.length) {
    signal?.throwIfAborted()
    const directory = directories.pop()
    if (!directory) {
      break
    }
    const directoryMode = (await lstat(directory)).mode & 0o777
    await chmod(directory, directoryMode | 0o700)
    const children = await readdir(directory, { withFileTypes: true })
    // Bound filesystem work without creating a promise for every tracked file.
    for (let offset = 0; offset < children.length; offset += 32) {
      signal?.throwIfAborted()
      const settled = await Promise.allSettled(
        children.slice(offset, offset + 32).map(async (entry) => {
          const path = join(directory, entry.name)
          if (entry.isDirectory()) {
            directories.push(path)
            return
          }
          const trackedPath = relative(root, path).split(sep).join('/')
          const mode = expected.get(trackedPath)
          if (!mode || entry.isSymbolicLink() !== (mode === '120000')) {
            throw new Error('Shared source contains an unexpected path')
          }
          expected.delete(trackedPath)
          if (!entry.isSymbolicLink()) {
            const fileMode = (await lstat(path)).mode & 0o777
            await chmod(path, writable ? fileMode | 0o200 : fileMode & ~0o222)
          }
        })
      )
      for (const result of settled) {
        if (result.status === 'rejected') {
          throw result.reason
        }
      }
    }
  }
  if (expected.size) {
    throw new Error('Shared source is missing tracked files')
  }
}
